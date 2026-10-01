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
import hashlib, math, os, re, json, time, shlex, subprocess
from datetime import datetime

try:
    from zoneinfo import ZoneInfo
    CLUSTER_TZ = ZoneInfo(os.environ.get("HM_CLUSTER_TZ", "Asia/Tokyo"))
except Exception:          # unknown TZ name / missing tzdata -> host localtime
    CLUSTER_TZ = None

try:                       # flat import when run as `python3 backend/server.py`
    from lua_policy import parse_job_submit_lua
except ImportError:        # package import in tests (`from backend.sources import …`)
    from backend.lua_policy import parse_job_submit_lua

MARK = "@@HM@@"
LUA_MARK = "@@HM-LUA@@"
SEP = "|@|"   # field separator unlikely to occur in any value (e.g. job names)
# order matters — see parse_queue()
SQUEUE_FIELDS = ["%i", "%u", "%a", "%P", "%T", "%r", "%D", "%C", "%b", "%V",
                 "%e", "%S", "%L", "%j", "%q", "%N", "%M", "%l", "%m", "%n", "%x"]
SQUEUE_FMT = SEP.join(SQUEUE_FIELDS)
# JobArrayID, not JobID: -O JobID prints an array's BASE id ("759320") for
# every task, so no task ever joined its row; JobArrayID matches %i exactly.
CONTAINER_FMT = "JobArrayID:64,tres-alloc:256,SchedNodes:128,Container:512"
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
    """Normalize Slurm's unset sentinels across times and optional fields."""
    return "" if s in ("N/A", "INVALID", "Unknown", "(null)", "None", "NULL", "") else s


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
    generic_gpus = None
    gpu_vals = []
    gpu_types = []
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
        elif key == "gres/gpu":
            generic_gpus = _int(val)
        elif key.startswith("gres/gpu:"):
            gpu_vals.append(_int(val))
            gpu_types.append(key.split(":", 1)[1])
    # Slurm usually lists the generic total next to the typed ones
    # (gres/gpu=2,gres/gpu:a40=2) — that total wins. Typed-only means one entry
    # per model, so they add up: a40=2,a100=2 is 4 GPUs, not max() = 2.
    if generic_gpus is not None:
        out["gpus"] = generic_gpus
    elif gpu_vals:
        out["gpus"] = sum(gpu_vals)
    if gpu_types:
        out["gpu_type"] = "+".join(dict.fromkeys(gpu_types))
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


def _mem_per_x_mb(line, key):
    """`DefMemPerCPU=9845` -> 9845. UNLIMITED / absent -> 0.

    scontrol prints these plain (already MB), so no unit suffix is expected —
    _mem_mb still tolerates one rather than silently returning 0.
    """
    raw = _kv(line, key)
    if not raw or raw.upper() in ("UNLIMITED", "N/A", "(NULL)"):
        return 0
    return _mem_mb(raw)


def parse_partition_policies(text):
    """`scontrol -o show partition` -> {partition: {...}}.

    Beyond the QoS wiring, this carries the memory *defaults*: Slurm's
    DefMemPerCPU is what a request with no `--mem` actually asks for, which is
    a completely different number from the QoS MaxTRES ceiling. Measured live
    2026-07-29: GPU-1 DefMemPerCPU=9845 (x26 default cores = 255970 MB) while
    its QoS cap says mem=256G, and VM-GPU-L DefMemPerCPU=14900 (x32 = 476800
    MB) against a 480G cap on nodes that physically hold 469070 MB. Treating
    the cap as the default is what made three fully idle H100 nodes report
    "memory insufficient".
    """
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
            "def_mem_per_cpu_mb": _mem_per_x_mb(line, "DefMemPerCPU"),
            "max_mem_per_cpu_mb": _mem_per_x_mb(line, "MaxMemPerCPU"),
            "def_mem_per_node_mb": _mem_per_x_mb(line, "DefMemPerNode"),
            "max_mem_per_node_mb": _mem_per_x_mb(line, "MaxMemPerNode"),
            "total_cpus": _int(_kv(line, "TotalCPUs")),
            "total_nodes": _int(_kv(line, "TotalNodes")),
        }
    return parts


