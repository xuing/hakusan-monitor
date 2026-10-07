#!/usr/bin/env python3
"""Evidence for the two GPU rules the dashboard has not yet checked against
real jobs (CPU has: docs/DESIGN.md section 4):

1. gap: a GPU node booked for a queued job (squeue SchedNodes) may take a new
   job only if it ends before the booking (lib/queue.ts nodeOpenUntil, the
   rule CPU and GPU requests follow). Two
   real jobs pinned to such a node with -w: one ending after the booking
   (expected to stay pending), then one ending 15 min before it (expected to
   start). Each runs `sleep`, is cancelled after the check, and the script
   waits until `squeue -u $USER` is empty.
2. placement: whether enough GPUs are free now for
   scripts/capture_placement_fixture.py to record GPU placements that start
   now (its last GPU answers were all future starts, which say nothing about
   node selection now).

Without --run it only reads the cluster and prints the plan; --run submits.

Usage: python3 scripts/verify_gpu_gap.py [--run] [--node NAME] [--partition P] [user@host]
"""
import argparse, os, re, shlex, subprocess, sys

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.join(ROOT, "backend"))
from sources import parse_nodes  # noqa: E402

MARK = "@@HM@@"
MARGIN = 600          # lib/queue.ts BACKFILL_MARGIN_MS
SHORT_BEFORE = 900    # the short job ends this long before the margin
LONG_AFTER = 7200     # the long job ends this long after the booking
MIN_WINDOW = 3600     # smaller gaps leave too little room for the short job
BLOCKED = re.compile(r"^(DOWN|DRAIN|DRAINING|FAIL|FAILING|NOT_RESPONDING|MAINT|MAINTENANCE|POWERED_DOWN|"
                     r"POWERING_DOWN|REBOOT_ISSUED|RESERVED)$")


def host(arg):
    if arg:
        return arg
    for line in open(os.path.join(ROOT, ".env")):
        if line.startswith("HM_SSH_HOST="):
            return line.split("=", 1)[1].strip().split(",")[0]
    sys.exit("no host: pass user@host or set HM_SSH_HOST in .env")


def ssh(target, cmd, timeout=600):
    key = os.path.expanduser("~/.ssh/hakusan_monitor")
    opts = ["-i", key, "-o", "IdentitiesOnly=yes"] if os.path.exists(key) else []
    return subprocess.run(["ssh", *opts, "-o", "BatchMode=yes", target, cmd],
                          capture_output=True, text=True, timeout=timeout).stdout


def expand(hostlist):
    """Slurm hostlist -> names: "a[01-03,07],b" -> a01 a02 a03 a07 b."""
    names = []
    for m in re.finditer(r"([^,\[]+)(?:\[([^\]]+)\])?", hostlist or ""):
        prefix, ranges = m.group(1), m.group(2)
        if not ranges:
            names.append(prefix)
            continue
        for part in ranges.split(","):
            lo, _, hi = part.partition("-")
            for i in range(int(lo), int(hi or lo) + 1):
                names.append(f"{prefix}{i:0{len(lo)}d}")
    return names


def gpus(gres):
    return sum(int(n) for n in re.findall(r"gpu:[^:,(]+:(\d+)", gres or ""))


