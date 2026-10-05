"""Job accounting history (sacct) for the analytics page.

One compact row per job allocation (`sacct -X`). The collector backfills the
retention window once in 30-day chunks, then re-reads a short window on every
run: without `--state`, sacct returns every job that was pending, running or
ending inside [start, end], so re-reading from the previous run (minus a margin)
picks up each state change and the upsert keeps one row per job.

SubmitLine is cut on the cluster to its first word (sbatch / salloc / srun):
script text and paths never leave the cluster, and multi-line or pipe-holding
submit lines cannot break the row format. User names are hashed in the store.
"""
from __future__ import annotations
import json, os, re, time

from datetime import datetime

try:                       # flat import when run as `python3 backend/server.py`
    from sources import CLUSTER_TZ, _epoch
    from store import ACTIVE_STATES
except ImportError:        # package import in tests
    from backend.sources import CLUSTER_TZ, _epoch
    from backend.store import ACTIVE_STATES

FIELDS = ("JobID", "JobIDRaw", "User", "Partition", "Submit", "Eligible", "Start", "End",
          "ElapsedRaw", "TimelimitRaw", "State", "NNodes", "NCPUS", "ReqTRES", "AllocTRES",
          "SubmitLine")
CONFIG_MARK = "@@HM-CFG@@"
INTERACTIVE_COMMANDS = {"salloc", "srun"}
_TRES_GPU = re.compile(r"^gres/gpu(?::([^=]+))?$")


def sacct_script(start, end, with_config=False):
    """Shell snippet that prints one `|`-joined row per allocation in [start, end].

    `start`/`end` are sacct time specs (`2026-10-01T00:00:00`, `now-30days`, `now`).
    awk keeps the first 15 fields as they are and reduces field 16 (SubmitLine,
    which may itself contain `|`) to its first word; continuation lines of a
    multi-line SubmitLine have fewer fields and are dropped.
    """
    n = len(FIELDS)
    cols = ",".join(f"${i}" for i in range(1, n))
    awk = f"awk -F'|' -v OFS='|' 'NF>={n} {{ split(${n}, w, \" \"); print {cols}, w[1] }}'"
    # pipefail: a failing sacct must fail the run, not look like an empty window
    # -D: a requeued job keeps one record per run; without it sacct prints only
    # the last run and the earlier runs' resource-hours would be lost
    cmd = f"set -o pipefail; sacct -aX -D -n -P -S {start} -E {end} -o {','.join(FIELDS)} | {awk} || exit $?"
    if with_config:
        cmd += (f"; echo {CONFIG_MARK}; "
                "(scontrol show config 2>/dev/null"
                " | grep -E '^(Priority(Type|Weight[A-Za-z]+)|SchedulerType) ' || true)")
    return cmd


def sacct_jobs_script(keys):
    """Like sacct_script(), for named jobs and without a time window: sacct then
    reports each job's latest record instead of the one active in a window."""
    n = len(FIELDS)
    cols = ",".join(f"${i}" for i in range(1, n))
    awk = f"awk -F'|' -v OFS='|' 'NF>={n} {{ split(${n}, w, \" \"); print {cols}, w[1] }}'"
    return f"set -o pipefail; sacct -aX -D -n -P -j {','.join(keys)} -o {','.join(FIELDS)} | {awk} || exit $?"


def live_index(snap):
    """squeue's view of what is pending or running: (job ids, array masters,
    snapshot time), or None when no fresh snapshot is at hand."""
    if not snap or snap.get("stale") or not isinstance(snap.get("jobs"), list):
        return None
    keys = {str(j.get("job_id")) for j in snap["jobs"] if j.get("job_id") is not None}
    masters = {k.split("_", 1)[0] for k in keys if "_" in k}
    return keys, masters, int(snap.get("generated_at") or 0)


def is_live(job_key, submit, index):
    """Is a job sacct calls pending/running really in the queue? A pending array
    remainder ("120_[4-9]") counts while any task of its array is queued; a job
    submitted after the snapshot is too new to judge."""
    keys, masters, at = index
    key = str(job_key or "")
    if key in keys:
        return True
    if "_[" in key and key.split("_", 1)[0] in masters:
        return True
    return (submit or 0) >= at - 60


