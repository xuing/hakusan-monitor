"""Lightweight login-node health collection.

The collector intentionally uses short-lived, read-only Linux commands that are
already available on ordinary login nodes. It sends back summaries plus top
offenders, not a full process table.
"""
from __future__ import annotations

import json
import os
import shlex
import subprocess
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

MARK = "@@HM_LOGIN@@"


def _float(s, default=0.0):
    try:
        return float(s)
    except (TypeError, ValueError):
        return default


def _int(s, default=0):
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return default


def _ratio(num, den):
    return round(num / den, 4) if den else 0.0


def parse_login_nodes(spec):
    """`id=ssh-target,id2=ssh-target2` -> [(id, target)].
    """
    out = []
    for item in (spec or "").split(","):
        item = item.strip()
        if not item:
            continue
        if "=" in item:
            name, target = item.split("=", 1)
            name, target = name.strip(), target.strip()
        else:
            target = item
            name = item.split("@")[-1].split(".")[0]
        if name and target:
            out.append((name, target))
    return out


def _sections(text):
    current = None
    buf = []
    out = {}
    for line in text.splitlines():
        if line.startswith(MARK + " "):
            if current is not None:
                out[current] = "\n".join(buf).strip("\n")
            current = line[len(MARK) + 1:].strip()
            buf = []
        else:
            buf.append(line)
    if current is not None:
        out[current] = "\n".join(buf).strip("\n")
    return out


def _meminfo(text):
    vals = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, rest = line.split(":", 1)
        vals[key] = _int(rest.strip().split()[0]) * 1024
    total = vals.get("MemTotal", 0)
    avail = vals.get("MemAvailable", vals.get("MemFree", 0))
    swap_total = vals.get("SwapTotal", 0)
    swap_free = vals.get("SwapFree", 0)
    used = max(total - avail, 0)
    swap_used = max(swap_total - swap_free, 0)
    return {
        "total": total,
        "available": avail,
        "used": used,
        "used_ratio": _ratio(used, total),
        "swap_total": swap_total,
        "swap_used": swap_used,
        "swap_ratio": _ratio(swap_used, swap_total),
    }


def _load(text, cores):
    parts = text.split()
    one = _float(parts[0]) if parts else 0.0
    five = _float(parts[1]) if len(parts) > 1 else 0.0
    fifteen = _float(parts[2]) if len(parts) > 2 else 0.0
    return {"1m": one, "5m": five, "15m": fifteen, "per_core": _ratio(one, cores)}


def _cpu_fields(line):
    parts = line.split()
    if not parts or parts[0] != "cpu":
        return None
    nums = [_int(x) for x in parts[1:]]
    while len(nums) < 8:
        nums.append(0)
    idle = nums[3] + nums[4]
    iowait = nums[4]
    total = sum(nums)
    return {"total": total, "idle": idle, "iowait": iowait}


def _cpu_delta(prev, cur):
    if not prev or not cur:
        return {"busy": None, "iowait": None}
    dt = cur["total"] - prev["total"]
    if dt <= 0:
        return {"busy": None, "iowait": None}
    idle = cur["idle"] - prev["idle"]
    iowait = cur["iowait"] - prev["iowait"]
    return {"busy": round(max(dt - idle, 0) / dt, 4), "iowait": round(max(iowait, 0) / dt, 4)}


def _df(text):
    rows = []
    for line in text.splitlines()[1:]:
        p = line.split()
        if len(p) < 6:
            continue
        rows.append({
            "filesystem": p[0],
            "size": _int(p[1]),
            "used": _int(p[2]),
            "available": _int(p[3]),
            "use_pct": _int(p[4].rstrip("%")),
            "mount": p[5],
        })
    return rows


def _is_health_disk(row):
    """Return whether a df row should be shown for login-node disk space."""
    fs = row.get("filesystem", "")
    mount = row.get("mount", "")
    if not fs or not mount:
        return False
    if fs == "efivarfs" or fs.startswith("/dev/loop"):
        return False
    if mount == "/mnt/iso" or mount.startswith("/home/"):
        return False
    if mount.startswith(("/proc", "/sys", "/dev", "/run")):
        return False
    return True


def _proc(line, show_args):
    p = line.strip().split(None, 8)
    if len(p) < 8:
        return None
    args = p[8] if len(p) > 8 else p[7]
    return {
        "pid": _int(p[0]),
        "user": p[1],
        "stat": p[2],
        "cpu_pct": _float(p[3]),
        "mem_pct": _float(p[4]),
        "rss": _int(p[5]) * 1024,
        "elapsed_s": _int(p[6]),
        "command": p[7],
        "args": args[:220] if show_args else "",
    }


def _procs(text, show_args):
    return [p for p in (_proc(line, show_args) for line in text.splitlines()) if p]


