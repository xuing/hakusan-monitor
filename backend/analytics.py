"""Analytics over the stored job history — pure functions, no I/O.

Every share and quantile weights each *user* equally inside the group it
describes. A handful of accounts submit tens of thousands of jobs (arrays,
parameter sweeps, retry loops); raw job counts would describe their scripts,
not the people using the cluster. Resource-hours (GPU·h / core·h) are the one
exception: they are summed as-is, because there the volume is the point.

Inputs are plain tuples so the module stays independent of SQLite:
  window_rows   jobs submitted in the analysis window, in store.JOB_COLUMNS order
  history_rows  (user, partition, submit, start, end, cpus, gpus) for every job
  free_rows     (hour, pool, samples, samples_with_something_free) from pool_hourly
"""
from __future__ import annotations
import bisect
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from functools import lru_cache

try:                       # flat import when run as `python3 backend/server.py`
    from store import ACTIVE_STATES, JOB_COLUMNS
except ImportError:        # package import in tests
    from backend.store import ACTIVE_STATES, JOB_COLUMNS

C = {name: i for i, name in enumerate(JOB_COLUMNS)}

WINDOW_DAYS = 90
WAIT_BOUNDS = (60, 3600, 6 * 3600, 86400)                  # 5 buckets: <1m … >1d
LIMIT_RATIO_BOUNDS = (0.05, 0.10, 0.25, 0.50, 0.75)  # 6 ratio bins, then a 7th: Slurm ended it (TIMEOUT)
LIMIT_START_BOUNDS = (60, 360, 1440, 4320)                 # --time minutes: ≤1h … >3d
RUNTIME_BOUNDS = (60, 600, 3600, 6 * 3600, 86400, 3 * 86400)
UNIT_BOUNDS = {"gpu": (1, 2), "cpu": (1, 16, 64, 256)}     # GPUs / cores per job
CONC_GROUPS = ((1, 1), (2, 5), (6, 10), (11, 20))          # then "everyone else"
MIN_PARTITION_USERS = 3     # a partition row needs this many users in the window
MIN_CELL_USERS = 5          # a limit-vs-start bar needs this many users
UTIL_WEEKS = 13             # KPI: mean weekly occupancy over the last 13 full weeks
ACTIVE = ACTIVE_STATES
UNSETTLED = ACTIVE + ("STALE",)   # STALE: sacct never closed the record (job_history._settle)
FAILED = ("FAILED", "NODE_FAIL", "BOOT_FAIL", "DEADLINE")
CANCELLED = ("CANCELLED", "PREEMPTED", "REVOKED")


# --------------------------------------------------------------------------- #
#  helpers
# --------------------------------------------------------------------------- #
def bucket(value, bounds):
    """Index of the first bound `value` is below; len(bounds) if none."""
    return bisect.bisect_right(bounds, value or 0)


def _first_le(value, bounds):
    """Index of the first bound `value` is <= (≤1h, ≤6h, …); len(bounds) past all."""
    return bisect.bisect_left(bounds, value)


def weighted_shares(items, n_buckets):
    """items: [(user, bucket)] -> share per bucket, each user's items summing to 1."""
    per = Counter(u for u, _ in items)
    acc = [0.0] * n_buckets
    for u, b in items:
        acc[b] += 1 / per[u]
    total = sum(acc)
    return [round(a / total, 4) for a in acc] if total else [0.0] * n_buckets


def weighted_quantile(items, q):
    """items: [(user, value)] -> q-quantile with every user weighing the same."""
    if not items:
        return None
    per = Counter(u for u, _ in items)
    pairs = sorted((v, 1 / per[u]) for u, v in items)
    target = q * sum(w for _, w in pairs)
    acc = 0.0
    for v, w in pairs:
        acc += w
        if acc >= target - 1e-12:
            return v
    return pairs[-1][0]


def weighted_share(items, pred):
    """items: [(user, value)] -> user-weighted share of values where pred(value)."""
    if not items:
        return None
    per = Counter(u for u, _ in items)
    hit = sum(1 / per[u] for u, v in items if pred(v))
    return round(hit / len(per), 4)


