import unittest

from backend import job_history as jh


def line(**kw):
    fields = dict(JobID="100", JobIDRaw="100", User="alice", Partition="GPU-1",
                  Submit="2026-10-01T10:00:00", Eligible="2026-10-01T10:00:00",
                  Start="2026-10-01T10:00:30", End="2026-10-01T12:00:30",
                  ElapsedRaw="7200", TimelimitRaw="720", State="COMPLETED",
                  NNodes="1", NCPUS="26",
                  ReqTRES="billing=26,cpu=26,gres/gpu=1,mem=256G,node=1",
                  AllocTRES="billing=26,cpu=26,gres/gpu:nvidia_a40=1,gres/gpu=1,mem=256G,node=1",
                  SubmitLine="sbatch")
    fields.update(kw)
    return "|".join(fields[f] for f in jh.FIELDS)


class SacctParseTests(unittest.TestCase):
    def test_running_job_holds_its_allocation(self):
        [row] = jh.parse_sacct(line())
        self.assertEqual(row["id"], 100)
        self.assertEqual(row["array_id"], 100)
        self.assertEqual(row["gpus"], 1)
        self.assertEqual(row["gpu_type"], "nvidia_a40")
        self.assertEqual(row["cpus"], 26)
        self.assertEqual(row["mem_mb"], 256 * 1024)
        self.assertEqual(row["timelimit"], 720)
        self.assertEqual(row["interactive"], 0)
        self.assertEqual(row["end"] - row["start"], 7200)

    def test_pending_job_reports_its_request(self):
        [row] = jh.parse_sacct(line(Start="Unknown", End="Unknown", State="PENDING", NCPUS="0",
                                    ElapsedRaw="0", AllocTRES="",
                                    ReqTRES="billing=8,cpu=8,gres/gpu=2,mem=96000M,node=1"))
        self.assertIsNone(row["start"])
        self.assertIsNone(row["end"])
        self.assertEqual(row["cpus"], 8)       # NCPUS reads 0 while pending
        self.assertEqual(row["gpus"], 2)
        self.assertEqual(row["mem_mb"], 96000)

    def test_array_tasks_share_their_master_id(self):
        rows = jh.parse_sacct("\n".join([
            line(JobID="500_[3-9%2]", JobIDRaw="500", State="PENDING", Start="Unknown", End="Unknown"),
            line(JobID="500_1", JobIDRaw="501"),
            line(JobID="700+1", JobIDRaw="702"),
        ]))
        self.assertEqual([(r["id"], r["array_id"]) for r in rows], [(500, 500), (501, 500), (702, 700)])

    def test_interactive_commands_and_states(self):
        rows = jh.parse_sacct("\n".join([
            line(JobIDRaw="1", SubmitLine="/usr/bin/salloc"),
            line(JobIDRaw="2", SubmitLine="srun"),
            line(JobIDRaw="3", State="CANCELLED by 12345", TimelimitRaw="UNLIMITED"),
        ]))
        self.assertEqual([r["interactive"] for r in rows], [1, 1, 0])
        self.assertEqual(rows[2]["state"], "CANCELLED")
        self.assertIsNone(rows[2]["timelimit"])

    def test_malformed_lines_are_skipped(self):
        text = "\n".join([line(), "  module load cuda", "", line(JobIDRaw="abc"), line() + "|extra"])
        self.assertEqual(len(jh.parse_sacct(text)), 1)

    def test_memory_units(self):
        self.assertEqual(jh._mem_mb("1.5T"), int(1.5 * 1024 * 1024))
        self.assertEqual(jh._mem_mb("512K"), 0)
        self.assertIsNone(jh._mem_mb("bogus"))

    def test_script_cuts_submit_line_and_fails_with_sacct(self):
        script = jh.sacct_script("2026-10-01T00:00:00", "now", with_config=True)
        self.assertIn("set -o pipefail", script)
        self.assertIn("SubmitLine", script)
        self.assertIn("print $1,$2", script)
        self.assertIn(jh.CONFIG_MARK, script)
        jobs, cfg = jh.split_output(f"{line()}\n{jh.CONFIG_MARK}\nPriorityType = priority/multifactor\n")
        self.assertEqual(len(jh.parse_sacct(jobs)), 1)
        self.assertEqual(jh.parse_priority_config(cfg)["type"], "priority/multifactor")

    def test_priority_config(self):
        cfg = jh.parse_priority_config("\n".join([
            "PriorityType            = priority/multifactor",
            "PriorityWeightAge       = 10000",
            "PriorityWeightFairShare = 10000",
            "PriorityWeightTRES      = (null)",
            "SchedulerType           = sched/backfill",
        ]))
        self.assertEqual(cfg, {"type": "priority/multifactor", "scheduler": "sched/backfill",
                               "weights": {"Age": 10000, "FairShare": 10000}})
        self.assertEqual(jh.parse_priority_config(""), {})