def _users_from_procs(procs):
    agg = defaultdict(lambda: {"cpu_pct": 0.0, "mem_pct": 0.0, "rss": 0, "processes": 0})
    for proc in procs:
        user = proc.get("user", "")
        a = agg[user]
        a["cpu_pct"] += proc.get("cpu_pct", 0.0)
        a["mem_pct"] += proc.get("mem_pct", 0.0)
        a["rss"] += proc.get("rss", 0)
        a["processes"] += 1
    users = [{"user": user, **vals} for user, vals in agg.items()]
    users.sort(key=lambda x: (-x["cpu_pct"], -x["rss"]))
    return users


def _metric(vals, *keys, scale=1.0):
    for key in keys:
        if key in vals:
            return _float(vals.get(key)) * scale
    return None


def _max_metric(values):
    known = [v for v in values if v is not None]
    return max(known) if known else None


def _sort_metric(value):
    return -1.0 if value is None else value


def _iostat(text):
    current = None
    reports = []

    def new_report():
        return {"iowait_pct": None, "devices": []}

    def finish_report():
        nonlocal current
        if current is not None:
            reports.append(current)
        current = new_report()

    header = None
    cpu_header = None
    for line in text.splitlines():
        p = line.split()
        if not p:
            continue
        if p[0] == "avg-cpu:":
            finish_report()
            cpu_header = p[1:]
            header = None
            continue
        if current is None:
            current = new_report()
        if cpu_header and p[0] != "Device":
            vals = {key: p[i] for i, key in enumerate(cpu_header) if i < len(p)}
            current["iowait_pct"] = _metric(vals, "%iowait")
            cpu_header = None
            continue
        if p[0] == "Device":
            header = p
            continue
        if not header or len(p) < len(header):
            continue
        name = p[0]
        if name.startswith(("loop", "ram", "sr", "zram")):
            continue
        vals = {key: p[i] for i, key in enumerate(header) if i < len(p)}
        reads = _metric(vals, "rkB/s")
        if reads is None:
            reads = _metric(vals, "rMB/s", scale=1024.0)
        writes = _metric(vals, "wkB/s")
        if writes is None:
            writes = _metric(vals, "wMB/s", scale=1024.0)
        discards = _metric(vals, "dkB/s")
        if discards is None:
            discards = _metric(vals, "dMB/s", scale=1024.0)
        reads = reads or 0.0
        writes = writes or 0.0
        discards = discards or 0.0
        awaits = [
            _metric(vals, "r_await"),
            _metric(vals, "w_await"),
            _metric(vals, "d_await"),
            _metric(vals, "f_await"),
            _metric(vals, "await"),
        ]
        util = _metric(vals, "%util")
        if util is not None:
            util = max(0.0, min(100.0, util))
        current["devices"].append({
            "name": name,
            "util_pct": util,
            "await_ms": _max_metric(awaits),
            "aqu_sz": _metric(vals, "aqu-sz", "avgqu-sz"),
            "read_kbps": reads,
            "write_kbps": writes,
            "discard_kbps": discards,
            "io_kbps": reads + writes + discards,
        })
    if current is not None:
        reports.append(current)

    report = reports[-1] if reports else new_report()
    devices = report["devices"]
    devices.sort(key=lambda d: (
        -_sort_metric(d["util_pct"]),
        -_sort_metric(d["await_ms"]),
        -d["io_kbps"],
        d["name"],
    ))
    return {
        "source": "iostat",
        "available": bool(text.strip()),
        "sample_s": 1,
        "devices": devices[:8],
        "iowait_pct": report["iowait_pct"],
        "max_util_pct": _max_metric(d["util_pct"] for d in devices),
        "max_await_ms": _max_metric(d["await_ms"] for d in devices),
        "max_aqu_sz": _max_metric(d["aqu_sz"] for d in devices),
    }