class LocalClock:
    """Epoch -> cluster-local (date, weekday, hour), memoised per hour."""

    def __init__(self, tz):
        self.tz = tz
        self._parts = lru_cache(maxsize=1 << 16)(self._compute)

    def _compute(self, hour_ts):
        dt = datetime.fromtimestamp(hour_ts * 3600, self.tz)
        return dt.date(), dt.weekday(), dt.hour

    def parts(self, ts):
        return self._parts(int(ts) // 3600)

    def midnight(self, d):
        return int(datetime(d.year, d.month, d.day, tzinfo=self.tz).timestamp()) if self.tz \
            else int(datetime(d.year, d.month, d.day).timestamp())


# --------------------------------------------------------------------------- #
#  entry point
# --------------------------------------------------------------------------- #
def compute(window_rows, history_rows, free_rows, ctx, window_attempts=()):
    """Everything the analytics page shows, for the GPU and the CPU view.

    ctx keys:
      now, tz, window_days
      part_pool        {partition: pool id}              (snapshot part_pool)
      pools            [{id, kind, label, units, nodes, down, partitions}]
      caps             {partition: {"wall_min", "max_units", "max_cores"}}
      interactive_cap  {partition: minutes}               (job_submit.lua)
      priority         {"type", "weights"}                (scontrol show config)
    """
    now = int(ctx["now"])
    clock = LocalClock(ctx.get("tz"))
    window_days = ctx.get("window_days", WINDOW_DAYS)
    pools = {p["id"]: p for p in ctx.get("pools", [])}
    part_pool = ctx.get("part_pool", {})

    memo = {}

    def pool_of(partition):
        # a pending job may list several partitions; it is counted under the first
        pid = memo.get(partition, memo)
        if pid is memo:
            pid = memo[partition] = part_pool.get((partition or "").split(",")[0])
        return pid

    by_kind = defaultdict(list)
    for r in window_rows:
        pid = pool_of(r[C["partition"]])
        if pid in pools:
            by_kind[pools[pid]["kind"]].append((pid, r))

    history = _history(history_rows, ctx.get("history_since"), pools, pool_of, clock, now)
    # once retention has pruned the oldest jobs, the first retained month would
    # count every surviving user as new
    retain = ctx.get("retain_days")
    history["truncated"] = bool(retain and history["since"]
                                and history["since"] < now - (retain - 31) * 86400)
    # earlier runs of requeued jobs: resource-hours only (they are not jobs of their own)
    attempts_by_kind = defaultdict(list)
    for user, partition, start, end, cpus, gpus in window_attempts:
        pid = pool_of(partition)
        if pid in pools and start and end and end > start:
            kind = pools[pid]["kind"]
            units = (gpus if kind == "gpu" else cpus) or 0
            attempts_by_kind[kind].append((user, partition, units * (end - start) / 3600))
    out = {"generated_at": now, "window_days": window_days,
           "priority": ctx.get("priority") or {}, "outages": history["outages"],
           "history_since": history["since"], "history_truncated": history["truncated"],
           "thresholds": {"partition_users": MIN_PARTITION_USERS, "cell_users": MIN_CELL_USERS}}
    for kind in ("gpu", "cpu"):
        kind_pools = [p for p in ctx.get("pools", []) if p["kind"] == kind]
        out[kind] = _kind(kind, kind_pools, by_kind.get(kind, []), history, free_rows,
                          ctx, clock, now, window_days, attempts_by_kind.get(kind, []))
    return out


# --------------------------------------------------------------------------- #
#  long history: weekly occupancy, weekly users, first-seen month, outages
# --------------------------------------------------------------------------- #
def _history(history_rows, first_ts, pools, pool_of, clock, now):
    """One streaming pass over every stored job; `first_ts` (the oldest submit
    time, from the store) fixes the week grid before the pass starts."""
    if not first_ts:
        return {"since": None, "weeks": [], "partial": False, "util": {}, "users": {},
                "first_seen": {}, "outages": []}
    week_starts = []
    d0 = clock.parts(first_ts)[0]
    monday = d0 - timedelta(days=d0.weekday())
    today = clock.parts(now)[0]
    while monday <= today:
        week_starts.append(clock.midnight(monday))
        monday += timedelta(days=7)

    unit_hours = defaultdict(lambda: defaultdict(float))     # pool -> week index -> unit·h
    week_users = defaultdict(lambda: defaultdict(set))       # kind -> week index -> users
    first_seen = defaultdict(dict)                           # kind -> user -> first submit
    start_days = set()
    n_weeks = len(week_starts)
    for user, partition, submit, start, end, cpus, gpus in history_rows:
        if start:
            start_days.add(clock.parts(start)[0])
        pid = pool_of(partition)
        if pid not in pools:
            continue
        kind = pools[pid]["kind"]
        if submit:
            wi = bisect.bisect_right(week_starts, submit) - 1
            if wi >= 0:
                week_users[kind][wi].add(user)
            seen = first_seen[kind].get(user)
            if seen is None or submit < seen:
                first_seen[kind][user] = submit
        units = (gpus if kind == "gpu" else cpus) or 0
        if not start or units <= 0:
            continue
        t, t1 = start, min(end or now, now)
        wi = max(0, bisect.bisect_right(week_starts, t) - 1)
        while t < t1 and wi < n_weeks:
            nxt = week_starts[wi + 1] if wi + 1 < n_weeks else now
            seg_end = min(t1, nxt)
            if seg_end > t:
                unit_hours[pid][wi] += units * (seg_end - t) / 3600
            t = seg_end
            wi += 1

    util = {}
    for pid, p in pools.items():
        cap = p.get("units") or 0
        series = []
        for wi, ws in enumerate(week_starts):
            span = (week_starts[wi + 1] if wi + 1 < len(week_starts) else now) - ws
            series.append(round(min(1.0, unit_hours[pid][wi] / (cap * span / 3600)), 4)
                          if cap and span > 0 else None)
        util[pid] = series

    # days (first job → yesterday) on which no job of any kind started
    outages, run = [], None
    day = d0
    while day < today:
        if day not in start_days:
            run = [day, day] if run is None else [run[0], day]
        elif run is not None:
            outages.append([run[0].isoformat(), run[1].isoformat()])
            run = None
        day += timedelta(days=1)
    if run is not None:
        outages.append([run[0].isoformat(), run[1].isoformat()])

    return {"since": first_ts, "weeks": week_starts,
            "partial": bool(week_starts) and now - week_starts[-1] < 7 * 86400,
            "util": util,
            "users": {k: [len(v.get(i, ())) for i in range(len(week_starts))]
                      for k, v in week_users.items()},
            "first_seen": first_seen, "outages": outages}


# --------------------------------------------------------------------------- #
#  one view (GPU or CPU)
# --------------------------------------------------------------------------- #
def _kind(kind, kind_pools, rows, history, free_rows, ctx, clock, now, window_days, attempts=()):
    caps = ctx.get("caps", {})
    icap = ctx.get("interactive_cap", {})
    since = now - window_days * 86400
    pool_ids = [p["id"] for p in kind_pools]
    units_of = (lambda r: r[C["gpus"]] or 0) if kind == "gpu" else (lambda r: r[C["cpus"]] or 0)

    def hours(r):
        return units_of(r) * (r[C["elapsed"]] or 0) / 3600 if r[C["start"]] else 0.0

    def wait(r):
        return max(0, r[C["start"]] - (r[C["eligible"]] or r[C["submit"]]))

    # One "submission" per (user, array id). Its earliest-started task stands
    # for it — the array's master record can still be pending while other
    # tasks already run — or its lowest id while nothing has started.
    def rank(r):
        return (r[C["start"]] is None, r[C["start"]] or 0, r[C["id"]])

    first = {}
    by_pool = defaultdict(list)
    for pid, r in rows:
        by_pool[pid].append(r)
        key = (r[C["user"]], r[C["array_id"]])
        if key not in first or rank(r) < rank(first[key][1]):
            first[key] = (pid, r)
    firsts = list(first.values())
    started_firsts = [(pid, r) for pid, r in firsts if r[C["start"]]]
    finished = [(pid, r) for pid, r in rows if r[C["start"]] and r[C["state"]] not in UNSETTLED]
    batch_finished = [(pid, r) for pid, r in finished if not r[C["interactive"]]]
    users = {r[C["user"]] for _, r in rows}

    out = {
        "kind": kind,
        "unit": "gpu" if kind == "gpu" else "core",
        "since": since,
        "until": now,
        "pools": [{"id": p["id"], "label": p.get("label", p["id"]), "units": p.get("units"),
                   "nodes": p.get("nodes"), "down": p.get("down", 0)} for p in kind_pools],
        "users": len(users),
        "submissions": len(firsts),
    }

    # ---- submission rhythm --------------------------------------------------
    first_day = clock.parts(since)[0]
    last_day = clock.parts(now)[0]
    n_days = (last_day - first_day).days + 1
    weekday_days = Counter((first_day + timedelta(days=i)).weekday() for i in range(n_days))
    cells = defaultdict(set)
    daily = defaultdict(set)
    for _, r in rows:
        d, wd, h = clock.parts(r[C["submit"]])
        cells[(wd, h)].add((r[C["user"]], d))
        daily[d].add(r[C["user"]])
    counts = [[len(cells[(wd, h)]) for h in range(24)] for wd in range(7)]
    per_day = [len(daily.get(first_day + timedelta(days=i), ())) for i in range(n_days)]
    days_by_wd = defaultdict(list)
    for i, n in enumerate(per_day):
        days_by_wd[(first_day + timedelta(days=i)).weekday()].append(n)
    out["submit"] = {
        "cells": [[round(counts[wd][h] / weekday_days[wd], 2) if weekday_days[wd] else 0
                   for h in range(24)] for wd in range(7)],
        "by_hour": [round(sum(counts[wd][h] for wd in range(7)) / n_days, 2) for h in range(24)],
        "by_weekday": [round(sum(days_by_wd[wd]) / len(days_by_wd[wd]), 1) if days_by_wd[wd] else 0
                       for wd in range(7)],
        "weeks": round(n_days / 7, 1),
        "daily_weekday": _median([n for i, n in enumerate(per_day)
                                  if (first_day + timedelta(days=i)).weekday() < 5]),
        "daily_weekend": _median([n for i, n in enumerate(per_day)
                                  if (first_day + timedelta(days=i)).weekday() >= 5]),
    }

    # ---- free hours (monitor samples) ---------------------------------------
    free_acc = defaultdict(lambda: [0, 0])
    free_since = None
    for hour, pid, n, free_n in free_rows:
        if pid not in pool_ids or hour < since or not n:
            continue
        free_since = hour if free_since is None else min(free_since, hour)
        _, wd, h = clock.parts(hour)
        a = free_acc[(pid, wd >= 5, h)]
        a[0] += n
        a[1] += free_n
    free_pools = []
    for pid in pool_ids:
        def series(weekend, pid=pid):
            cells = [free_acc.get((pid, weekend, h)) for h in range(24)]
            return [round(c[1] / c[0], 3) if c and c[0] else None for c in cells]
        tot = [free_acc.get((pid, we, h)) or [0, 0] for we in (False, True) for h in range(24)]
        n_all = sum(a[0] for a in tot)
        free_pools.append({"id": pid, "weekday": series(False), "weekend": series(True),
                           "mean": round(sum(a[1] for a in tot) / n_all, 3) if n_all else None})
    out["free"] = {"since": free_since, "metric": "gpu" if kind == "gpu" else "node",
                   "pools": free_pools}

    # ---- waits per partition ------------------------------------------------
    by_part = defaultdict(list)
    for pid, r in started_firsts:
        by_part[(pid, r[C["partition"]])].append((r[C["user"]], wait(r)))
    part_hours = defaultdict(float)
    for pid, r in rows:
        part_hours[r[C["partition"]]] += hours(r)
    for _, partition, h in attempts:
        part_hours[partition] += h
    parts = []
    for (pid, name), items in by_part.items():
        n_users = len({u for u, _ in items})
        if n_users < MIN_PARTITION_USERS:
            continue
        cap = caps.get(name, {})
        parts.append({
            "name": name, "pool": pid, "users": n_users, "jobs": len(items),
            "unit_hours": round(part_hours[name]),
            "buckets": weighted_shares([(u, bucket(v, WAIT_BOUNDS)) for u, v in items],
                                       len(WAIT_BOUNDS) + 1),
            "p50": weighted_quantile(items, 0.5), "p90": weighted_quantile(items, 0.9),
            "max_units": cap.get("max_units"), "max_cores": cap.get("max_cores"),
            "wall_min": cap.get("wall_min"),
        })
    order = {pid: i for i, pid in enumerate(pool_ids)}
    big = float("inf")
    parts.sort(key=lambda p: (order[p["pool"]], p["max_units"] or big, p["max_cores"] or big,
                              p["wall_min"] or big, p["name"]))
    wait_items = [(r[C["user"]], wait(r)) for _, r in started_firsts]
    out["waits"] = {
        "users": len({u for u, _ in wait_items}),
        "start_1m": weighted_share(wait_items, lambda v: v < 60),
        "start_1h": weighted_share(wait_items, lambda v: v < 3600),
        "start_1d": weighted_share(wait_items, lambda v: v >= 86400),
        "partitions": parts,
    }

    # ---- requested --time vs. used ------------------------------------------
    limited = [(pid, r) for pid, r in batch_finished if r[C["timelimit"]]]
    ratio_items = [(r[C["user"]], r[C["elapsed"]] / (r[C["timelimit"]] * 60)) for _, r in limited]
    # a job that finished near its limit is not one that hit it: only TIMEOUT counts there
    bin_items = [(r[C["user"]], len(LIMIT_RATIO_BOUNDS) + 1 if r[C["state"]] == "TIMEOUT"
                  else bucket(r[C["elapsed"]] / (r[C["timelimit"]] * 60), LIMIT_RATIO_BOUNDS))
                 for _, r in limited]
    at_max_items = [(r[C["user"]], r[C["timelimit"]] >= caps[r[C["partition"]]]["wall_min"])
                    for _, r in limited if (caps.get(r[C["partition"]]) or {}).get("wall_min")]
    lim_counts = defaultdict(float)
    per = Counter(r[C["user"]] for _, r in limited)
    for _, r in limited:
        lim_counts[r[C["timelimit"]]] += 1 / per[r[C["user"]]]
    total_w = len(per)
    out["limits"] = {
        "users": len(per),
        "bins": weighted_shares(bin_items, len(LIMIT_RATIO_BOUNDS) + 2),
        "median": _round(weighted_quantile(ratio_items, 0.5), 4),
        "at_max": weighted_share(at_max_items, bool),
        "top": [{"minutes": m, "share": round(w / total_w, 4)}
                for m, w in sorted(lim_counts.items(), key=lambda kv: -kv[1])[:6]] if total_w else [],
    }

    # ---- requested --time vs. how fast the job started ---------------------
    ls = defaultdict(list)
    for pid, r in started_firsts:
        if r[C["interactive"]] or not r[C["timelimit"]]:
            continue
        ls[(pid, _first_le(r[C["timelimit"]], LIMIT_START_BOUNDS))].append((r[C["user"]], wait(r)))
    ls_pools = []
    for pid in pool_ids:
        shares, n_users = [], []
        for b in range(len(LIMIT_START_BOUNDS) + 1):
            items = ls.get((pid, b), [])
            nu = len({u for u, _ in items})
            n_users.append(nu)
            shares.append(weighted_share(items, lambda v: v < 3600) if nu >= MIN_CELL_USERS else None)
        if any(s is not None for s in shares):
            ls_pools.append({"id": pid, "share": shares, "users": n_users})
    out["limit_start"] = {"bounds": list(LIMIT_START_BOUNDS), "pools": ls_pools}

    # ---- job shape --------------------------------------------------------------
    shapes = []
    bounds = UNIT_BOUNDS[kind]
    for pid in pool_ids:
        js = [r for r in by_pool[pid] if r[C["start"]] and units_of(r) > 0]
        if not js:
            continue
        unit_items = [(r[C["user"]], _first_le(units_of(r), bounds)) for r in js]
        entry = {"id": pid, "users": len({r[C["user"]] for r in js}),
                 "buckets": weighted_shares(unit_items, len(bounds) + 1)}
        if kind == "gpu":
            cpg = [(r[C["user"]], r[C["cpus"]] / r[C["gpus"]]) for r in js if r[C["cpus"]]]
            mpg = [(r[C["user"]], r[C["mem_mb"]] / 1024 / r[C["gpus"]]) for r in js if r[C["mem_mb"]]]
            entry["cpus_per_unit"] = [_round(weighted_quantile(cpg, q), 1) for q in (0.5, 0.9)]
            entry["mem_gb_per_unit"] = [_round(weighted_quantile(mpg, q), 1) for q in (0.5, 0.9)]
        else:
            mpc = [(r[C["user"]], r[C["mem_mb"]] / 1024 / r[C["cpus"]]) for r in js if r[C["mem_mb"]]]
            entry["mem_gb_per_unit"] = [_round(weighted_quantile(mpc, q), 1) for q in (0.5, 0.9)]
        shapes.append(entry)
    out["shapes"] = {"bounds": list(bounds), "pools": shapes}

    # ---- interactive sessions ---------------------------------------------------
    inter = []
    for pid in pool_ids:
        pool_rows = by_pool[pid]
        sessions = [r for r in pool_rows if r[C["interactive"]] and r[C["start"]]
                    and units_of(r) > 0 and r[C["state"]] not in UNSETTLED]
        subs = [(r[C["user"]], r[C["interactive"]]) for p, r in firsts if p == pid]
        if not sessions or not subs:
            continue
        ends = [(r[C["user"]], _end_kind(r[C["state"]])) for r in sessions]
        h_all = sum(hours(r) for r in pool_rows)
        h_int = sum(hours(r) for r in pool_rows if r[C["interactive"]])
        h_end = [0.0, 0.0, 0.0]
        for r in sessions:
            h_end[_end_kind(r[C["state"]])] += hours(r)
        caps_here = Counter(icap[p] for p in {r[C["partition"]] for r in pool_rows} if icap.get(p))
        inter.append({
            "id": pid, "sessions": len(sessions), "users": len({u for u, _ in ends}),
            "end": weighted_shares(ends, 3),
            "end_hours": [round(h / sum(h_end), 4) for h in h_end] if sum(h_end) else [0.0] * 3,
            "share_submit": weighted_share(subs, bool),
            "share_hours": round(h_int / h_all, 4) if h_all else None,
            "cap_min": caps_here.most_common(1)[0][0] if caps_here else None,
        })
    out["interactive"] = {"pools": inter}

    # ---- run time: share of jobs vs. share of resource-hours ---------------------
    rt_items = [(r[C["user"]], bucket(r[C["elapsed"]], RUNTIME_BOUNDS)) for _, r in finished]
    rt_hours = [0.0] * (len(RUNTIME_BOUNDS) + 1)
    for _, r in finished:
        rt_hours[bucket(r[C["elapsed"]], RUNTIME_BOUNDS)] += hours(r)
    tot_h = sum(rt_hours)
    out["runtime"] = {
        "bounds": list(RUNTIME_BOUNDS),
        "jobs": weighted_shares(rt_items, len(RUNTIME_BOUNDS) + 1),
        "hours": [round(h / tot_h, 4) for h in rt_hours] if tot_h else [0.0] * len(rt_hours),
    }

    # ---- batch outcomes -------------------------------------------------------------
    outcomes = []
    for pid in pool_ids:
        js = [r for p, r in batch_finished if p == pid]
        if not js:
            continue
        st = [(r[C["user"]], _outcome(r[C["state"]])) for r in js]
        fast = [(r[C["user"]], r[C["state"]] in FAILED + ("OUT_OF_MEMORY",) and r[C["elapsed"]] < 60)
                for r in js]
        outcomes.append({"id": pid, "users": len({u for u, _ in st}),
                         "states": weighted_shares(st, 5), "fail_fast": weighted_share(fast, bool)})
    out["outcomes"] = {"pools": outcomes}

    # ---- concentration of resource-hours ----------------------------------------------
    per_user = defaultdict(float)
    for _, r in rows:
        h = hours(r)
        if h > 0:
            per_user[r[C["user"]]] += h
    for user, _, h in attempts:
        per_user[user] += h
    ranked = sorted(per_user.values(), reverse=True)
    total = sum(ranked)
    groups, half = [], None
    if total:
        running = 0.0
        for i, v in enumerate(ranked, 1):
            running += v
            if half is None and running >= total / 2:
                half = i
        for lo, hi in CONC_GROUPS:
            if lo > len(ranked):
                break
            hi = min(hi, len(ranked))
            groups.append({"from": lo, "to": hi, "share": round(sum(ranked[lo - 1:hi]) / total, 4)})
        rest_from = CONC_GROUPS[-1][1] + 1
        if len(ranked) >= rest_from:
            groups.append({"from": rest_from, "to": len(ranked), "rest": True,
                           "share": round(sum(ranked[rest_from - 1:]) / total, 4)})
    out["concentration"] = {"users": len(ranked), "unit_hours": round(total),
                            "groups": groups, "half": half}

    # ---- long history ------------------------------------------------------------------
    weeks = history["weeks"]
    util = {pid: history["util"].get(pid, []) for pid in pool_ids}
    full = len(weeks) - (1 if history["partial"] else 0)
    lo = max(0, full - UTIL_WEEKS)
    util13 = {}
    for pid in pool_ids:
        vals = [v for v in util[pid][lo:full] if v is not None]
        util13[pid] = round(sum(vals) / len(vals), 4) if vals else None
    caps_units = {p["id"]: p.get("units") or 0 for p in kind_pools}
    num = sum(util13[pid] * caps_units[pid] for pid in pool_ids if util13[pid] is not None)
    den = sum(caps_units[pid] for pid in pool_ids if util13[pid] is not None)
    months = Counter(datetime.fromtimestamp(ts, clock.tz).strftime("%Y-%m")
                     for ts in history["first_seen"].get(kind, {}).values())
    if history.get("truncated") and months:
        months.pop(min(months))
    out["weekly"] = {
        "starts": weeks, "partial": history["partial"], "util": util,
        "users": history["users"].get(kind, [0] * len(weeks)),
        "new_users": [{"month": m, "users": n} for m, n in sorted(months.items())],
        "util13": {"all": round(num / den, 4) if den else None, "pools": util13,
                   "weeks": min(UTIL_WEEKS, full)},
    }
    return out


def _end_kind(state):
    """How an interactive session ended: 0 = ran into its time limit, 1 = the user
    left it (for salloc FAILED only means the shell's last command exited
    non-zero), 2 = cancelled or cut off (scancel, node failure, preemption)."""
    if state == "TIMEOUT":
        return 0
    if state in ("COMPLETED", "FAILED", "OUT_OF_MEMORY"):
        return 1
    return 2


def _outcome(state):
    """Batch job end: completed, failed, timeout, out of memory, cancelled."""
    if state == "COMPLETED":
        return 0
    if state == "TIMEOUT":
        return 2
    if state == "OUT_OF_MEMORY":
        return 3
    if state in FAILED:
        return 1
    return 4


def _median(values):
    if not values:
        return None
    s = sorted(values)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def _round(v, digits):
    return None if v is None else round(v, digits)


# --------------------------------------------------------------------------- #
#  context from the live snapshot (no cluster values are hard-coded here)
# --------------------------------------------------------------------------- #
def wall_minutes(text):
    """Compact wall time from the policy snapshot ("7d", "12h", "30m") -> minutes."""
    if not text:
        return None
    unit = {"d": 1440, "h": 60, "m": 1}.get(text[-1])
    try:
        return int(text[:-1]) * unit if unit else None
    except ValueError:
        return None


def context_from_snapshot(snap, priority, now, tz, window_days=WINDOW_DAYS, retain_days=None):
    """compute() context: pools and partition caps as the dashboard reads them."""
    policy = snap.get("policy") or {}
    caps = {name: {"wall_min": wall_minutes(c.get("wall")),
                   "max_units": c.get("maxGpus"), "max_cores": c.get("maxCores"),
                   "min_cores": c.get("minCores")}
            for name, c in (policy.get("partition_caps") or {}).items()}
    lua_parts = (policy.get("lua") or {}).get("partitions") or {}
    icap = {name: v["interactive_time_min"] for name, v in lua_parts.items()
            if isinstance(v, dict) and v.get("interactive_time_min")}
    pools = []
    for p in snap.get("pools") or []:
        gpu = p.get("gpu") or {}
        is_gpu = p.get("kind") == "gpu"
        pools.append({
            "id": p["id"], "kind": p.get("kind"), "label": gpu.get("label") or p["id"],
            "units": gpu.get("total") if is_gpu else (p.get("cores") or {}).get("total"),
            "nodes": p.get("nodes"),
            "down": gpu.get("down", 0) if is_gpu else p.get("down_nodes", 0),
            "partitions": p.get("partitions", []),
        })
    return {"now": now, "tz": tz, "window_days": window_days, "retain_days": retain_days,
            "part_pool": snap.get("part_pool") or {}, "pools": pools, "caps": caps,
            "interactive_cap": icap, "priority": priority or {}}


def compute_from_store(store, snap, priority, now, tz, window_days=WINDOW_DAYS, retain_days=None):
    """compute() over the store's job history, with the context read from `snap`."""
    ctx = context_from_snapshot(snap, priority, now, tz, window_days, retain_days)
    ctx["history_since"] = store.job_stats()["first_submit"]
    since = now - window_days * 86400
    return compute(store.jobs_window(since), store.iter_job_history(), store.pool_hours(since), ctx,
                   store.window_attempts(since))