if __name__ == "__main__":
    unittest.main()


class FakeSource:
    mode = "ssh"

    def __init__(self):
        self.windows = []

    def _exec(self, script, timeout=None):
        parts = script.split()
        self.windows.append((parts[parts.index("-S") + 1], parts[parts.index("-E") + 1]))
        return line(JobIDRaw=str(len(self.windows))) + "\n"


class CollectorTests(unittest.TestCase):
    def setUp(self):
        import os, tempfile
        from backend.store import Store
        fd, self.path = tempfile.mkstemp(suffix=".sqlite")
        os.close(fd)
        os.unlink(self.path)
        self.store = Store(self.path)
        self.src = FakeSource()
        self.col = jh.JobHistoryCollector(self.src, self.store, lambda: {"pools": []},
                                          lambda *a: {"ok": True}, retain_days=65)
        self.col.CHUNK_PAUSE_S = 0

    def tearDown(self):
        import os
        self.store.close()
        for suffix in ("", "-wal", "-shm"):
            try:
                os.unlink(self.path + suffix)
            except FileNotFoundError:
                pass

    def test_backfill_ends_at_now_in_whole_chunks(self):
        now = 1791198413.75          # a fractional clock must not keep the loop alive
        self.col._backfill(now)
        self.assertEqual(len(self.src.windows), 3)   # 30 + 30 + 5 days
        self.assertEqual(self.src.windows[-1][1], jh.cluster_time(int(now)))
        self.assertEqual(self.store.meta_get("jobs_backfill_done"), "1")
        self.assertEqual(self.store.job_stats()["jobs"], 3)

    def test_backfill_resumes_and_incremental_overlaps_the_last_run(self):
        now = 1791198413
        self.store.meta_set("jobs_backfill_until", now - 10 * 86400)
        self.col._backfill(now)
        self.assertEqual(len(self.src.windows), 1)
        self.col._incremental(now + 600)
        start, end = self.src.windows[-1]
        self.assertEqual(start, jh.cluster_time(now - jh.JobHistoryCollector.MARGIN_S))
        self.assertEqual(end, jh.cluster_time(now + 600))
        self.assertEqual(self.col.status, "ready")

    def test_incremental_catches_up_a_long_gap_in_chunks(self):
        now = 1791198413
        self.store.meta_set("jobs_fetched_at", now - 70 * 86400)
        self.col._incremental(now)
        self.assertEqual(len(self.src.windows), 3)                 # 30 + 30 + 10 days
        self.assertEqual(self.store.meta_get("jobs_fetched_at"), str(now))

    def test_payload_before_and_after_the_first_result(self):
        self.col.status = "ready"            # sacct read, nothing computed yet
        self.assertEqual(self.col.payload()["status"], "idle")
        self.col.refresh(1791198413)
        self.assertEqual(self.col.payload()["status"], "ready")
        self.assertTrue(self.col.payload()["ok"])


class NoStore:
    def __init__(self, stale=()):
        self.stale = set(stale)

    def meta_get(self, key, default=None):
        return default

    def stale_ids(self, ids):
        return self.stale & set(ids)