class LoginNodeCollector:
    def __init__(self, *, mode, nodes, ssh_opts, mock_dir, interval=300,
                 timeout=12, top_n=12, show_args=False, mask_users=False):
        self.mode = mode
        self.nodes = parse_login_nodes(nodes)
        self.ssh_opts = ssh_opts
        self.mock_dir = mock_dir
        self.interval = interval
        self.timeout = timeout
        self.top_n = max(3, int(top_n))
        self.show_args = show_args
        self.mask_users = mask_users
        self.latest = None
        self.error = None
        self._fails = {}   # node id -> consecutive failed samples

    def fetch(self, now=None):
        now = int(now or time.time())
        if self.latest and now - self.latest.get("generated_at", 0) < self.interval:
            return self.latest, False
        try:
            payload = self._collect(now)
            self.latest = payload
            self.error = None
            return payload, True
        except Exception as e:
            self.error = str(e)
            if self.latest:
                self.latest = {**self.latest, "stale": True, "error": str(e)}
                return self.latest, False
            raise

    def _collect(self, now):
        if self.mode == "mock":
            payload = self._mock(now)
        elif self.mode == "local" and not self.nodes:
            payload = self._collect_targets([("local", "")], now, local=True)
        elif not self.nodes:
            payload = {"generated_at": now, "interval": self.interval, "configured": False,
                       "nodes": [], "stale": False}
        else:
            payload = self._collect_targets(self.nodes, now, local=False)
        payload["age_s"] = 0
        return payload

    def _mock(self, now):
        path = os.path.join(self.mock_dir, "login_nodes.json")
        with open(path) as f:
            payload = json.load(f)
        payload["generated_at"] = now
        payload["interval"] = self.interval
        payload["configured"] = True
        payload["stale"] = False
        for node in payload.get("nodes", []):
            node["sampled_at"] = now
        return payload

    def _collect_targets(self, targets, now, *, local):
        nodes = []
        with ThreadPoolExecutor(max_workers=min(len(targets), 4) or 1) as ex:
            futs = {ex.submit(self._one, name, target, now, local): (name, target)
                    for name, target in targets}
            for fut in as_completed(futs):
                name, target = futs[fut]
                try:
                    node = fut.result()
                except Exception as e:
                    node = {"id": name, "target": target, "ok": False,
                            "sampled_at": now, "error": str(e)}
                if node.get("ok"):
                    self._fails.pop(name, None)
                else:
                    self._fails[name] = self._fails.get(name, 0) + 1
                    node["fail_count"] = self._fails[name]
                nodes.append(node)
        nodes.sort(key=lambda n: n["id"])
        return {"generated_at": now, "interval": self.interval, "configured": True,
                "nodes": nodes, "stale": False}

    def _exec(self, target, script, local):
        if local:
            cmd = ["bash", "-lc", script]
        else:
            cmd = ["ssh", *shlex.split(self.ssh_opts), target, script]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=self.timeout)
        if p.returncode != 0:
            raise RuntimeError(p.stderr.strip()[:300] or f"rc={p.returncode}")
        return p.stdout

    def _script(self):
        ps_fields = "pid=,user=,stat=,pcpu=,pmem=,rss=,etimes=,comm=,args=" if self.show_args else \
            "pid=,user=,stat=,pcpu=,pmem=,rss=,etimes=,comm="
        return f"""
export LC_ALL=C
echo "{MARK} hostname"; hostname
echo "{MARK} loadavg"; cat /proc/loadavg
echo "{MARK} nproc"; nproc
echo "{MARK} stat_before"; grep '^cpu ' /proc/stat
echo "{MARK} meminfo"; cat /proc/meminfo
echo "{MARK} df"; df -P -B1 -x tmpfs -x devtmpfs 2>/dev/null
echo "{MARK} iostat"; if command -v iostat >/dev/null 2>&1; then iostat -x -y 1 1 2>/dev/null || true; fi
echo "{MARK} stat_after"; grep '^cpu ' /proc/stat
echo "{MARK} ps"; ps -eo {ps_fields}
"""

    def _one(self, name, target, now, local):
        sec = _sections(self._exec(target, self._script(), local))
        cores = _int(sec.get("nproc"), 0)
        cpu_before = _cpu_fields(sec.get("stat_before", ""))
        cpu_after = _cpu_fields(sec.get("stat_after", "")) or cpu_before
        all_procs = _procs(sec.get("ps", ""), self.show_args)
        top_cpu = sorted(all_procs, key=lambda p: (-p["cpu_pct"], -p["rss"]))[:self.top_n]
        top_mem = sorted(all_procs, key=lambda p: (-p["rss"], -p["cpu_pct"]))[:self.top_n]
        if self.mask_users:
            for p in all_procs:
                u = p.get("user", "")
                p["user"] = (u[:2] + "***") if len(u) > 2 else "***"
        disks = [d for d in _df(sec.get("df", "")) if _is_health_disk(d)]
        io = _iostat(sec.get("iostat", ""))
        node = {
            "id": name,
            "target": target,
            "hostname": (sec.get("hostname") or name).splitlines()[0],
            "ok": True,
            "sampled_at": now,
            "cores": cores,
            "load": _load(sec.get("loadavg", ""), cores),
            "cpu": _cpu_delta(cpu_before, cpu_after),
            "memory": _meminfo(sec.get("meminfo", "")),
            "disks": disks,
            "io": io,
            "processes": {
                "top_cpu": top_cpu,
                "top_mem": top_mem,
                "d_state": sum(1 for p in all_procs if "D" in p.get("stat", "")),
            },
            "users": _users_from_procs(all_procs)[:self.top_n],
        }
        return node


def summarize_users(nodes):
    agg = defaultdict(lambda: {"cpu_pct": 0.0, "mem_pct": 0.0, "rss": 0, "processes": 0})
    for node in nodes:
        for user in node.get("users", []):
            a = agg[user["user"]]
            a["cpu_pct"] += user.get("cpu_pct", 0.0)
            a["mem_pct"] += user.get("mem_pct", 0.0)
            a["rss"] += user.get("rss", 0)
            a["processes"] += user.get("processes", 0)
    return [{"user": u, **v} for u, v in sorted(
        agg.items(), key=lambda item: (-item[1]["cpu_pct"], -item[1]["rss"]))[:12]]