def split_attempts(rows):
    """sacct -D rows -> (latest record per job, earlier runs).

    sacct prints a job's records oldest first. The last one is the job as it
    stands; each earlier run becomes an attempt that ends where it ended, or
    where the next run started when its record was never closed."""
    by_id = {}
    for r in rows:
        by_id.setdefault(r["id"], []).append(r)
    latest, attempts = [], []
    for records in by_id.values():
        # oldest run first; a record that has not started (requeued, waiting) is the newest
        records.sort(key=lambda x: (x["start"] is None, x["start"] or 0))
        latest.append(records[-1])
        for i, r in enumerate(records[:-1]):
            if not r["start"]:
                continue
            nxt = next((x["start"] for x in records[i + 1:] if x["start"]), None)
            ends = [t for t in (r["end"], nxt) if t]
            attempts.append({**r, "end": max(r["start"], min(ends)) if ends else r["start"]})
    return latest, attempts


def _mark_stale(row):
    """A record sacct never closed: keep the job, count none of its run time."""
    return {**row, "state": "STALE", "end": row["start"], "elapsed": 0}


def cluster_time(ts):
    """Epoch seconds -> sacct time spec in the cluster's zone (sacct reads -S/-E as local)."""
    dt = datetime.fromtimestamp(int(ts), CLUSTER_TZ) if CLUSTER_TZ else datetime.fromtimestamp(int(ts))
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def split_output(text):
    """(sacct text, scontrol-config text) of one sacct_script() run."""
    if CONFIG_MARK in text:
        jobs, cfg = text.split(CONFIG_MARK, 1)
        return jobs, cfg
    return text, ""


def parse_priority_config(text):
    """`PriorityWeightFairShare = 10000` lines -> {"type": "priority/multifactor",
    "scheduler": "sched/backfill", "weights": {"FairShare": 10000, ...}};
    {} when nothing was printed."""
    out = {"type": "", "scheduler": "", "weights": {}}
    for line in text.splitlines():
        if "=" not in line:
            continue
        key, value = (s.strip() for s in line.split("=", 1))
        if key == "PriorityType":
            out["type"] = value
        elif key == "SchedulerType":
            out["scheduler"] = value
        elif key.startswith("PriorityWeight"):
            name = key[len("PriorityWeight"):]
            try:
                out["weights"][name] = int(value)
            except ValueError:
                pass    # PriorityWeightTRES = (null) and similar
    return out if (out["type"] or out["scheduler"] or out["weights"]) else {}


def _int(s):
    try:
        return int(s)
    except (TypeError, ValueError):
        return None


def _ts(s):
    """Cluster-local sacct time -> epoch seconds; None for Unknown/None/blank."""
    if not s or not s[0].isdigit():
        return None
    return _epoch(s) or None


def _mem_mb(v):
    m = re.match(r"^([\d.]+)([KMGTP]?)$", v or "")
    if not m:
        return None
    scale = {"K": 1 / 1024, "": 1, "M": 1, "G": 1024, "T": 1024 ** 2, "P": 1024 ** 3}[m.group(2)]
    return int(round(float(m.group(1)) * scale))


def _tres(s):
    """'cpu=4,gres/gpu:nvidia_a40=1,gres/gpu=1,mem=64G' -> (cpus, gpus, gpu_type, mem_mb)."""
    cpus, gpus, gtype, mem = None, 0, None, None
    for kv in (s or "").split(","):
        if "=" not in kv:
            continue
        k, v = kv.split("=", 1)
        g = _TRES_GPU.match(k)
        if g:
            gpus = max(gpus, _int(v) or 0)
            if g.group(1):
                gtype = g.group(1)
        elif k == "cpu":
            cpus = _int(v)
        elif k == "mem":
            mem = _mem_mb(v)
    return cpus, gpus, gtype, mem


