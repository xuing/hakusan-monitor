"""SQLite time-series store for Hakusan Monitor (stdlib `sqlite3` only).

Two tables, the classic raw + rollup TSDB pattern:
  • samples         — one compact row per sample; pruned to a retention window.
  • samples_hourly  — running hourly aggregate (avg/max); kept indefinitely so
                      peak/trough analysis works over months without huge tables.

Thread-safe: one connection per thread (works under ThreadingHTTPServer).
"""
from __future__ import annotations
import os, json, sqlite3, threading, time

SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
  ts          INTEGER PRIMARY KEY,           -- unix seconds
  cpu_util    REAL, gpu_util REAL, mem_util REAL,
  cpus_total  INTEGER, cpus_alloc INTEGER,
  gpus_total  INTEGER, gpus_used  INTEGER,
  nodes_total INTEGER, nodes_avail INTEGER, nodes_down INTEGER,
  running     INTEGER, pending INTEGER,
  detail      TEXT                            -- JSON: per-pool / per-gpu utilization
);
CREATE TABLE IF NOT EXISTS samples_hourly (
  hour        INTEGER PRIMARY KEY,            -- unix seconds truncated to the hour
  n           INTEGER,
  cpu_avg     REAL, cpu_max REAL,
  gpu_avg     REAL, gpu_max REAL,
  pending_avg REAL, pending_max INTEGER,
  running_avg REAL
);
CREATE TABLE IF NOT EXISTS login_samples (
  ts              INTEGER,
  node_id         TEXT,
  load1           REAL,
  load_per_core   REAL,
  cpu_busy        REAL,
  cpu_iowait      REAL,
  mem_used_ratio  REAL,
  swap_used_ratio REAL,
  disk_used_max   REAL,
  inode_used_max  REAL,
  d_state         INTEGER,
  pressure_score  REAL,
  pressure_level  TEXT,
  detail          TEXT,
  PRIMARY KEY (ts, node_id)
);
CREATE INDEX IF NOT EXISTS idx_login_samples_node_ts
  ON login_samples(node_id, ts);
