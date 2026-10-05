import itertools
import unittest
from datetime import datetime, timedelta, timezone

from backend import analytics as an
from backend.store import JOB_COLUMNS

UTC = timezone.utc


def ts(y, m, d, h=0, mi=0):
    return int(datetime(y, m, d, h, mi, tzinfo=UTC).timestamp())


NOW = ts(2026, 10, 5, 12)          # a Monday, noon
_ids = itertools.count(1)


def job(**kw):
    d = dict(id=next(_ids), array_id=None, user="u1", partition="GPU-1",
             submit=NOW - 86400, eligible=None, start=None, end=None, elapsed=0,
             timelimit=60, state="COMPLETED", nodes=1, cpus=8, gpus=1, gpu_type="nvidia_a40",
             mem_mb=65536, interactive=0, job_key=None)
    d.update(kw)
    if d["array_id"] is None:
        d["array_id"] = d["id"]
    if d["start"] is not None and d["end"] is None and d["state"] not in an.ACTIVE:
        d["end"] = d["start"] + d["elapsed"]
    return tuple(d[k] for k in JOB_COLUMNS)


def ran(user, submit, wait=0, elapsed=3600, **kw):
    """A finished job that waited `wait` seconds and ran `elapsed` seconds."""
    return job(user=user, submit=submit, start=submit + wait, elapsed=elapsed, **kw)


CTX = {
    "now": NOW, "tz": UTC, "window_days": 90,
    "part_pool": {"GPU-1": "a40", "GPU-1A": "a100", "DEF": "cpu"},
    "pools": [
        {"id": "a40", "kind": "gpu", "label": "A40", "units": 4, "nodes": 2, "down": 0},
        {"id": "a100", "kind": "gpu", "label": "A100", "units": 2, "nodes": 1, "down": 0},
        {"id": "cpu", "kind": "cpu", "label": "cpu", "units": 100, "nodes": 1, "down": 0},
    ],
    "caps": {"GPU-1": {"wall_min": 10080, "max_units": 1, "max_cores": 26}},
    "interactive_cap": {"GPU-1": 720},
    "priority": {"type": "priority/multifactor", "weights": {"FairShare": 10000}},
}


def run(rows, free_rows=(), **over):
    col = {k: i for i, k in enumerate(JOB_COLUMNS)}
    history = [(r[col["user"]], r[col["partition"]], r[col["submit"]], r[col["start"]],
                r[col["end"]], r[col["cpus"]], r[col["gpus"]]) for r in rows]
    ctx = {**CTX, **over}
    ctx.setdefault("history_since", min(r[col["submit"]] for r in rows))
    return an.compute(rows, history, list(free_rows), ctx)


class WeightingTests(unittest.TestCase):
    def test_each_user_weighs_the_same_in_waits(self):
        t = NOW - 5 * 86400
        rows = [ran("heavy", t + i, wait=7200) for i in range(10)]
        rows += [ran("a", t), ran("b", t)]
        gpu = run(rows)["gpu"]
        self.assertAlmostEqual(gpu["waits"]["start_1m"], 2 / 3, places=3)
        [part] = gpu["waits"]["partitions"]
        self.assertEqual(part["users"], 3)
        self.assertEqual(part["jobs"], 12)
        self.assertEqual([round(b, 3) for b in part["buckets"]], [0.667, 0.0, 0.333, 0.0, 0.0])
        self.assertEqual(part["p50"], 0)
        self.assertEqual(part["p90"], 7200)

    def test_array_wait_starts_from_its_first_running_task(self):
        t = NOW - 86400
        rows = [job(id=900, user="x", submit=t, state="PENDING"),
                job(id=901, array_id=900, user="x", submit=t, start=t + 30, elapsed=60)]
        gpu = run(rows)["gpu"]
        self.assertEqual(gpu["submissions"], 1)
        self.assertEqual(gpu["waits"]["start_1m"], 1.0)

    def test_partition_rows_need_three_users(self):
        t = NOW - 86400
        rows = [ran(u, t, partition="GPU-1A") for u in ("a", "b")]
        rows += [ran(u, t) for u in ("a", "b", "c")]
        names = [p["name"] for p in run(rows)["gpu"]["waits"]["partitions"]]
        self.assertEqual(names, ["GPU-1"])

    def test_submit_rhythm_counts_people_not_jobs(self):
        monday10 = ts(2026, 9, 28, 10)
        rows = [job(user="heavy", submit=monday10 + i) for i in range(100)]
        rows.append(job(user="a", submit=monday10 + 5))
        sub = run(rows)["gpu"]["submit"]
        mondays = sum(1 for i in range(91) if (datetime.fromtimestamp(NOW, UTC) - timedelta(days=90)
                                               + timedelta(days=i)).weekday() == 0)
        self.assertAlmostEqual(sub["cells"][0][10], round(2 / mondays, 2))
        self.assertEqual(sub["cells"][0][11], 0)