def parse_sacct(text):
    """sacct_script() output -> list of job dicts (one per allocation)."""
    rows = []
    n = len(FIELDS)
    for line in text.splitlines():
        parts = line.split("|")
        if len(parts) != n or not parts[1].isdigit():
            continue
        (jobid, raw, user, part, submit, eligible, start, end, elapsed, limit,
         state, nnodes, ncpus, req, alloc, command) = parts
        alloc_cpus, alloc_gpus, alloc_type, alloc_mem = _tres(alloc)
        req_cpus, req_gpus, req_type, req_mem = _tres(req)
        started = _ts(start)
        array_id = _int(re.split(r"[_+]", jobid, maxsplit=1)[0]) or int(raw)
        rows.append({
            "job_key": jobid,
            "id": int(raw),
            "array_id": array_id,
            "user": user,
            "partition": part,
            "submit": _ts(submit),
            "eligible": _ts(eligible),
            "start": started,
            "end": _ts(end),
            "elapsed": _int(elapsed) or 0,
            "timelimit": _int(limit),           # minutes; None for UNLIMITED / Partition_Limit
            "state": (state.split() or [""])[0],
            "nodes": _int(nnodes) or 0,
            # what the job holds once running; what it asks for while pending
            # (NCPUS reads 0 for a pending job, its ReqTRES still has cpu=)
            "cpus": (alloc_cpus or _int(ncpus) or 0) if started else (req_cpus or _int(ncpus) or 0),
            "gpus": alloc_gpus if started else req_gpus,
            "gpu_type": (alloc_type if started else req_type) or alloc_type or req_type,
            "mem_mb": (alloc_mem if started else req_mem) or req_mem,
            "interactive": int(os.path.basename(command) in INTERACTIVE_COMMANDS),
        })
    return rows