def partition_defaults(partitions, lua, check=None):
    """What a request with no resource flags gets, per partition.

    Two sources, neither hard-coded here:
      * job_submit.lua (lua_policy) — default tasks/CPUs/GPUs, the interactive
        time limit, whether a --gres request survives the plugin;
      * scontrol partition — DefMemPerCPU / MaxMemPerCPU.
    When scripts/check_cluster_policy.py has measured a partition with a held
    job, the measured CPUs/memory win: Slurm, not our reading of the Lua, is
    the ground truth (e.g. the Lua's pn_min_memory default is pre-empted by
    DefMemPerCPU, which the measurement shows and the source does not).
    """
    measured = ((check or {}).get("partitions") or {})
    out = {}
    for name in set(lua) | set(partitions):
        f = lua.get(name) or {}
        live = partitions.get(name) or {}
        d = {}
        if f.get("default_cpus"):
            d["cores"] = f["default_cpus"]
        if f.get("default_tasks"):
            d["tasks"] = f["default_tasks"]
        if f.get("default_gpus_per_node"):
            d["gpus_per_node"] = f["default_gpus_per_node"]
            d["gpu_request_respected"] = bool(f.get("gpu_request_respected"))
        if f.get("interactive_time_min"):
            d["interactive_time_min"] = f["interactive_time_min"]
        if f.get("requires_license"):
            d["requires_license"] = True
        if f.get("default_mem_per_node_mb"):
            d["lua_mem_per_node_mb"] = f["default_mem_per_node_mb"]
        for key in ("def_mem_per_cpu_mb", "max_mem_per_cpu_mb",
                    "def_mem_per_node_mb", "max_mem_per_node_mb"):
            if live.get(key):
                d[key] = live[key]
        m = (measured.get(name) or {}).get("measured") or {}
        if m.get("cpus"):
            d["cores"] = m["cpus"]
            d["measured"] = True
        if m.get("mem_per_cpu_mb"):
            d["def_mem_per_cpu_mb"] = m["mem_per_cpu_mb"]
        if d:
            out[name] = d
    return out


def parse_lua_versions(stat_txt, lua_path):
    """`stat -c '%Y|%s|%n' job_submit.lua job_submit.lua_*` -> newest first.

    The admins keep the previous file as job_submit.lua_YYMMDD when they
    change it; the file's own mtime is when that version was written, so the
    list doubles as a change history (2026-06-11: the --gres check dropped).
    """
    out = []
    for line in stat_txt.splitlines():
        parts = line.split("|", 2)
        if len(parts) != 3 or not parts[0].isdigit():
            continue
        name = os.path.basename(parts[2])
        out.append({"name": name, "mtime": int(parts[0]), "size": _int(parts[1]),
                    "current": parts[2] == lua_path})
    out.sort(key=lambda v: -v["mtime"])
    return out


def build_policy_snapshot(qos_text, partition_text, now, interval, lua_text="", check=None,
                          lua_meta=None):
    """The cluster's partition policy, read only from the cluster.

    Caps and per-user limits come from the partition's QoS (sacctmgr), request
    defaults from job_submit.lua + scontrol (partition_defaults). Nothing is
    filled in from built-in tables any more: a value Slurm doesn't state is
    shown as absent, not guessed — the guesses (e.g. "SMALL: 3 nodes", "GPU-LA:
    8 GPUs") were how wrong limits reached the UI.
    """
    qos = parse_qos_policies(qos_text)
    partitions = parse_partition_policies(partition_text)
    lua = parse_job_submit_lua(lua_text)
    caps, policies, origins = {}, {}, {}
    for name, part in partitions.items():
        q = qos.get(part.get("qos", ""))
        if not q:
            continue
        caps[name] = dict(q.get("cap") or {})
        policies[name] = dict(q.get("policy") or {})
        origins[name] = "live"
    return {
        "generated_at": int(now),
        "interval": int(interval),
        "qos": qos,
        "partitions": partitions,
        "partition_caps": caps,
        "partition_policies": policies,
        "partition_defaults": partition_defaults(partitions, lua, check),
        "cap_origin": origins,
        "lua": {**(lua_meta or {}), "partitions": lua, "parsed": bool(lua)},
        "check": _check_summary(check),
    }


