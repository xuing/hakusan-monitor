"""SQLite store for Hakusan Monitor (stdlib `sqlite3` only).

  • samples       — the timestamp of every recorded snapshot, pruned to a
                    retention window: the key that makes recording idempotent
                    across restarts and retries.
  • pool_hourly   — per pool and hour: how often anything was free (the
                    Analytics "when is it free" card), kept indefinitely.
  • login_samples — login-node load; visits; jobs / job_attempts (sacct history).

Thread-safe: one connection per thread (works under ThreadingHTTPServer).
"""
from __future__ import annotations
import hashlib, os, json, secrets, sqlite3, sys, threading, time

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
  ts          INTEGER PRIMARY KEY            -- unix seconds
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
  detail          TEXT,
  PRIMARY KEY (ts, node_id)
);
CREATE INDEX IF NOT EXISTS idx_login_samples_node_ts
  ON login_samples(node_id, ts);
CREATE TABLE IF NOT EXISTS visits (
  day     TEXT,                               -- local date, YYYY-MM-DD
  visitor TEXT,                               -- anonymous hash of ip|user-agent
  hits    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (day, visitor)
);
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (               -- one row per job allocation (sacct -X)
  id         INTEGER PRIMARY KEY,               -- JobIDRaw
  array_id   INTEGER,                           -- array master id (= id for plain jobs)
  user       TEXT,                              -- keyed hash, never the login name
  partition  TEXT,                              -- may list several while pending
  submit     INTEGER, eligible INTEGER, start INTEGER, "end" INTEGER,
  elapsed    INTEGER, timelimit INTEGER,        -- seconds / minutes
  state      TEXT,
  nodes      INTEGER, cpus INTEGER, gpus INTEGER, gpu_type TEXT, mem_mb INTEGER,
  interactive INTEGER,                          -- 1 = salloc / srun allocation
  job_key    TEXT                               -- sacct JobID ("123", "120_3", "120_[4-9]")
);
CREATE INDEX IF NOT EXISTS idx_jobs_submit ON jobs(submit);
CREATE TABLE IF NOT EXISTS job_attempts (       -- earlier runs of requeued jobs
  id         INTEGER,                           -- JobIDRaw of the job
  start      INTEGER,
  "end"      INTEGER,
  user       TEXT, partition TEXT, submit INTEGER,
  cpus       INTEGER, gpus INTEGER,
  PRIMARY KEY (id, start)
);
CREATE TABLE IF NOT EXISTS pool_hourly (        -- per-pool "is anything free" rollup
  hour    INTEGER,
  pool    TEXT,
  n       INTEGER,                              -- samples in the hour
  free_n  INTEGER,                              -- samples with >=1 free GPU / idle node
  free_sum REAL,                                -- sum of free GPUs / idle nodes
  PRIMARY KEY (hour, pool)
);
"""

JOB_COLUMNS = ("id", "array_id", "user", "partition", "submit", "eligible", "start", "end",
               "elapsed", "timelimit", "state", "nodes", "cpus", "gpus", "gpu_type", "mem_mb",
               "interactive", "job_key")
ACTIVE_STATES = ("PENDING", "RUNNING", "REQUEUED", "RESIZING", "SUSPENDED")


def pool_free(pool):
    """(free units, anything free?) of one snapshot pool for the hourly rollup.

    GPU pools: GPUs that are idle, up and not held by the scheduler (gpu.free).
    CPU pools: whole idle nodes — jobs that take full nodes need one, and a
    pool-wide free-core total says nothing about whether a node is empty.
    """
    gpu = pool.get("gpu")
    if pool.get("kind") == "gpu":
        free = (gpu or {}).get("free") or 0
        return free, int(free >= 1 and not (gpu or {}).get("maint"))
    idle = pool.get("idle_nodes") or 0
    return idle, int(idle >= 1)


class Store:
    def __init__(self, path, retain_days=60, login_retain_days=None, visit_retain_days=365,
                 job_retain_days=400):
        self.path = path
        self.retain_days = retain_days
        self.job_retain_days = job_retain_days
        self.login_retain_days = retain_days if login_retain_days is None else login_retain_days
        self.visit_retain_days = visit_retain_days
        self._local = threading.local()
        self._record_lock = threading.Lock()
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        c = self._conn()
        c.executescript(SCHEMA)
        cols = {r["name"] for r in c.execute("PRAGMA table_info(jobs)")}
        if "job_key" not in cols:   # jobs tables created before the column existed
            c.execute("ALTER TABLE jobs ADD COLUMN job_key TEXT")
        # dropped 2026-10: the hourly cluster rollup and the per-sample metric
        # columns, which nothing has read since /api/history went
        c.execute("DROP TABLE IF EXISTS samples_hourly")
        if len(c.execute("PRAGMA table_info(samples)").fetchall()) > 1:
            c.executescript("""BEGIN;
                DROP TABLE IF EXISTS samples_ts;
                CREATE TABLE samples_ts (ts INTEGER PRIMARY KEY);
                INSERT INTO samples_ts SELECT ts FROM samples;
                DROP TABLE samples;
                ALTER TABLE samples_ts RENAME TO samples;
                COMMIT;""")
        c.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        self._visitor_salt = self._meta_secret("visitor_salt")
        self._user_key = bytes.fromhex(self._meta_secret("job_user_salt"))

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
        with self._record_lock:
            c = self._conn()
            with c:
                inserted = c.execute(
                    "INSERT INTO samples (ts) VALUES (?) ON CONFLICT(ts) DO NOTHING", (ts,))
                # Database-backed idempotency also survives restarts and
                # out-of-order retries: the sample and its rollup commit together.
                if inserted.rowcount == 0:
                    return
                hour = ts - ts % 3600
                for pool in snap.get("pools") or []:
                    free, any_free = pool_free(pool)
                    c.execute(
                        """INSERT INTO pool_hourly (hour,pool,n,free_n,free_sum) VALUES (?,?,1,?,?)
                           ON CONFLICT(hour,pool) DO UPDATE SET
                             n = n+1, free_n = free_n + excluded.free_n,
                             free_sum = free_sum + excluded.free_sum""",
                        (hour, pool.get("id", ""), any_free, free))

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
                        d_state,detail)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
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
                        json.dumps({
                            "io": node.get("io"),
                            "top_cpu": (node.get("processes") or {}).get("top_cpu", []),
                            "top_mem": (node.get("processes") or {}).get("top_mem", []),
                            "users": node.get("users", []),
                        }),
                    ),
                )

    def record_visit(self, visitor, ts):
        """Count one page entry for an anonymous visitor hash, bucketed by local day."""
        day = time.strftime("%Y-%m-%d", time.localtime(ts))
        c = self._conn()
        with c:
            c.execute(
                """INSERT INTO visits (day, visitor, hits) VALUES (?, ?, 1)
                   ON CONFLICT(day, visitor) DO UPDATE SET hits = hits + 1""",
                (day, visitor))

    def visitor_id(self, ip, user_agent):
        """Installation-keyed pseudonymous visitor id; raw network data is never stored."""
        payload = f"{ip}\0{user_agent}".encode()
        return hashlib.blake2b(payload, key=bytes.fromhex(self._visitor_salt), digest_size=16).hexdigest()

    def _meta_secret(self, key):
        c = self._conn()
        row = c.execute("SELECT value FROM app_meta WHERE key = ?", (key,)).fetchone()
        if row:
            return row["value"]
        value = secrets.token_hex(32)
        with c:
            c.execute("INSERT OR IGNORE INTO app_meta (key,value) VALUES (?,?)", (key, value))
        return c.execute("SELECT value FROM app_meta WHERE key = ?", (key,)).fetchone()["value"]

    def pool_hours(self, since):
        """[(hour, pool, n, free_n)] from `since` on."""
        c = self._conn()
        return [tuple(r) for r in c.execute(
            "SELECT hour,pool,n,free_n FROM pool_hourly WHERE hour >= ? ORDER BY hour", (since,))]

    # ---- job accounting history (sacct) ----------------------------------------
    def user_key(self, user):
        """Installation-keyed pseudonym of a login name (stable, not reversible)."""
        return hashlib.blake2b(str(user).encode(), key=self._user_key, digest_size=8).hexdigest()

    def upsert_jobs(self, rows):
        """Insert or refresh sacct rows (job_history.parse_sacct dicts, the latest
        record of each job); returns the count stored as the job's row.

        A requeued job has one record per run, and windows can deliver them in
        any order, so the row always holds the newest run: a stored run that an
        incoming newer one supersedes moves to job_attempts, and an incoming
        older run goes there directly instead of overwriting the row."""
        if not rows:
            return 0
        c = self._conn()
        with c:
            existing = {}
            ids = [r["id"] for r in rows]
            for i in range(0, len(ids), 500):
                chunk = ids[i:i + 500]
                for e in c.execute(
                        f'SELECT id,start,"end",user,partition,submit,cpus,gpus FROM jobs '
                        f'WHERE id IN ({",".join("?" * len(chunk))}) AND start IS NOT NULL', chunk):
                    existing[e["id"]] = tuple(e)
            keep, attempts = [], []
            for r in rows:
                e = existing.get(r["id"])
                start = r.get("start")
                if e is None or start == e[1]:
                    keep.append(r)
                elif start is not None and start < e[1]:
                    # an older run arriving late: it ended by the time the stored one began
                    ends = [t for t in (r.get("end"), e[1]) if t]
                    attempts.append((r["id"], start, max(start, min(ends)), self.user_key(r["user"]),
                                     r.get("partition"), r.get("submit"), r.get("cpus"), r.get("gpus")))
                else:
                    # newer run (or requeued and pending again): the stored run is history
                    jid, old_start, old_end, user, part, submit, cpus, gpus = e
                    ends = [t for t in (old_end, start) if t]
                    attempts.append((jid, old_start, max(old_start, min(ends)) if ends else old_start,
                                     user, part, submit, cpus, gpus))
                    keep.append(r)
            if attempts:
                c.executemany('INSERT OR REPLACE INTO job_attempts VALUES (?,?,?,?,?,?,?,?)', attempts)
            cols = ",".join(f'"{k}"' for k in JOB_COLUMNS)
            updates = ",".join(f'"{k}"=excluded."{k}"' for k in JOB_COLUMNS if k != "id")
            c.executemany(
                f"INSERT INTO jobs ({cols}) VALUES ({','.join('?' * len(JOB_COLUMNS))}) "
                f"ON CONFLICT(id) DO UPDATE SET {updates}",
                [tuple(self.user_key(r["user"]) if k == "user" else r.get(k) for k in JOB_COLUMNS)
                 for r in keep])
        return len(keep)

    def upsert_attempts(self, rows):
        """Earlier runs of requeued jobs (job_history.split_attempts dicts)."""
        values = [(r["id"], r["start"], r["end"], self.user_key(r["user"]), r.get("partition"),
                   r.get("submit"), r.get("cpus"), r.get("gpus")) for r in rows if r.get("start")]
        if values:
            c = self._conn()
            with c:
                c.executemany('INSERT OR REPLACE INTO job_attempts VALUES (?,?,?,?,?,?,?,?)', values)
        return len(values)

    def stale_ids(self, ids):
        """The subset of `ids` stored as STALE."""
        out = set()
        c = self._conn()
        ids = list(ids)
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            out.update(r["id"] for r in c.execute(
                f"SELECT id FROM jobs WHERE state = 'STALE' AND id IN ({','.join('?' * len(chunk))})", chunk))
        return out

    def mark_stale(self, ids):
        """Jobs sacct no longer returns although they were left pending/running."""
        if not ids:
            return
        c = self._conn()
        with c:
            for i in range(0, len(ids), 500):
                chunk = list(ids[i:i + 500])
                c.execute(f'UPDATE jobs SET state = \'STALE\', "end" = start, elapsed = 0 '
                          f'WHERE id IN ({",".join("?" * len(chunk))})', chunk)

    def window_attempts(self, since):
        """[(user, partition, start, end, cpus, gpus)] of earlier runs of jobs submitted since `since`."""
        c = self._conn()
        return [tuple(r) for r in c.execute(
            'SELECT user,partition,start,"end",cpus,gpus FROM job_attempts WHERE submit >= ?', (since,))]

    def jobs_window(self, since):
        """Every job submitted at or after `since`, as tuples in JOB_COLUMNS order.

        Repeated strings (user keys, partitions, states) are interned: a 90-day
        window holds a few hundred thousand rows but only a few hundred distinct
        values, and sqlite hands out a fresh copy of each one per row."""
        cols = ",".join(f'"{k}"' for k in JOB_COLUMNS)
        c = self._conn()
        intern = sys.intern
        return [tuple(intern(v) if isinstance(v, str) else v for v in r) for r in c.execute(
            f"SELECT {cols} FROM jobs WHERE submit >= ? ORDER BY id", (since,))]

    def iter_job_history(self):
        """Stream (user, partition, submit, start, end, cpus, gpus) over every stored
        job and every earlier run of a requeued job."""
        c = self._conn()
        for table in ("jobs", "job_attempts"):
            cur = c.execute(f'SELECT user,partition,submit,start,"end",cpus,gpus FROM {table}')
            while True:
                chunk = cur.fetchmany(20000)
                if not chunk:
                    break
                for r in chunk:
                    yield tuple(r)

    def active_jobs(self):
        """[(id, job_key, submit)] of rows sacct last reported as pending or running."""
        marks = ",".join("?" * len(ACTIVE_STATES))
        c = self._conn()
        return [tuple(r) for r in c.execute(
            f"SELECT id, job_key, submit FROM jobs WHERE state IN ({marks})", ACTIVE_STATES)]

    def job_stats(self):
        c = self._conn()
        r = c.execute("SELECT count(*) n, min(submit) a, max(submit) b FROM jobs").fetchone()
        return {"jobs": r["n"], "first_submit": r["a"], "last_submit": r["b"]}

    def meta_get(self, key, default=None):
        row = self._conn().execute("SELECT value FROM app_meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default

    def meta_set(self, key, value):
        c = self._conn()
        with c:
            c.execute("""INSERT INTO app_meta (key,value) VALUES (?,?)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value""", (key, str(value)))

    def prune(self, now):
        cutoff = int(now) - self.retain_days * 86400
        login_cutoff = int(now) - self.login_retain_days * 86400
        visit_cutoff = time.strftime(
            "%Y-%m-%d", time.localtime(int(now) - max(self.visit_retain_days - 1, 0) * 86400)
        )
        c = self._conn()
        with c:
            c.execute("DELETE FROM samples WHERE ts < ?", (cutoff,))
            c.execute("DELETE FROM login_samples WHERE ts < ?", (login_cutoff,))
            # "累计访问次数" is all-time: bank pruned hits before deleting them,
            # or the total silently becomes a trailing-365-day count
            c.execute(
                """INSERT INTO app_meta (key, value)
                   SELECT 'pruned_visit_hits', CAST(coalesce(sum(hits), 0) AS TEXT)
                   FROM visits WHERE day < ?
                   ON CONFLICT(key) DO UPDATE SET
                     value = CAST(CAST(value AS INTEGER) + CAST(excluded.value AS INTEGER) AS TEXT)""",
                (visit_cutoff,))
            c.execute("DELETE FROM visits WHERE day < ?", (visit_cutoff,))
            job_cutoff = int(now) - self.job_retain_days * 86400
            c.execute('DELETE FROM jobs WHERE coalesce("end", start, submit) < ?', (job_cutoff,))
            c.execute('DELETE FROM job_attempts WHERE coalesce("end", start) < ?', (job_cutoff,))

    # ---- read --------------------------------------------------------------
    def login_history(self, since, until, max_points=600):
        c = self._conn()
        rows = c.execute(
            """SELECT ts,node_id,load1,load_per_core,cpu_busy,cpu_iowait,
                      mem_used_ratio,swap_used_ratio,disk_used_max,inode_used_max,
                      d_state
               FROM login_samples WHERE ts BETWEEN ? AND ? ORDER BY ts,node_id""",
            (since, until)).fetchall()
        by_node = {}
        for r in rows:
            by_node.setdefault(r["node_id"], []).append(r)
        if not by_node or max_points <= 0:
            return []
        node_ids = sorted(by_node)
        base, extra = divmod(max_points, len(node_ids))
        out = []
        for i, node_id in enumerate(node_ids):
            budget = base + (1 if i < extra else 0)
            if budget <= 0:
                continue
            out.extend(dict(r) for r in _evenly_sample(by_node[node_id], budget))
        out.sort(key=lambda r: (r["ts"], r["node_id"]))
        return out

    def visit_stats(self, days=30, now=None):
        """Daily unique visitors / hits for the last `days` local days, plus totals."""
        now = int(now or time.time())
        today = time.strftime("%Y-%m-%d", time.localtime(now))
        first_day = time.strftime("%Y-%m-%d", time.localtime(now - (days - 1) * 86400))
        c = self._conn()
        rows = c.execute(
            """SELECT day, count(*) AS visitors, sum(hits) AS hits
               FROM visits WHERE day >= ? GROUP BY day ORDER BY day""",
            (first_day,)).fetchall()
        by_day = {r["day"]: r for r in rows}
        daily = []
        for i in range(days - 1, -1, -1):
            day = time.strftime("%Y-%m-%d", time.localtime(now - i * 86400))
            r = by_day.get(day)
            daily.append({"day": day,
                          "visitors": r["visitors"] if r else 0,
                          "hits": r["hits"] if r else 0})
        totals = c.execute(
            """SELECT count(DISTINCT visitor) AS visitors,
                      coalesce(sum(hits), 0) AS hits,
                      min(day) AS since
               FROM visits""").fetchone()
        window = c.execute(
            """SELECT count(DISTINCT visitor) AS visitors,
                      coalesce(sum(hits), 0) AS hits
               FROM visits WHERE day >= ?""", (first_day,)).fetchone()
        today_row = by_day.get(today)
        pruned = c.execute(
            "SELECT value FROM app_meta WHERE key = 'pruned_visit_hits'").fetchone()
        totals = dict(totals)
        totals["hits"] += int(pruned["value"]) if pruned else 0
        return {"days": days, "daily": daily,
                "today": {"visitors": today_row["visitors"] if today_row else 0,
                          "hits": today_row["hits"] if today_row else 0},
                "window": dict(window),
                "total": totals}

    def stats(self):
        c = self._conn()
        s = c.execute("SELECT count(*) n, min(ts) a, max(ts) b FROM samples").fetchone()
        l = c.execute("SELECT count(*) n FROM login_samples").fetchone()
        return {"samples": s["n"], "first_ts": s["a"], "last_ts": s["b"],
                "login_samples": l["n"],
                "retain_days": self.retain_days,
                "login_retain_days": self.login_retain_days,
                "visit_retain_days": self.visit_retain_days,
                "job_retain_days": self.job_retain_days,
                "jobs": c.execute("SELECT count(*) n FROM jobs").fetchone()["n"],
                "schema_version": SCHEMA_VERSION}

    def close(self):
        c = getattr(self._local, "conn", None)
        if c is not None:
            c.close()
            self._local.conn = None


def _evenly_sample(rows, max_points):
    """Return <= max_points evenly-spaced rows, always preserving both endpoints."""
    n = len(rows)
    if max_points <= 0 or n == 0:
        return []
    if n <= max_points:
        return list(rows)
    if max_points == 1:
        return [rows[-1]]
    indices = [round(i * (n - 1) / (max_points - 1)) for i in range(max_points)]
    # round() can theoretically collide; retain order and fill any gap from the
    # right while keeping the final row authoritative.
    unique = list(dict.fromkeys(indices))
    if len(unique) < max_points:
        for i in range(n - 1, -1, -1):
            if i not in unique:
                unique.append(i)
            if len(unique) == max_points:
                break
        unique.sort()
    return [rows[i] for i in unique]