class SettleTests(unittest.TestCase):
    """Runaway records: sacct says running, squeue does not have the job."""

    def collector(self, latest_lines, queued=("900",)):
        class Src:
            mode = "ssh"
            calls = []

            def _exec(self, script, timeout=None):
                self.calls.append(script)
                return "\n".join(latest_lines)

        snap = {"generated_at": 2_000_000_000, "jobs": [{"job_id": q} for q in queued]}
        src = Src()
        col = jh.JobHistoryCollector(src, store=NoStore(), snapshot_fn=lambda: snap, compute_fn=None)
        return col, src

    def test_closed_record_replaces_the_runaway_one(self):
        col, src = self.collector([line(JobID="434294", JobIDRaw="434294", State="COMPLETED")])
        rows = jh.parse_sacct("\n".join([
            line(JobID="434294", JobIDRaw="434294", State="RUNNING", End="Unknown"),
            line(JobID="900", JobIDRaw="900", State="RUNNING", End="Unknown"),
        ]))
        settled = {r["id"]: r for r in col._settle(rows)[0]}
        self.assertEqual(settled[434294]["state"], "COMPLETED")
        self.assertEqual(settled[900]["state"], "RUNNING")       # really queued: untouched
        self.assertIn("-j 434294", src.calls[0])
        self.assertNotIn("-S", src.calls[0])                      # latest record, no window

    def test_record_that_never_closed_counts_no_run_time(self):
        col, _ = self.collector([line(JobID="434372", JobIDRaw="434372", State="RUNNING",
                                      End="Unknown", ElapsedRaw="7000000")])
        rows = jh.parse_sacct(line(JobID="434372", JobIDRaw="434372", State="RUNNING", End="Unknown"))
        [row], _ = col._settle(rows)
        self.assertEqual(row["state"], "STALE")
        self.assertEqual(row["elapsed"], 0)
        self.assertEqual(row["end"], row["start"])

    def test_pending_array_remainder_is_live_while_its_tasks_queue(self):
        col, src = self.collector([], queued=("776215_3",))
        rows = jh.parse_sacct(line(JobID="776215_[4-9]", JobIDRaw="776215", State="PENDING",
                                   Start="Unknown", End="Unknown"))
        self.assertEqual(col._settle(rows)[0][0]["state"], "PENDING")
        self.assertEqual(src.calls, [])

    def test_no_fresh_snapshot_means_no_judgement(self):
        rows = jh.parse_sacct(line(State="RUNNING", End="Unknown"))
        col = jh.JobHistoryCollector(FakeSource(), store=NoStore(), snapshot_fn=lambda: None, compute_fn=None)
        self.assertEqual(col._settle(rows), (rows, []))

    def test_without_a_snapshot_a_stale_row_is_not_revived(self):
        rows = jh.parse_sacct(line(JobIDRaw="434372", State="RUNNING", End="Unknown"))
        col = jh.JobHistoryCollector(FakeSource(), store=NoStore(stale={434372}),
                                     snapshot_fn=lambda: None, compute_fn=None)
        self.assertEqual(col._settle(rows), ([], []))


class AttemptTests(unittest.TestCase):
    def test_earlier_runs_become_attempts_that_end_where_the_next_run_began(self):
        rows = jh.parse_sacct("\n".join([
            line(JobIDRaw="7", State="NODE_FAIL", Start="2026-07-11T15:00:00", End="2026-07-14T05:50:00"),
            line(JobIDRaw="7", State="RUNNING", Start="2026-07-14T06:30:00", End="Unknown"),   # never closed
            line(JobIDRaw="7", State="COMPLETED", Start="2026-07-14T09:40:00", End="2026-07-14T10:20:00"),
            line(JobIDRaw="8"),
        ]))
        latest, attempts = jh.split_attempts(rows)
        self.assertEqual([(r["id"], r["state"]) for r in latest], [(7, "COMPLETED"), (8, "COMPLETED")])
        self.assertEqual(len(attempts), 2)
        first, runaway = attempts
        self.assertEqual(first["end"] - first["start"], (2 * 86400 + 14 * 3600 + 50 * 60))
        self.assertEqual(runaway["end"], latest[0]["start"])          # capped by the next run

    def test_store_keeps_a_superseded_run_as_an_attempt(self):
        import os, tempfile
        from backend.store import Store
        fd, path = tempfile.mkstemp(suffix=".sqlite")
        os.close(fd)
        os.unlink(path)
        store = Store(path)
        try:
            [first] = jh.parse_sacct(line(JobIDRaw="9", State="RUNNING", Start="2026-07-11T15:00:00", End="Unknown"))
            store.upsert_jobs([first])
            [second] = jh.parse_sacct(line(JobIDRaw="9", State="RUNNING", Start="2026-07-14T06:30:00", End="Unknown"))
            store.upsert_jobs([second])
            [(user, part, start, end, cpus, gpus)] = store.window_attempts(0)
            self.assertEqual((start, end), (first["start"], second["start"]))
            history = list(store.iter_job_history())
            self.assertEqual(len(history), 2)                          # the job + its earlier run
            # a late, older run never replaces the newer row; it becomes an attempt
            [older] = jh.parse_sacct(line(JobIDRaw="9", State="NODE_FAIL", Start="2026-07-10T10:00:00",
                                          End="2026-07-10T12:00:00"))
            self.assertEqual(store.upsert_jobs([older]), 0)
            self.assertEqual(len(store.window_attempts(0)), 2)
            [row] = store.jobs_window(0)
            self.assertEqual(row[6], second["start"])
            store.mark_stale([9])
            [row] = store.jobs_window(0)
            self.assertEqual(row[10], "STALE")
        finally:
            store.close()
            for suffix in ("", "-wal", "-shm"):
                try:
                    os.unlink(path + suffix)
                except FileNotFoundError:
                    pass