def hms(sec):
    sec = max(60, int(sec) // 60 * 60)
    return f"{sec // 86400}-{sec % 86400 // 3600:02d}:{sec % 3600 // 60:02d}:00"


def read_cluster(target):
    out = ssh(target, f"scontrol -o show nodes; echo {MARK}; "
                      f"SLURM_TIME_FORMAT=%s squeue -h -t PD -O 'JobID:14,Priority:14,StartTime:14,SchedNodes:400'; "
                      f"echo {MARK}; date +%s", timeout=120)
    nodes_txt, queue_txt, now_txt = (out.split(MARK) + [""] * 3)[:3]
    nodes = parse_nodes(nodes_txt)["nodes"]
    now = int(now_txt.strip() or 0)
    bookings = {}
    for line in queue_txt.splitlines():
        cols = line.split()
        if len(cols) < 4 or not cols[2].isdigit() or cols[3] in ("(null)", "N/A"):
            continue
        for name in expand(cols[3]):
            bookings.setdefault(name, []).append((int(cols[2]), cols[0], cols[1]))
    return nodes, bookings, now


def free_gpu_nodes(nodes):
    return [n for n in nodes if gpus(n["gres"]) - gpus(n["gres_used"]) > 0
            and not any(BLOCKED.match(s) for s in n["state"])]


def plan_gap(nodes, bookings, now, args):
    rows = []
    for n in free_gpu_nodes(nodes):
        if args.node and n["name"] != args.node:
            continue
        future = sorted(b for b in bookings.get(n["name"], []) if b[0] > now)
        if not future:
            continue
        at, job, prio = future[0]
        window = at - now - MARGIN
        parts = [p for p in n["partitions"] if p.startswith("GPU") and (not args.partition or p == args.partition)]
        if window >= MIN_WINDOW and parts:
            rows.append({"node": n["name"], "partition": parts[0], "booked_at": at, "job": job, "priority": prio,
                         "window": window, "free_gpu": gpus(n["gres"]) - gpus(n["gres_used"]),
                         "free_cores": n["cpus"] - n["alloc_cpus"], "state": "+".join(n["state"])})
    return max(rows, key=lambda r: r["window"]) if rows else None


def run_gap(target, p):
    """Long first: if the short one ran first it would take the GPU, and the
    long one would then wait for that GPU instead of for the booking."""
    long_t, short_t = hms(p["window"] + MARGIN + LONG_AFTER), hms(p["window"] - SHORT_BEFORE)
    sub = f"sbatch --parsable -p {shlex.quote(p['partition'])} -w {shlex.quote(p['node'])} -o /dev/null -J hm-gap-probe"
    script = f"""
probe() {{
  j=$({sub} -t $1 --wrap 'sleep 600'); echo "submitted $2 job $j with -t $1"
  for i in $(seq 1 18); do sleep 5; s=$(squeue -h -j $j -o '%T'); [ "$s" = RUNNING ] && break; done
  squeue -h -j $j -o "  $2: %T reason=%r priority=%Q start=%S nodes=%N"
  scancel $j
}}
trap 'scancel -u $USER -n hm-gap-probe' EXIT
probe {long_t} long
probe {short_t} short
for i in $(seq 1 36); do n=$(squeue -h -u $USER -n hm-gap-probe | wc -l); [ "$n" = 0 ] && break; sleep 5; done
echo "left in queue: $n"
"""
    return ssh(target, script, timeout=600)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", action="store_true", help="submit the two gap jobs (default: plan only)")
    ap.add_argument("--node", help="only consider this node")
    ap.add_argument("--partition", help="submit to this GPU partition")
    ap.add_argument("host", nargs="?")
    args = ap.parse_args()
    target = host(args.host)
    nodes, bookings, now = read_cluster(target)
    if not now:
        sys.exit("no answer from the cluster")

    free = free_gpu_nodes(nodes)
    print(f"placement: {len(free)} nodes with a free GPU now: "
          + (", ".join(f"{n['name']}({gpus(n['gres']) - gpus(n['gres_used'])})" for n in free) or "none"))
    unbooked = [n for n in free if not any(b[0] > now for b in bookings.get(n["name"], []))]
    print("  -> " + ("run scripts/capture_placement_fixture.py now: GPU probes can start now on "
                     f"{len(unbooked)} unbooked nodes" if len(unbooked) >= 2
                     else "not yet: capture needs at least two unbooked nodes with a free GPU"))

    p = plan_gap(nodes, bookings, now, args)
    if not p:
        print(f"gap: no GPU node with a free GPU and a booking at least {MIN_WINDOW // 60} min (+{MARGIN // 60} min margin) out")
        return
    print(f"gap: {p['node']} ({p['state']}, {p['free_gpu']} GPU / {p['free_cores']} cores free) in {p['partition']}, "
          f"booked for job {p['job']} (priority {p['priority']}) in {p['window'] // 60 + MARGIN // 60} min")
    print(f"  expect: -t {hms(p['window'] + MARGIN + LONG_AFTER)} pending, -t {hms(p['window'] - SHORT_BEFORE)} running")
    if not args.run:
        print("  (plan only; add --run to submit, both jobs are cancelled after the check)")
        return
    print(run_gap(target, p))


if __name__ == "__main__":
    main()