class JobHistoryCollector:
    """Background thread: keeps the jobs table current and the analytics fresh.

    First run backfills the retention window in 30-day sacct chunks (progress is
    saved, so a restart resumes). Afterwards every `interval` seconds it re-reads
    the window since the previous run, and recomputes the analytics payload every
    `analytics_interval` seconds. The last payload is cached in the store so a
    restart serves it at once instead of an empty page.
    """
    CHUNK_DAYS = 30
    CHUNK_PAUSE_S = 2
    MARGIN_S = 300

    def __init__(self, source, store, snapshot_fn, compute_fn, interval=600, retain_days=400,
                 analytics_interval=1800):
        self.source = source
        self.store = store
        self.snapshot_fn = snapshot_fn
        self.compute_fn = compute_fn        # (store, snapshot, priority, now) -> payload
        self.interval = interval
        self.retain_days = retain_days
        self.analytics_interval = analytics_interval
        self.status = "idle" if source.mode != "mock" else "unavailable"
        self.error = None
        self.progress = None
        self.computed_at = 0
        self.result = None
        try:
            cached = store.meta_get("analytics_cache")
            self.result = json.loads(cached) if cached else None
        except ValueError:
            self.result = None

    @property
    def enabled(self):
        return self.source.mode != "mock"

    def run(self):
        while True:
            t0 = time.time()
            try:
                self.step(t0)
                self.error = None
            except Exception as e:      # keep serving the last payload; retry next cycle
                self.error = str(e)
                print(f"job history failed: {e}", flush=True)
            # no payload yet (first start, or no snapshot to read pools from): retry soon
            wait = 30.0 if self.result is None else self.interval - (time.time() - t0)
            time.sleep(max(30.0, wait))

    def step(self, now):
        if not self.enabled:
            return
        if not self.store.meta_get("jobs_backfill_done"):
            self._backfill(now)
        self._incremental(time.time())
        if self.result is None or now - self.computed_at >= self.analytics_interval:
            self.refresh(time.time())

    def _fetch(self, start, end, with_config=False, timeout=180):
        out = self.source._exec(
            sacct_script(cluster_time(start), cluster_time(end), with_config), timeout=timeout)
        jobs, cfg = split_output(out)
        latest, attempts = split_attempts(parse_sacct(jobs))
        latest, more = self._settle(latest)
        self.store.upsert_attempts(attempts + more)
        n = self.store.upsert_jobs(latest)
        if with_config:
            prio = parse_priority_config(cfg)
            if prio:
                self.store.meta_set("slurm_priority", json.dumps(prio))
        return n

    def _settle(self, rows):
        """Replace "running"/"pending" rows that squeue no longer has.

        A windowed sacct returns the record that was open inside the window. A
        job whose node failed can keep such a record open forever (a runaway
        job), and every later window then shows it running. Those jobs are
        re-read without a window; if even their latest record is still open,
        the row is kept as STALE with no run time, so it adds no resource-hours.
        Returns (rows, earlier runs found by the re-read).
        """
        index = live_index(self.snapshot_fn())
        if index is None:
            # no squeue to check against: never let a row already judged STALE
            # come back as running (its open record would count hours until now)
            known = self.store.stale_ids([r["id"] for r in rows if r["state"] in ACTIVE_STATES])
            return [r for r in rows if r["id"] not in known], []
        stale = {r["id"]: r for r in rows
                 if r["state"] in ACTIVE_STATES and not is_live(r["job_key"], r["submit"], index)}
        if not stale:
            return rows, []
        latest, attempts = split_attempts(self._reread(r["job_key"] for r in stale.values()))
        latest = {r["id"]: r for r in latest}
        out = [r for r in rows if r["id"] not in stale]
        # every re-read job (an array's master brings its siblings), stale ones marked
        for r in latest.values():
            out.append(_mark_stale(r) if r["state"] in ACTIVE_STATES
                       and not is_live(r["job_key"], r["submit"], index) else r)
        out += [_mark_stale(r) for jid, r in stale.items() if jid not in latest]
        return out, attempts

    def _reread(self, keys):
        """Every sacct record (no time window) of the given jobs, oldest first."""
        # a pending array remainder ("120_[4-9]") is looked up by its master id
        wanted = sorted({k.split("_", 1)[0] if "[" in k else k for k in keys if k})
        rows = []
        for i in range(0, len(wanted), 200):
            rows += parse_sacct(self.source._exec(sacct_jobs_script(wanted[i:i + 200]), timeout=120))
        return rows

    def _sweep(self):
        """Settle rows already stored as pending/running that squeue no longer has;
        jobs sacct no longer returns at all (purged) are kept as STALE."""
        index = live_index(self.snapshot_fn())
        if index is None:
            return
        stale = [(jid, key) for jid, key, submit in self.store.active_jobs()
                 if not is_live(key, submit, index)]
        if not stale:
            return
        latest, attempts = split_attempts(self._reread(key for _, key in stale))
        latest = [_mark_stale(r) if r["state"] in ACTIVE_STATES
                  and not is_live(r["job_key"], r["submit"], index) else r for r in latest]
        self.store.upsert_attempts(attempts)
        self.store.upsert_jobs(latest)
        seen = {r["id"] for r in latest}
        self.store.mark_stale([jid for jid, _ in stale if jid not in seen])

    def _backfill(self, now):
        now = int(now)       # whole seconds throughout: the loop must reach `now` exactly
        since = now - self.retain_days * 86400
        start = max(int(float(self.store.meta_get("jobs_backfill_until", 0) or 0)), since)
        while start < now:
            end = min(now, start + self.CHUNK_DAYS * 86400)
            self.status = "backfilling"
            self.progress = {"from": start, "to": end, "since": since}
            self._fetch(start, end, timeout=600)
            self.store.meta_set("jobs_backfill_until", end)
            start = end
            time.sleep(self.CHUNK_PAUSE_S)   # one chunk at a time, gently, for slurmdbd
        self.store.meta_set("jobs_fetched_at", now)
        self.store.meta_set("jobs_backfill_done", 1)
        self.progress = None

    def _incremental(self, now):
        now = int(now)
        last = int(float(self.store.meta_get("jobs_fetched_at", 0) or 0)) or now - 3600
        # after a long outage, catch up chunk by chunk (each chunk saved) rather
        # than asking slurmdbd for the whole gap in one query
        while now - last > self.CHUNK_DAYS * 86400:
            end = last + self.CHUNK_DAYS * 86400
            self._fetch(last - self.MARGIN_S, end, timeout=600)
            self.store.meta_set("jobs_fetched_at", end)
            last = end
            time.sleep(self.CHUNK_PAUSE_S)
        config_due = now - float(self.store.meta_get("slurm_priority_at", 0) or 0) >= 86400
        self._fetch(last - self.MARGIN_S, now, with_config=config_due)
        self._sweep()
        if config_due:
            self.store.meta_set("slurm_priority_at", int(now))
        self.store.meta_set("jobs_fetched_at", int(now))
        self.status = "ready"

    def refresh(self, now):
        snap = self.snapshot_fn()
        if not snap:
            return
        try:
            prio = json.loads(self.store.meta_get("slurm_priority") or "{}")
        except ValueError:
            prio = {}
        result = self.compute_fn(self.store, snap, prio, int(now))
        result["fetched_at"] = int(float(self.store.meta_get("jobs_fetched_at", 0) or 0))
        self.result = result
        self.computed_at = now
        self.store.meta_set("analytics_cache", json.dumps(result, separators=(",", ":")))

    def payload(self):
        if self.result is not None:
            return {"status": "ready", **self.result,
                    "collecting": self.status == "backfilling", "error": self.error}
        status = ("unavailable" if not self.enabled
                  else "backfilling" if self.status == "backfilling" else "idle")
        return {"status": status, "progress": self.progress, "error": self.error}
