"""Data acquisition for Hakusan Monitor — deliberately light on the login node.

Instead of `--json` (which makes the controller serialize ~17 MB for squeue and
pushes it all through the login node's sshd), we ask Slurm for compact
**format-string** output (~45 KB) and parse it here. One SSH call fetches both
nodes and queue, and SSH ControlMaster keeps a single connection warm so repeat
samples cost ~no handshake.

Output is shaped like the Slurm `--json` payloads (`{"nodes":[...]}`,
`{"jobs":[...]}`) so `normalize.py` can stay I/O-free. Mock mode reads JSON
fixtures.
"""
from __future__ import annotations
import math, os, re, json, time, shlex, subprocess
from datetime import datetime

try:
    from zoneinfo import ZoneInfo
    CLUSTER_TZ = ZoneInfo(os.environ.get("HM_CLUSTER_TZ", "Asia/Tokyo"))
except Exception:          # unknown TZ name / missing tzdata -> host localtime
    CLUSTER_TZ = None

try:                       # flat import when run as `python3 backend/server.py`
    from cluster_policy import BUILTIN_PARTITION_CAPS, BUILTIN_PARTITION_POLICIES
except ImportError:        # package import in tests (`from backend.sources import …`)
    from backend.cluster_policy import BUILTIN_PARTITION_CAPS, BUILTIN_PARTITION_POLICIES

MARK = "@@HM@@"
SEP = "|@|"   # field separator unlikely to occur in any value (e.g. job names)
# order matters — see parse_queue()
SQUEUE_FIELDS = ["%i", "%u", "%a", "%P", "%T", "%r", "%D", "%C", "%b", "%V",
                 "%e", "%S", "%L", "%j", "%q", "%N", "%M", "%l", "%m"]
SQUEUE_FMT = SEP.join(SQUEUE_FIELDS)
CONTAINER_FMT = "JobID:64,tres-alloc:256,Container:512"
CPU_TEST_PARTITIONS = ["TINY", "DEF", "SINGLE", "SMALL", "LARGE", "XLARGE", "X2LARGE", "LONG", "LONG-L"]


def _kv(line, key):
    m = re.search(r"(?:^| )" + key + r"=(\S+)", line)
    return m.group(1) if m else ""


def _int(s):
    try:
        return int(s)
    except (TypeError, ValueError):
        return 0


def parse_nodes(text):
    """`scontrol -o show nodes` (one line/node) -> [{...}] like scontrol --json,
    enriched with every field the raw Nodes table surfaces."""
    nodes, version = [], ""
    for line in text.splitlines():
        if not line.startswith("NodeName="):
            continue
        version = version or _kv(line, "Version")
        gres = _kv(line, "Gres")
        gres = "" if gres in ("(null)", "") else gres
        alloc_tres = _kv(line, "AllocTRES")
        used = ",".join(f"gpu:{m[0]}:{m[1]}" for m in
                        re.findall(r"gres/gpu:([A-Za-z0-9_\-]+)=(\d+)", alloc_tres))
        reason = re.search(r"Reason=(.+?)(?:\s+\w+=|$)", line)
        parts = _kv(line, "Partitions")
        feats = _kv(line, "ActiveFeatures")
        nodes.append({
            "name": _kv(line, "NodeName"),
            "state": _kv(line, "State").split("+"),
            "partitions": parts.split(",") if parts else [],
            "cpus": _int(_kv(line, "CPUTot")),
            "alloc_cpus": _int(_kv(line, "CPUAlloc")),
            "cpu_load": _kv(line, "CPULoad"),
            "real_memory": _int(_kv(line, "RealMemory")),
            "alloc_memory": _int(_kv(line, "AllocMem")),
            "free_mem": _int(_kv(line, "FreeMem")),
            "gres": gres,
            "gres_used": used,
            "features": "" if feats in ("(null)", "") else feats,
            "alloc_tres": alloc_tres,
            "cfg_tres": _kv(line, "CfgTRES"),
            "boot_time": _kv(line, "BootTime"),
            "reason": reason.group(1) if reason else "",
        })
    return {"nodes": nodes, "meta": {"slurm": {"release": version}}}