class RequestTests(unittest.TestCase):
    def test_limits_ratio_and_partition_max(self):
        t = NOW - 86400
        rows = [ran("a", t, elapsed=3600, timelimit=10080),       # 0.6% of a 7-day cap
                ran("b", t, elapsed=3600, timelimit=60, state="TIMEOUT")]
        lim = run(rows)["gpu"]["limits"]
        self.assertEqual(lim["users"], 2)
        self.assertEqual(lim["bins"][0], 0.5)
        self.assertEqual(lim["bins"][6], 0.5)
        self.assertEqual(lim["at_max"], 0.5)
        self.assertAlmostEqual(lim["median"], round(3600 / (10080 * 60), 4))
        self.assertEqual([x["minutes"] for x in lim["top"]], [10080, 60])

    def test_limit_vs_start_hides_thin_buckets(self):
        t = NOW - 86400
        rows = [ran(f"u{i}", t, wait=0, timelimit=30) for i in range(5)]
        rows += [ran(f"v{i}", t, wait=7200, timelimit=10000) for i in range(5)]
        rows += [ran("w", t, timelimit=2000)]
        [pool] = run(rows)["gpu"]["limit_start"]["pools"]
        self.assertEqual(pool["share"], [1.0, None, None, None, 0.0])
        self.assertEqual(pool["users"], [5, 0, 0, 1, 5])

    def test_interactive_endings_and_hours(self):
        t = NOW - 86400
        rows = [ran("a", t, elapsed=720 * 60, state="TIMEOUT", interactive=1),
                ran("b", t, elapsed=600, state="FAILED", interactive=1),      # shell exited non-zero
                ran("c", t, elapsed=7200)]
        [pool] = run(rows)["gpu"]["interactive"]["pools"]
        self.assertEqual(pool["end"], [0.5, 0.5, 0.0])
        self.assertAlmostEqual(pool["end_hours"][0], 720 / 730, places=3)
        self.assertEqual(pool["cap_min"], 720)
        self.assertAlmostEqual(pool["share_submit"], 2 / 3, places=3)

    def test_gpu_shape_per_unit(self):
        t = NOW - 86400
        rows = [ran("a", t, gpus=2, cpus=52, mem_mb=2 * 131072), ran("b", t, gpus=1, cpus=8)]
        [shape] = run(rows)["gpu"]["shapes"]["pools"]
        self.assertEqual(shape["buckets"], [0.5, 0.5, 0.0])
        self.assertEqual(shape["cpus_per_unit"][1], 26.0)


class HistoryTests(unittest.TestCase):
    def test_weekly_util_splits_a_job_across_weeks(self):
        sunday_noon = ts(2026, 10, 4, 12)
        rows = [job(user="a", submit=sunday_noon, start=sunday_noon, end=NOW,
                    elapsed=NOW - sunday_noon, state="RUNNING")]
        pools = [{"id": "a40", "kind": "gpu", "label": "A40", "units": 1, "nodes": 1, "down": 0}]
        weekly = run(rows, pools=pools)["gpu"]["weekly"]
        self.assertEqual(len(weekly["starts"]), 2)
        self.assertTrue(weekly["partial"])
        self.assertAlmostEqual(weekly["util"]["a40"][0], round(12 / 168, 4))
        self.assertEqual(weekly["util"]["a40"][1], 1.0)
        self.assertEqual(weekly["util13"]["pools"]["a40"], round(12 / 168, 4))

    def test_days_without_any_start_are_outages(self):
        rows = [ran("a", ts(2026, 9, 1, 9)), ran("a", ts(2026, 9, 4, 9))]
        rows += [ran("a", NOW - 3600)]
        out = run(rows)
        self.assertIn(["2026-09-02", "2026-09-03"], out["outages"])

    def test_new_users_by_first_month(self):
        rows = [ran("a", ts(2026, 8, 10)), ran("a", ts(2026, 9, 10)), ran("b", ts(2026, 9, 12))]
        self.assertEqual(run(rows)["gpu"]["weekly"]["new_users"],
                         [{"month": "2026-08", "users": 1}, {"month": "2026-09", "users": 1}])