def _check_summary(check):
    """Small, snapshot-sized view of the last verification run."""
    if not check:
        return None
    parts = check.get("partitions") or {}
    boundary = check.get("boundary") or {}
    # boundary problems: a quick-request value the UI offers that Slurm
    # would reject or never start — named "PARTITION:field"
    bad_bounds = sorted({f"{b['partition']}:{b['field']}" for b in boundary.get("problems") or []})
    return {
        "checked_at": check.get("checked_at"),
        "lua_sha": check.get("lua_sha"),
        "ok": all(p.get("ok", True) for p in parts.values()) and not bad_bounds,
        "mismatches": sorted(n for n, p in parts.items() if p.get("ok") is False) + bad_bounds,
        "boundary_checked": boundary.get("checked", 0),
    }


def parse_containers(text):
    """`squeue -r -O JobArrayID,tres-alloc,SchedNodes,Container` -> {job_id: {...}}.

    The `-O/--Format` surface exposes fields the `-o` single-letter formats
    cannot express. tres-alloc carries each job's *effective* allocation
    (memory total, GPU count) for running AND pending jobs — %m is ambiguous
    (per-CPU requests print with no suffix) and %b misses --gpus-style jobs.
    SchedNodes is the backfill scheduler's planned placement for a pending
    job — the node it has reserved and the basis for backfill-window math.
    Columns are fixed-width per CONTAINER_FMT, so slice, don't split.
    """
    out = {}
    for line in text.splitlines():
        jid = line[:64].strip()
        if not jid:
            continue
        tres = line[64:320].strip()
        sched = line[320:448].strip()
        container = line[448:].strip()
        out[jid] = {
            "tres": "" if tres in ("N/A", "(null)", "None", "NULL") else tres,
            "sched_nodes": "" if sched in ("N/A", "(null)", "None", "NULL") else sched,
            "container": "" if container in ("N/A", "(null)", "None", "NULL") else container,
        }
    return out


def parse_pending_reqtres(text):
    """`sacct -aX --state=PENDING -o JobID,ReqTRES -P -n` -> {job_id: tres}.

    ReqTRES holds the job's *requested totals* (mem=260000M for a 26-CPU job
    asking --mem-per-cpu=10000M) — the only place a pending job's real memory
    footprint is visible without a per-job scontrol call."""
    out = {}
    for line in text.splitlines():
        jid, _, tres = line.partition("|")
        jid = jid.strip()
        if jid and tres.strip():
            out[jid] = tres.strip()
    return out