def _epoch(iso):
    """squeue %V is cluster-local time, e.g. 2026-06-27T10:29:04.

    Interpret it in the cluster's zone (HM_CLUSTER_TZ, default Asia/Tokyo), not
    the monitoring host's — otherwise every submit time and probe verdict is
    shifted when this server runs outside JST.
    """
    try:
        dt = datetime.strptime(iso, "%Y-%m-%dT%H:%M:%S")
        if CLUSTER_TZ is not None:
            return int(dt.replace(tzinfo=CLUSTER_TZ).timestamp())
        return int(time.mktime(dt.timetuple()))
    except Exception:
        return 0


def _clean(s):
    """Slurm prints 'N/A' / 'INVALID' / 'Unknown' for unset times."""
    return "" if s in ("N/A", "INVALID", "Unknown", "") else s


def _mem_mb(s):
    """Slurm memory strings (`260000M`, `1500G`, `3.6T`) -> MB."""
    if not s or s in ("N/A", "(null)", "None", "NULL"):
        return 0
    m = re.match(r"^(\d+(?:\.\d+)?)([KMGTP]?)", str(s).strip(), re.I)
    if not m:
        return 0
    n = float(m.group(1))
    unit = m.group(2).upper()
    mult = {"": 1, "K": 1 / 1024, "M": 1, "G": 1024, "T": 1024 * 1024, "P": 1024 * 1024 * 1024}
    return int(n * mult.get(unit, 1))


def _mem_gb(s):
    mb = _mem_mb(s)
    return int(math.ceil(mb / 1024)) if mb else 0


def _wall_compact(s):
    if not s or s in ("N/A", "(null)", "None", "NULL", "UNLIMITED"):
        return ""
    days = 0
    rest = s
    if "-" in s:
        d, rest = s.split("-", 1)
        days = _int(d)
    parts = rest.split(":")
    if len(parts) != 3:
        return ""
    hours, minutes, seconds = (_int(x) for x in parts)
    total_minutes = days * 1440 + hours * 60 + minutes + (1 if seconds else 0)
    if total_minutes <= 0:
        return ""
    if total_minutes % 1440 == 0:
        return f"{total_minutes // 1440}d"
    if total_minutes % 60 == 0:
        return f"{total_minutes // 60}h"
    return f"{total_minutes}m"


def _parse_tres(text):
    out = {}
    gpu_vals = []
    for item in (text or "").split(","):
        if "=" not in item:
            continue
        key, val = item.split("=", 1)
        key, val = key.strip(), val.strip()
        if key == "cpu":
            out["cores"] = _int(val)
        elif key == "mem":
            out["mem_gb"] = _mem_gb(val)
            out["mem_mb"] = _mem_mb(val)
        elif key == "node":
            out["nodes"] = _int(val)
        elif key.startswith("gres/gpu"):
            gpu_vals.append(_int(val))
    if gpu_vals:
        # Slurm may show both generic and typed GPU TRES. Treat that as the same
        # limit rather than adding them together.
        out["gpus"] = max(gpu_vals)
    return {k: v for k, v in out.items() if v}


def parse_qos_policies(text):
    qos = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        p = (line.split("|") + [""] * 8)[:8]
        name, max_tres, max_wall, grp_jobs, max_jobs_pu, max_submit_pu, min_tres, flags = p
        if not name:
            continue
        tres = _parse_tres(max_tres)
        min_vals = _parse_tres(min_tres)
        cap = {}
        if tres.get("cores"):
            cap["maxCores"] = tres["cores"]
        if min_vals.get("cores"):
            cap["minCores"] = min_vals["cores"]
        if tres.get("mem_gb"):
            cap["maxMemGb"] = tres["mem_gb"]
        if tres.get("gpus"):
            cap["maxGpus"] = tres["gpus"]
        if tres.get("nodes"):
            cap["maxNodes"] = tres["nodes"]
        wall = _wall_compact(max_wall)
        if wall:
            cap["wall"] = wall
        policy = {}
        if _int(grp_jobs):
            policy["grpJobs"] = _int(grp_jobs)
        if _int(max_jobs_pu):
            policy["maxJobsPerUser"] = _int(max_jobs_pu)
        if _int(max_submit_pu):
            policy["maxSubmitPerUser"] = _int(max_submit_pu)
        qos[name] = {
            "name": name,
            "max_tres": max_tres,
            "min_tres": min_tres,
            "max_wall": max_wall,
            "flags": flags,
            "cap": cap,
            "policy": policy,
        }
    return qos