"""


def _metrics(snap):
    t = snap["totals"]
    return {
        "cpu_util": t["cpus"]["util"], "gpu_util": t["gpus"]["util"],
        "mem_util": t["memory"]["util"],
        "cpus_total": t["cpus"]["total"], "cpus_alloc": t["cpus"]["alloc"],
        "gpus_total": t["gpus"]["total"], "gpus_used": t["gpus"]["used"],
        "nodes_total": t["nodes"]["total"], "nodes_avail": t["nodes"]["available"],
        "nodes_down": t["nodes"]["down"],
        "running": snap["queue"]["running"], "pending": snap["queue"]["pending"],
    }


class Store:
    def __init__(self, path, retain_days=60):
        self.path = path
        self.retain_days = retain_days
        self._last_ts = None        # guard against same-second double-counting
        self._local = threading.local()
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self._conn().executescript(SCHEMA)

    def _conn(self):
        c = getattr(self._local, "conn", None)
        if c is None:
            c = sqlite3.connect(self.path, check_same_thread=False, timeout=10)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA synchronous=NORMAL")
            self._local.conn = c
        return c

    # ---- write -------------------------------------------------------------
    def record(self, snap, ts):
        if ts == self._last_ts:   # same-second resample would double-count the hourly rollup
            return
        self._last_ts = ts
        m = _metrics(snap)
        detail = json.dumps({"pools": snap.get("pools"), "gpus": snap.get("gpus")})
        c = self._conn()
        with c:
            c.execute(
                """INSERT OR REPLACE INTO samples
                   (ts,cpu_util,gpu_util,mem_util,cpus_total,cpus_alloc,
                    gpus_total,gpus_used,nodes_total,nodes_avail,nodes_down,
                    running,pending,detail)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (ts, m["cpu_util"], m["gpu_util"], m["mem_util"], m["cpus_total"],
                 m["cpus_alloc"], m["gpus_total"], m["gpus_used"], m["nodes_total"],
                 m["nodes_avail"], m["nodes_down"], m["running"], m["pending"], detail))
            hour = ts - ts % 3600
            c.execute(
                """INSERT INTO samples_hourly
                     (hour,n,cpu_avg,cpu_max,gpu_avg,gpu_max,pending_avg,pending_max,running_avg)
                   VALUES (?,1,?,?,?,?,?,?,?)
                   ON CONFLICT(hour) DO UPDATE SET
                     cpu_avg     = (cpu_avg*n + excluded.cpu_avg)/(n+1),
                     cpu_max     = max(cpu_max, excluded.cpu_max),
                     gpu_avg     = (gpu_avg*n + excluded.gpu_avg)/(n+1),
                     gpu_max     = max(gpu_max, excluded.gpu_max),
                     pending_avg = (pending_avg*n + excluded.pending_avg)/(n+1),
                     pending_max = max(pending_max, excluded.pending_max),
                     running_avg = (running_avg*n + excluded.running_avg)/(n+1),
                     n = n+1""",
                (hour, m["cpu_util"], m["cpu_util"], m["gpu_util"], m["gpu_util"],
                 m["pending"], m["pending"], m["running"]))

    def record_login(self, payload, ts):
        nodes = [n for n in (payload or {}).get("nodes", []) if n.get("ok")]
        if not nodes:
            return
        c = self._conn()
        with c:
            for node in nodes:
                disks = node.get("disks") or []
                c.execute(
                    """INSERT OR REPLACE INTO login_samples
                       (ts,node_id,load1,load_per_core,cpu_busy,cpu_iowait,
                        mem_used_ratio,swap_used_ratio,disk_used_max,inode_used_max,
                        d_state,pressure_score,pressure_level,detail)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        ts,
                        node.get("id", ""),
                        (node.get("load") or {}).get("1m"),
                        (node.get("load") or {}).get("per_core"),
                        (node.get("cpu") or {}).get("busy"),
                        (node.get("cpu") or {}).get("iowait"),
                        (node.get("memory") or {}).get("used_ratio"),
                        (node.get("memory") or {}).get("swap_ratio"),
                        max((d.get("use_pct", 0) for d in disks), default=0) / 100.0,
                        max((d.get("inode_use_pct", 0) for d in disks), default=0) / 100.0,
                        (node.get("processes") or {}).get("d_state", 0),
                        (node.get("pressure") or {}).get("score", 0.0),
                        (node.get("pressure") or {}).get("level", "low"),
                        json.dumps({
                            "pressure": node.get("pressure"),
                            "io": node.get("io"),
                            "top_cpu": (node.get("processes") or {}).get("top_cpu", []),
                            "top_mem": (node.get("processes") or {}).get("top_mem", []),
                            "users": node.get("users", []),
                        }),
                    ),
                )

    def prune(self, now):
        cutoff = int(now) - self.retain_days * 86400
        c = self._conn()
        with c:
            c.execute("DELETE FROM samples WHERE ts < ?", (cutoff,))

    # ---- read --------------------------------------------------------------
    def history(self, since, until, max_points=600):
        """Raw samples in [since, until], evenly down-sampled to <= max_points."""
        c = self._conn()
        n = c.execute("SELECT count(*) AS n FROM samples WHERE ts BETWEEN ? AND ?",
                      (since, until)).fetchone()["n"]
        step = max(1, (n // max_points) + 1)
        rows = c.execute(
            """SELECT ts,cpu_util,gpu_util,mem_util,running,pending,
                      nodes_avail,nodes_down,
                      row_number() OVER (ORDER BY ts) AS rn
               FROM samples WHERE ts BETWEEN ? AND ? ORDER BY ts""",
            (since, until)).fetchall()
        out = []
        for r in rows:
            if r["rn"] % step == 0:
                d = dict(r)
                d.pop("rn", None)
                out.append(d)
        return out

    def login_history(self, since, until, max_points=600):
        c = self._conn()
        n = c.execute("SELECT count(*) AS n FROM login_samples WHERE ts BETWEEN ? AND ?",
                      (since, until)).fetchone()["n"]
        step = max(1, (n // max_points) + 1)
        rows = c.execute(
            """SELECT ts,node_id,load1,load_per_core,cpu_busy,cpu_iowait,
                      mem_used_ratio,swap_used_ratio,disk_used_max,inode_used_max,
                      d_state,pressure_score,pressure_level,
                      row_number() OVER (ORDER BY ts,node_id) AS rn
               FROM login_samples WHERE ts BETWEEN ? AND ? ORDER BY ts,node_id""",
            (since, until)).fetchall()
        out = []
        for r in rows:
            if r["rn"] % step == 0:
                d = dict(r)
                d.pop("rn", None)
                out.append(d)
        return out

    def usage_pattern(self, days=30):
        """Peak/trough analysis from the hourly rollup, in **local** time.

        Returns averages by hour-of-day (0-23), by weekday (0=Sun..6=Sat), and a
        weekday×hour heatmap. Values are Slurm allocation ratios, not hardware
        utilization. Hour buckets are weighted by their raw sample count.
        """
        c = self._conn()
        latest = c.execute("SELECT max(hour) AS h FROM samples_hourly").fetchone()["h"]
        until = latest or 0
        since = until - days * 86400 if until else 0
        rows = c.execute(
            """SELECT
                 hour,
                 CAST(strftime('%w', hour, 'unixepoch', 'localtime') AS INTEGER) AS wd,
                 CAST(strftime('%H', hour, 'unixepoch', 'localtime') AS INTEGER) AS hod,
                 cpu_avg, gpu_avg, pending_avg, n
               FROM samples_hourly WHERE hour >= ?""", (since,)).fetchall()

        by_hour = {h: {"cpu": 0.0, "gpu": 0.0, "pending": 0.0, "samples": 0, "hours": 0} for h in range(24)}
        by_wd = {d: {"cpu": 0.0, "gpu": 0.0, "pending": 0.0, "samples": 0, "hours": 0} for d in range(7)}
        heat = {}
        first = min((r["hour"] for r in rows), default=0)
        total_samples = 0
        for r in rows:
            samples = int(r["n"] or 0)
            if samples <= 0:
                continue
            total_samples += samples
            for bucket, key in ((by_hour, r["hod"]), (by_wd, r["wd"])):
                b = bucket[key]
                b["cpu"] += r["cpu_avg"] * samples; b["gpu"] += r["gpu_avg"] * samples
                b["pending"] += r["pending_avg"] * samples; b["samples"] += samples
                b["hours"] += 1
            hk = (r["wd"], r["hod"])
            h = heat.setdefault(hk, {"cpu": 0.0, "gpu": 0.0, "pending": 0.0, "samples": 0, "hours": 0})
            h["cpu"] += r["cpu_avg"] * samples; h["gpu"] += r["gpu_avg"] * samples
            h["pending"] += r["pending_avg"] * samples; h["samples"] += samples
            h["hours"] += 1

        def avg(b):
            samples = b["samples"] or 1
            return {"cpu": round(b["cpu"]/samples, 3), "gpu": round(b["gpu"]/samples, 3),
                    "pending": round(b["pending"]/samples, 1),
                    "samples": b["samples"], "hours": b["hours"]}

        hours = [{"hour": h, **avg(by_hour[h])} for h in range(24)]
        weekdays = [{"weekday": d, **avg(by_wd[d])} for d in range(7)]
        heatmap = [{"weekday": wd, "hour": hod,
                    "gpu": round(v["gpu"]/(v["samples"] or 1), 3),
                    "cpu": round(v["cpu"]/(v["samples"] or 1), 3),
                    "pending": round(v["pending"]/(v["samples"] or 1), 1),
                    "samples": v["samples"], "hours": v["hours"]}
                   for (wd, hod), v in sorted(heat.items())]
        ranked = [h for h in hours if h["samples"]]
        busiest = max(ranked, key=lambda x: x["gpu"], default=None)
        quietest = min(ranked, key=lambda x: x["gpu"], default=None)
        return {"days": days, "by_hour": hours, "by_weekday": weekdays,
                "heatmap": heatmap, "busiest_hour": busiest, "quietest_hour": quietest,
                "total_hours": len(rows), "total_samples": total_samples,
                "since": first, "until": until + 3599 if until else 0,
                "timezone": os.environ.get("TZ") or time.tzname[0] or "localtime"}

    def stats(self):
        c = self._conn()
        s = c.execute("SELECT count(*) n, min(ts) a, max(ts) b FROM samples").fetchone()
        h = c.execute("SELECT count(*) n FROM samples_hourly").fetchone()
        l = c.execute("SELECT count(*) n FROM login_samples").fetchone()
        return {"samples": s["n"], "first_ts": s["a"], "last_ts": s["b"],
                "hours": h["n"], "login_samples": l["n"],
                "retain_days": self.retain_days}