class SharesTests(unittest.TestCase):
    def test_free_hours_split_weekday_and_weekend(self):
        rows = [ran("a", NOW - 3600)]
        free = [(ts(2026, 9, 28, 5), "a40", 30, 15), (ts(2026, 10, 3, 5), "a40", 30, 30)]
        a40 = run(rows, free)["gpu"]["free"]["pools"][0]
        self.assertEqual(a40["weekday"][5], 0.5)
        self.assertEqual(a40["weekend"][5], 1.0)
        self.assertIsNone(a40["weekday"][6])
        self.assertEqual(a40["mean"], 0.75)

    def test_concentration_groups(self):
        t = NOW - 86400
        rows = [ran("a", t, elapsed=50 * 3600), ran("b", t, elapsed=30 * 3600),
                ran("c", t, elapsed=20 * 3600)]
        conc = run(rows)["gpu"]["concentration"]
        self.assertEqual(conc["users"], 3)
        self.assertEqual(conc["half"], 1)
        self.assertEqual(conc["groups"], [{"from": 1, "to": 1, "share": 0.5},
                                          {"from": 2, "to": 3, "share": 0.5}])

    def test_earlier_runs_count_toward_resource_hours(self):
        t = NOW - 86400
        rows = [ran("a", t, elapsed=3600)]
        attempts = [("a", "GPU-1", t - 7200, t - 3600, 8, 2)]          # 1 h on 2 GPUs before a requeue
        col = {k: i for i, k in enumerate(JOB_COLUMNS)}
        history = [(r[col["user"]], r[col["partition"]], r[col["submit"]], r[col["start"]],
                    r[col["end"]], r[col["cpus"]], r[col["gpus"]]) for r in rows]
        out = an.compute(rows, history, [], {**CTX, "history_since": t - 7200}, attempts)
        self.assertEqual(out["gpu"]["concentration"]["unit_hours"], 3)
        self.assertEqual(out["gpu"]["waits"]["partitions"], [])       # still one job, one user

    def test_cpu_view_counts_core_hours(self):
        t = NOW - 86400
        rows = [ran("a", t, partition="DEF", cpus=64, gpus=0), ran("b", t)]
        out = run(rows)
        self.assertEqual(out["cpu"]["concentration"]["unit_hours"], 64)
        self.assertEqual(out["gpu"]["concentration"]["unit_hours"], 1)
        self.assertEqual(out["cpu"]["users"], 1)

    def test_outcomes_and_fast_failures(self):
        t = NOW - 86400
        rows = [ran("a", t, elapsed=20, state="FAILED"), ran("b", t, elapsed=7200)]
        [pool] = run(rows)["gpu"]["outcomes"]["pools"]
        self.assertEqual(pool["states"], [0.5, 0.5, 0.0, 0.0, 0.0])
        self.assertEqual(pool["fail_fast"], 0.5)


class ContextTests(unittest.TestCase):
    def test_context_from_snapshot(self):
        snap = {"part_pool": {"GPU-1": "a40"},
                "pools": [{"id": "a40", "kind": "gpu", "nodes": 20, "partitions": ["GPU-1"],
                           "gpu": {"label": "A40", "total": 40, "down": 1}, "cores": {"total": 1040}},
                          {"id": "cpu", "kind": "cpu", "nodes": 124, "down_nodes": 2,
                           "cores": {"total": 31744}}],
                "policy": {"partition_caps": {"GPU-1": {"wall": "7d", "maxGpus": 1, "maxCores": 26},
                                              "TINY": {"wall": "30m", "maxCores": 16}},
                           "lua": {"partitions": {"GPU-1": {"interactive_time_min": 720}}}}}
        ctx = an.context_from_snapshot(snap, {}, NOW, UTC)
        self.assertEqual(ctx["caps"]["GPU-1"]["wall_min"], 10080)
        self.assertEqual(ctx["caps"]["TINY"]["wall_min"], 30)
        self.assertEqual(ctx["interactive_cap"], {"GPU-1": 720})
        self.assertEqual([(p["id"], p["units"], p["down"]) for p in ctx["pools"]],
                         [("a40", 40, 1), ("cpu", 31744, 2)])
        self.assertIsNone(an.wall_minutes("bogus"))


if __name__ == "__main__":
    unittest.main()