def parse_partition_policies(text):
    parts = {}
    for line in text.splitlines():
        if not line.startswith("PartitionName="):
            continue
        name = _kv(line, "PartitionName")
        if not name:
            continue
        allow_qos = _kv(line, "AllowQos")
        parts[name] = {
            "name": name,
            "qos": _kv(line, "QoS"),
            "allow_qos": [] if allow_qos in ("", "(null)") else allow_qos.split(","),
            "nodes": _kv(line, "Nodes"),
            "state": _kv(line, "State"),
            "default": _kv(line, "Default") == "YES",
        }
    return parts


def build_policy_snapshot(qos_text, partition_text, now, interval):
    """Merge the live sacctmgr/scontrol policy over the built-in tables.

    The snapshot always carries a complete caps/policies map (builtins fill any
    gap), so the frontend never needs its own copy of cluster policy. Each
    partition is tagged live/builtin so staleness is at least observable.
    """
    qos = parse_qos_policies(qos_text)
    partitions = parse_partition_policies(partition_text)
    live_caps = {}
    live_policies = {}
    for name, part in partitions.items():
        q = qos.get(part.get("qos", ""))
        if not q:
            continue
        if q.get("cap"):
            live_caps[name] = q["cap"]
        if q.get("policy"):
            live_policies[name] = q["policy"]
    caps = {}
    origins = {}
    for name in set(BUILTIN_PARTITION_CAPS) | set(live_caps):
        caps[name] = {**BUILTIN_PARTITION_CAPS.get(name, {}), **live_caps.get(name, {})}
        origins[name] = "live" if name in live_caps else "builtin"
    policies = {}
    for name in set(BUILTIN_PARTITION_POLICIES) | set(live_policies):
        policies[name] = {**BUILTIN_PARTITION_POLICIES.get(name, {}), **live_policies.get(name, {})}
    return {
        "generated_at": int(now),
        "interval": int(interval),
        "qos": qos,
        "partitions": partitions,
        "partition_caps": caps,
        "partition_policies": policies,
        "cap_origin": origins,
    }


def parse_containers(text):
    """`squeue -O JobID,tres-alloc,Container` -> {job_id: {tres, container}}.

    The `-O/--Format` surface exposes fields the `-o` single-letter formats
    cannot express. tres-alloc carries each job's *effective* allocation
    (memory total, GPU count) for running AND pending jobs — %m is ambiguous
    (per-CPU requests print with no suffix) and %b misses --gpus-style jobs.
    Columns are fixed-width per CONTAINER_FMT, so slice, don't split.
    """
    out = {}
    for line in text.splitlines():
        jid = line[:64].strip()
        if not jid:
            continue
        tres = line[64:320].strip()
        container = line[320:].strip()
        out[jid] = {
            "tres": "" if tres in ("N/A", "(null)", "None", "NULL") else tres,
            "container": "" if container in ("N/A", "(null)", "None", "NULL") else container,
        }
    return out


def parse_queue(text, extras=None):
    """`squeue -h -a -o SQUEUE_FMT` -> [{...}] like squeue --json, enriched with
    every field the raw Jobs table surfaces (see SQUEUE_FIELDS for order).

    `extras` is parse_containers' output: per-job tres-alloc + container."""
    extras = extras or {}
    jobs = []
    for line in text.splitlines():
        p = line.split(SEP)
        if len(p) < len(SQUEUE_FIELDS):
            continue
        (jid, user, acct, part, state, reason, nnodes, cpus, gres, submit,
         end, start_est, left, name, qos, nodelist, used, timelimit, min_mem) = p[:19]
        extra = extras.get(str(jid)) or {}
        alloc = _parse_tres(extra.get("tres", ""))
        gm = re.search(r"gpu:(?:[A-Za-z0-9_\-]+:)?(\d+)", gres or "")
        nnodes_i = int(nnodes) if nnodes.isdigit() else 0
        # GPUs: tres-alloc is authoritative (covers --gpus/--gpus-per-task jobs
        # that %b reports as N/A). Fallback: %b is GRES *per node*, so the job's
        # total = per-node × node count.
        gpu = alloc.get("gpus") or (int(gm.group(1)) if gm else 0) * (nnodes_i or 1)
        # Memory: %m prints per-CPU requests with no suffix (MinMemoryCPU=6000M
        # shows as plain "6000M"), so it can be wrong by a factor of NumCPUs.
        # tres-alloc's mem= is the job's real (or planned) total.
        mem_mb = alloc.get("mem_mb") or _mem_mb(min_mem)
        jobs.append({
            "job_id": int(jid) if jid.isdigit() else jid,
            "user_name": user, "account": acct, "partition": part,
            "job_state": state, "state_reason": reason,
            "node_count": nnodes_i,
            "cpus": int(cpus) if cpus.isdigit() else 0,
            "gpus": gpu,
            "tres_req_str": f"gres/gpu={gpu}" if gpu else "",
            "container": extra.get("container", ""), "submit_time": _epoch(submit),
            "end_time": _clean(end), "start_est": _clean(start_est),
            "time_left": _clean(left),
            "name": name, "qos": qos, "nodelist": _clean(nodelist),
            "time_used": _clean(used), "time_limit": _clean(timelimit),
            "min_memory": _clean(min_mem), "min_memory_mb": mem_mb,
        })
    return {"jobs": jobs}


