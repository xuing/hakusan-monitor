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
import os, re, json, time, shlex, subprocess

MARK = "@@HM@@"
SEP = "|@|"   # field separator unlikely to occur in any value (e.g. job names)
# order matters — see parse_queue()
SQUEUE_FIELDS = ["%i", "%u", "%a", "%P", "%T", "%r", "%D", "%C", "%b", "%V",
                 "%e", "%S", "%L", "%j", "%q", "%N", "%M", "%l"]
SQUEUE_FMT = SEP.join(SQUEUE_FIELDS)
CONTAINER_FMT = "JobID:64,Container:512"


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
    try:                       # squeue %V is local time, e.g. 2026-06-27T10:29:04
        return int(time.mktime(time.strptime(iso, "%Y-%m-%dT%H:%M:%S")))
    except Exception:
        return 0


def _clean(s):
    """Slurm prints 'N/A' / 'INVALID' / 'Unknown' for unset times."""
    return "" if s in ("N/A", "INVALID", "Unknown", "") else s


def parse_containers(text):
    """`squeue -O JobID,Container` -> {job_id: container image/path}.

    The `-O/--Format` surface exposes fields not available through `-o` single
    letter formats; SchedMD documents `--Format` as the path to "all fields".
    """
    out = {}
    for line in text.splitlines():
        p = line.strip().split(None, 1)
        if not p:
            continue
        val = p[1].strip() if len(p) > 1 else ""
        out[p[0]] = "" if val in ("N/A", "(null)", "None", "NULL") else val
    return out


def parse_queue(text, containers=None):
    """`squeue -h -a -o SQUEUE_FMT` -> [{...}] like squeue --json, enriched with
    every field the raw Jobs table surfaces (see SQUEUE_FIELDS for order)."""
    containers = containers or {}
    jobs = []
    for line in text.splitlines():
        p = line.split(SEP)
        if len(p) < len(SQUEUE_FIELDS):
            continue
        (jid, user, acct, part, state, reason, nnodes, cpus, gres, submit,
         end, start_est, left, name, qos, nodelist, used, timelimit) = p[:18]
        gm = re.search(r"gpu:(?:[A-Za-z0-9_\-]+:)?(\d+)", gres or "")
        nnodes_i = int(nnodes) if nnodes.isdigit() else 0
        # squeue %b reports GRES *per node* (Slurm --gres is per-node); the job's
        # total GPUs = per-node × node count, else multi-node GPU jobs undercount.
        gpu = (int(gm.group(1)) if gm else 0) * (nnodes_i or 1)
        jobs.append({
            "job_id": int(jid) if jid.isdigit() else jid,
            "user_name": user, "account": acct, "partition": part,
            "job_state": state, "state_reason": reason,
            "node_count": nnodes_i,
            "cpus": int(cpus) if cpus.isdigit() else 0,
            "gpus": gpu,
            "tres_req_str": f"gres/gpu={gpu}" if gpu else "",
            "container": containers.get(str(jid), ""), "submit_time": _epoch(submit),
            "end_time": _clean(end), "start_est": _clean(start_est),
            "time_left": _clean(left),
            "name": name, "qos": qos, "nodelist": _clean(nodelist),
            "time_used": _clean(used), "time_limit": _clean(timelimit),
        })
    return {"jobs": jobs}


class Source:
    def __init__(self, mode="mock", ssh_host="", ssh_opts="",
                 mock_dir="mock", timeout=25):
        self.mode = mode
        self.ssh_host = ssh_host
        self.ssh_opts = ssh_opts
        self.mock_dir = mock_dir
        self.timeout = timeout
        self.singularity = None     # filled by fetch() (folded into one round trip)

    def _exec(self, script, timeout=None):
        """Run a shell snippet on the cluster (ssh) or locally."""
        if self.mode == "ssh":
            cmd = ["ssh", *shlex.split(self.ssh_opts), self.ssh_host, script]
        else:
            cmd = ["bash", "-lc", script]
        p = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=timeout or self.timeout)
        if p.returncode != 0:
            raise RuntimeError(f"collect failed rc={p.returncode}: {p.stderr.strip()[:300]}")
        return p.stdout

    def _mock(self, name):
        with open(os.path.join(self.mock_dir, name)) as f:
            return json.load(f)

    def fetch(self):
        """Return (nodes_json, squeue_json). One SSH round trip also captures the
        Singularity version (in self.singularity) so there's no extra call."""
        if self.mode == "mock":
            return self._mock("nodes.json"), self._mock("squeue.json")
        singularity_cmd = ("singularity --version 2>/dev/null || true"
                           if self.singularity is None else "true")
        out = self._exec(f"scontrol -o show nodes; echo {MARK}; "
                         f"squeue -h -a -o '{SQUEUE_FMT}'; echo {MARK}; "
                         f"(squeue -h -a -O '{CONTAINER_FMT}' 2>/dev/null || true); echo {MARK}; "
                         f"{singularity_cmd}")
        nodes_txt, queue_txt, containers_txt, sing_txt = (out.split(MARK) + ["", "", ""])[:4]
        if self.singularity is None and "version" in sing_txt:
            self.singularity = sing_txt.split("version")[-1].strip().split("-")[0]
        return parse_nodes(nodes_txt), parse_queue(queue_txt, parse_containers(containers_txt))

    @staticmethod
    def slurm_version(nodes_json):
        return ((nodes_json.get("meta") or {}).get("slurm") or {}).get("release", "")