def parse_queue(text, extras=None, pending_reqtres=None):
    """`squeue -h -a -r -o SQUEUE_FMT` -> [{...}] like squeue --json, enriched with
    every field the raw Jobs table surfaces (see SQUEUE_FIELDS for order).

    `extras` is parse_containers' output: per-job tres-alloc + container.
    `pending_reqtres` is parse_pending_reqtres' output: per-job requested totals."""
    extras = extras or {}
    pending_reqtres = pending_reqtres or {}
    jobs = []
    for line in text.splitlines():
        p = line.split(SEP)
        if len(p) < len(SQUEUE_FIELDS):
            continue
        (jid, user, acct, part, state, reason, nnodes, cpus, gres, submit,
         end, start_est, left, name, qos, nodelist, used, timelimit, min_mem,
         req_nodes, exc_nodes) = p[:21]
        extra = extras.get(str(jid)) or {}
        alloc = _parse_tres(extra.get("tres", ""))
        gm = re.search(r"gpu:(?:([A-Za-z0-9_.\-]+):)?(\d+)", gres or "")
        nnodes_i = int(nnodes) if nnodes.isdigit() else 0
        # GPUs: tres-alloc is authoritative (covers --gpus/--gpus-per-task jobs
        # that %b reports as N/A). Fallback: %b is GRES *per node*, so the job's
        # total = per-node × node count.
        gpu = alloc.get("gpus") or (int(gm.group(2)) if gm else 0) * (nnodes_i or 1)
        # GPU model: for running jobs tres-alloc holds the real allocation, but
        # for pending jobs it's a scheduler placeholder (every untyped --gpus
        # request shows the cluster's first GPU type) — only trust an explicitly
        # requested type (%b) there.
        requested_type = (gm.group(1) if gm else "") or ""
        gpu_type = requested_type if state == "PENDING" else (alloc.get("gpu_type") or requested_type)
        # Memory: %m prints per-CPU requests with no suffix (MinMemoryCPU=6000M
        # shows as plain "6000M"), so it can be wrong by a factor of NumCPUs.
        # tres-alloc's mem= is the job's real total for RUNNING jobs, but it's
        # null while pending — there sacct's ReqTRES holds the requested total.
        req = _parse_tres(pending_reqtres.get(str(jid), "")) if state == "PENDING" else {}
        # No total from either source (the enrichment command failed): %m alone
        # is ambiguous — a --mem-per-cpu job prints its PER-CPU value, so a
        # 64-CPU x 6000M job would read 6000 MB instead of 384000. Report
        # unknown (0) rather than a number that can be 64x off.
        mem_mb = req.get("mem_mb") or alloc.get("mem_mb") or 0
        jobs.append({
            "job_id": int(jid) if jid.isdigit() else jid,
            "user_name": user, "account": acct, "partition": part,
            "job_state": state, "state_reason": reason,
            "node_count": nnodes_i,
            "cpus": int(cpus) if cpus.isdigit() else 0,
            "gpus": gpu,
            "gpu_type": gpu_type if gpu else "",
            "tres_req_str": f"gres/gpu={gpu}" if gpu else "",
            "container": extra.get("container", ""), "submit_time": _epoch(submit),
            "end_time": _clean(end), "start_est": _clean(start_est),
            "time_left": _clean(left),
            "name": name, "qos": qos, "nodelist": _clean(nodelist),
            "sched_nodes": extra.get("sched_nodes", "") if state == "PENDING" else "",
            # Hard placement constraints are distinct from SchedNodes, which
            # is only the scheduler's current (and movable) future plan.
            "req_nodes": _clean(req_nodes), "exc_nodes": _clean(exc_nodes),
            "time_used": _clean(used), "time_limit": _clean(timelimit),
            # keep the display string consistent with the corrected total so
            # the UI never shows a per-CPU "10000M" next to a 260000M verdict
            "min_memory": f"{mem_mb}M" if mem_mb else _clean(min_mem),
            "min_memory_mb": mem_mb,
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
                 policy_interval=86400, policy_cache="", policy_check="",
                 lua_path="/app/slurm/job_submit.lua"):
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
        # Policy is read from the cluster once a day (policy_interval) and the
        # last good reading is cached on disk, so a restart shows real limits
        # at once instead of built-in guesses. policy_at=0 keeps a refresh due.
        self.policy_cache = policy_cache
        self.policy_check = policy_check
        self.lua_path = lua_path
        self.policy_sources = {}
        self.policy_snapshot = None
        self.policy_at = 0
        self._load_policy_cache()

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
        check_mtime = self._check_mtime()
        if check_mtime != getattr(self, "_check_seen", None):
            self._check_seen = check_mtime
            self.refresh_check()
        probe_due = not self.cpu_probes or now - self.cpu_probe_at >= self.cpu_probe_interval
        policy_due = self.policy_snapshot is None or now - self.policy_at >= self.policy_interval
        singularity_cmd = ("singularity --version 2>/dev/null || true"
                           if self.singularity is None else "true")
        sep_q = shlex.quote(SEP)
        # The probe's verdict is displayed next to a `salloc -p X` command, and
        # job_submit.lua pins the walltime of interactive jobs per partition
        # (read from the Lua; a partition without that rule honors -t). Probe
        # with that same walltime so "starts now" is a statement about the
        # salloc the user will actually run — walltime decides backfill.
        cpu_probes = "; ".join(
            "out=$(timeout 4s sbatch --test-only -p {p}{t} --wrap=hostname 2>&1); rc=$?; "
            "printf '%s%s%s%s%s\\n' {p} \"$SEP\" \"$rc\" \"$SEP\" \"$out\"".format(
                p=shlex.quote(p), t=self._interactive_t_flag(p))
            for p in CPU_TEST_PARTITIONS)
        cpu_probe_cmd = f"SEP={sep_q}; {cpu_probes}" if probe_due else "true"
        qos_cmd = (
            "timeout 8s sacctmgr -n -P show qos "
            "format=Name,MaxTRES%200,MaxWall,GrpJobs,MaxJobsPU,MaxSubmitPU,MinTRES%200,Flags%100 "
            "2>/dev/null || true"
        ) if policy_due else "true"
        partition_cmd = (
            "timeout 8s scontrol -o show partition 2>/dev/null || true"
        ) if policy_due else "true"
        # job_submit.lua and its admin backups (job_submit.lua_YYMMDD): the
        # rules the submit plugin applies, plus when they last changed.
        lua_q = shlex.quote(self.lua_path)
        lua_cmd = (
            f"(stat -c '%Y|%s|%n' {lua_q} {lua_q}_* 2>/dev/null || true); echo {LUA_MARK}; "
            f"(cat {lua_q} 2>/dev/null || true)"
        ) if policy_due else "true"
        # Core reads must succeed: a later optional command must never turn a
        # controller failure into a healthy-looking empty cluster/queue.
        out = self._exec(f"scontrol -o show nodes || exit $?; echo {MARK}; "
                         # -r: one row per array task. Without it a pending
                         # array prints as ONE row ("759320_[5-10%2]" = 6
                         # tasks) while its running tasks are separate rows,
                         # so pending counts ran ~10 short (audit 2026-10-01).
                         f"squeue -h -a -r -o '{SQUEUE_FMT}' || exit $?; echo {MARK}; "
                         f"(squeue -h -a -r -O '{CONTAINER_FMT}' 2>/dev/null || true); echo {MARK}; "
                         # pending jobs' AllocTRES is null and squeue %m prints
                         # per-CPU requests indistinguishably from totals (a
                         # 26-CPU job asking 10000M/CPU shows "10000M" — 26x
                         # off); sacct's ReqTRES is the only cheap total
                         f"(timeout 8s sacct -aX --state=PENDING -o JobID,ReqTRES -P -n 2>/dev/null || true); echo {MARK}; "
                         f"{singularity_cmd}; echo {MARK}; "
                         f"{cpu_probe_cmd}; echo {MARK}; "
                         f"{qos_cmd}; echo {MARK}; "
                         f"{partition_cmd}; echo {MARK}; "
                         f"{lua_cmd}")
        sections = (out.split(MARK) + [""] * 9)[:9]
        (nodes_txt, queue_txt, containers_txt, reqtres_txt, sing_txt, cpu_probe_txt,
         qos_txt, partition_txt, lua_section) = sections
        if self.singularity is None and "version" in sing_txt:
            self.singularity = sing_txt.split("version", 1)[-1].strip()
        if probe_due:
            self.cpu_probes = parse_cpu_submit_probes(cpu_probe_txt)
            self.cpu_probe_at = now
        if policy_due and (qos_txt.strip() or partition_txt.strip()):
            stat_txt, _, lua_txt = lua_section.partition(LUA_MARK)
            self._set_policy(qos_txt.strip("\n"), partition_txt.strip("\n"),
                             lua_txt.lstrip("\n"), stat_txt.strip(), now)
        queue = parse_queue(queue_txt, parse_containers(containers_txt), parse_pending_reqtres(reqtres_txt))
        queue["cpu_submit_probes"] = self.cpu_probes
        queue["cpu_submit_probes_generated_at"] = int(self.cpu_probe_at) if self.cpu_probe_at else 0
        return parse_nodes(nodes_txt), queue

    def _interactive_t_flag(self, partition):
        d = ((self.policy_snapshot or {}).get("partition_defaults") or {}).get(partition) or {}
        minutes = d.get("interactive_time_min")
        return f" -t {minutes}" if minutes else ""

    def _check_mtime(self):
        try:
            return os.path.getmtime(self.policy_check) if self.policy_check else 0
        except OSError:
            return 0

    # ---- policy sources --------------------------------------------------
    def _set_policy(self, qos_txt, partition_txt, lua_txt, stat_txt, now):
        versions = parse_lua_versions(stat_txt, self.lua_path)
        current = next((v for v in versions if v["current"]), None)
        lua_meta = {
            "path": self.lua_path,
            "sha": hashlib.sha256(lua_txt.encode()).hexdigest()[:12] if lua_txt else "",
            "mtime": current["mtime"] if current else 0,
            "versions": versions,
        }
        self.policy_sources = {"qos": qos_txt, "partitions": partition_txt, "lua": lua_txt,
                               "fetched_at": int(now)}
        self.policy_snapshot = build_policy_snapshot(
            qos_txt, partition_txt, now, self.policy_interval,
            lua_text=lua_txt, check=self._read_check(), lua_meta=lua_meta)
        self.policy_at = now
        self._save_policy_cache()

    def refresh_check(self):
        """Re-apply the latest verification report without refetching."""
        src = self.policy_sources
        if not src or self.policy_snapshot is None:
            return
        meta = {k: v for k, v in (self.policy_snapshot.get("lua") or {}).items()
                if k not in ("partitions", "parsed")}
        self.policy_snapshot = build_policy_snapshot(
            src.get("qos", ""), src.get("partitions", ""), self.policy_snapshot["generated_at"],
            self.policy_interval, lua_text=src.get("lua", ""), check=self._read_check(),
            lua_meta=meta)

    def _read_check(self):
        if not self.policy_check or not os.path.exists(self.policy_check):
            return None
        try:
            with open(self.policy_check) as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def _save_policy_cache(self):
        if not self.policy_cache:
            return
        try:
            os.makedirs(os.path.dirname(self.policy_cache) or ".", exist_ok=True)
            tmp = self.policy_cache + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"sources": self.policy_sources,
                           "lua_meta": {k: v for k, v in self.policy_snapshot["lua"].items()
                                        if k not in ("partitions", "parsed")}}, f)
            os.replace(tmp, self.policy_cache)
        except OSError:
            pass

    def _load_policy_cache(self):
        if not self.policy_cache or not os.path.exists(self.policy_cache):
            return
        try:
            with open(self.policy_cache) as f:
                cached = json.load(f)
        except (OSError, ValueError):
            return
        src = cached.get("sources") or {}
        if not (src.get("qos") or src.get("partitions")):
            return
        self.policy_sources = src
        self.policy_snapshot = build_policy_snapshot(
            src.get("qos", ""), src.get("partitions", ""), src.get("fetched_at") or time.time(),
            self.policy_interval, lua_text=src.get("lua", ""), check=self._read_check(),
            lua_meta=cached.get("lua_meta"))
        # cached data is shown immediately but still refreshed on the first cycle

    @staticmethod
    def slurm_version(nodes_json):
        return ((nodes_json.get("meta") or {}).get("slurm") or {}).get("release", "")