def parse_cpu_submit_probes(text):
    """`sbatch --test-only` rows for CPU partitions.

    This does not submit jobs. It asks Slurm for the predicted placement/start
    time of the partition's default request, which is more accurate than
    inferring queueability from idle node counts alone.
    """
    probes = []
    start_re = re.compile(
        r"to start at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}).*?"
        r"using (\d+) processors on nodes (.*?) in partition (\S+)"
    )
    for line in text.splitlines():
        p = line.split(SEP, 2)
        if len(p) < 3:
            continue
        partition, rc_s, raw = p
        raw = raw.strip()
        m = start_re.search(raw)
        if m:
            start, procs, nodes, part = m.groups()
            probes.append({
                "partition": part or partition,
                "ok": True,
                "start_time": start,
                "start_epoch": _epoch(start),
                "processors": _int(procs),
                "nodes": nodes,
                "raw": raw,
            })
        else:
            probes.append({
                "partition": partition,
                "ok": False,
                "start_time": "",
                "start_epoch": 0,
                "processors": 0,
                "nodes": "",
                "raw": raw,
                "rc": _int(rc_s),
            })
    return probes


class Source:
    def __init__(self, mode="mock", ssh_host="", ssh_opts="",
                 mock_dir="mock", timeout=25, cpu_probe_interval=900,
                 policy_interval=86400):
        self.mode = mode
        self.ssh_host = ssh_host
        # HM_SSH_HOST accepts a comma-separated preference list
        # ("user@hakusan2,user@hakusan1") — every cycle tries them in order, so
        # the primary is restored automatically the moment it answers again.
        self.ssh_hosts = [h.strip() for h in str(ssh_host).split(",") if h.strip()]
        self._host_bad = set()   # hosts whose previous attempt failed
        self.ssh_opts = ssh_opts
        self.mock_dir = mock_dir
        self.timeout = timeout
        self.cpu_probe_interval = cpu_probe_interval
        self.policy_interval = policy_interval
        self.singularity = None
        self.cpu_probes = []
        self.cpu_probe_at = 0
        # start from the built-in tables so every snapshot carries a complete
        # policy; the first live sacctmgr round overlays it (policy_at=0 keeps
        # the collection due immediately)
        self.policy_snapshot = build_policy_snapshot("", "", time.time(), policy_interval)
        self.policy_at = 0

    def _exec(self, script, timeout=None):
        """Run a shell snippet on the cluster (ssh) or locally."""
        if self.mode != "ssh":
            p = subprocess.run(["bash", "-lc", script], capture_output=True, text=True,
                               timeout=timeout or self.timeout)
            if p.returncode != 0:
                raise RuntimeError(f"collect failed rc={p.returncode}: {p.stderr.strip()[:300]}")
            return p.stdout
        errors = []
        for host in self.ssh_hosts:
            # A host that just failed gets a short probe budget instead of the full
            # timeout: a wedged login node then costs ~20s per cycle (not 90s that
            # starves the whole sample), while one success restores the full budget.
            budget = 20 if host in self._host_bad else (timeout or self.timeout)
            cmd = ["ssh", *shlex.split(self.ssh_opts), host, script]
            try:
                p = subprocess.run(cmd, capture_output=True, text=True, timeout=budget)
                if p.returncode == 0:
                    self._host_bad.discard(host)
                    return p.stdout
                errors.append(f"{host}: rc={p.returncode} {p.stderr.strip()[:200]}")
            except subprocess.TimeoutExpired:
                errors.append(f"{host}: timed out after {budget}s")
            self._host_bad.add(host)
            # A killed/hung client can leave a detached ControlMaster behind whose
            # wedged connection would poison every later sample — tear it down so
            # the next attempt (fallback host now, primary next cycle) starts clean.
            self._drop_control_master(host)
        raise RuntimeError("collect failed on all hosts — " + " | ".join(errors))

    def _drop_control_master(self, host):
        try:
            subprocess.run(["ssh", *shlex.split(self.ssh_opts), "-O", "exit", host],
                           capture_output=True, text=True, timeout=5)
        except Exception:
            pass

    def _mock(self, name):
        with open(os.path.join(self.mock_dir, name)) as f:
            return json.load(f)

    def fetch(self):
        """Return (nodes_json, squeue_json).

        The hot path stays to node + queue reads. CPU start probes and static
        policy/accounting data are cached on longer TTLs because they are more
        expensive than scontrol/squeue snapshots.
        """
        if self.mode == "mock":
            return self._mock("nodes.json"), self._mock("squeue.json")
        now = time.time()
        probe_due = not self.cpu_probes or now - self.cpu_probe_at >= self.cpu_probe_interval
        policy_due = self.policy_snapshot is None or now - self.policy_at >= self.policy_interval
        singularity_cmd = ("singularity --version 2>/dev/null || true"
                           if self.singularity is None else "true")
        sep_q = shlex.quote(SEP)
        cpu_parts = " ".join(shlex.quote(p) for p in CPU_TEST_PARTITIONS)
        cpu_probe_cmd = ((
            f"SEP={sep_q}; for p in {cpu_parts}; do "
            "out=$(timeout 4s sbatch --test-only -p \"$p\" --wrap=hostname 2>&1); rc=$?; "
            "printf '%s%s%s%s%s\\n' \"$p\" \"$SEP\" \"$rc\" \"$SEP\" \"$out\"; "
            "done"
        ) if probe_due else "true")
        qos_cmd = (
            "timeout 8s sacctmgr -n -P show qos "
            "format=Name,MaxTRES%200,MaxWall,GrpJobs,MaxJobsPU,MaxSubmitPU,MinTRES%200,Flags%100 "
            "2>/dev/null || true"
        ) if policy_due else "true"
        partition_cmd = (
            "timeout 8s scontrol -o show partition 2>/dev/null || true"
        ) if policy_due else "true"
        out = self._exec(f"scontrol -o show nodes; echo {MARK}; "
                         f"squeue -h -a -o '{SQUEUE_FMT}'; echo {MARK}; "
                         f"(squeue -h -a -O '{CONTAINER_FMT}' 2>/dev/null || true); echo {MARK}; "
                         f"{singularity_cmd}; echo {MARK}; "
                         f"{cpu_probe_cmd}; echo {MARK}; "
                         f"{qos_cmd}; echo {MARK}; "
                         f"{partition_cmd}")
        sections = (out.split(MARK) + ["", "", "", "", "", ""])[:7]
        nodes_txt, queue_txt, containers_txt, sing_txt, cpu_probe_txt, qos_txt, partition_txt = sections
        if self.singularity is None and "version" in sing_txt:
            self.singularity = sing_txt.split("version", 1)[-1].strip()
        if probe_due:
            self.cpu_probes = parse_cpu_submit_probes(cpu_probe_txt)
            self.cpu_probe_at = now
        if policy_due and (qos_txt.strip() or partition_txt.strip()):
            self.policy_snapshot = build_policy_snapshot(qos_txt, partition_txt, now, self.policy_interval)
            self.policy_at = now
        queue = parse_queue(queue_txt, parse_containers(containers_txt))
        queue["cpu_submit_probes"] = self.cpu_probes
        queue["cpu_submit_probes_generated_at"] = int(self.cpu_probe_at) if self.cpu_probe_at else 0
        return parse_nodes(nodes_txt), queue

    @staticmethod
    def slurm_version(nodes_json):
        return ((nodes_json.get("meta") or {}).get("slurm") or {}).get("release", "")
