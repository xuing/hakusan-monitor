import os
import tempfile
import unittest

from backend.store import JOB_COLUMNS, Store, pool_free

POOLS = [{"id": "a40", "kind": "gpu", "gpu": {"free": 2, "maint": False}},
         {"id": "h100", "kind": "gpu", "gpu": {"free": 0, "maint": False}},
         {"id": "cpu", "kind": "cpu", "idle_nodes": 3}]


def job(**kw):
    d = {k: None for k in JOB_COLUMNS}
    d.update(id=1, array_id=1, user="alice", partition="GPU-1", submit=1000, state="PENDING",
             elapsed=0, cpus=8, gpus=1, interactive=0)
    d.update(kw)
    return d


class StoreJobTests(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".sqlite")
        os.close(fd)
        os.unlink(self.path)
        self.store = Store(self.path)

    def tearDown(self):
        self.store.close()
        for suffix in ("", "-wal", "-shm"):
            try:
                os.unlink(self.path + suffix)
            except FileNotFoundError:
                pass

    def test_upsert_refreshes_rows_and_never_stores_login_names(self):
        self.store.upsert_jobs([job()])
        self.store.upsert_jobs([job(state="COMPLETED", start=1100, end=1200, elapsed=100)])
        [row] = self.store.jobs_window(0)
        col = {k: i for i, k in enumerate(JOB_COLUMNS)}
        self.assertEqual(row[col["state"]], "COMPLETED")
        self.assertEqual(row[col["elapsed"]], 100)
        self.assertNotEqual(row[col["user"]], "alice")
        self.assertEqual(row[col["user"]], self.store.user_key("alice"))
        self.assertEqual(self.store.job_stats()["jobs"], 1)
        self.assertEqual(list(self.store.iter_job_history()),
                         [(self.store.user_key("alice"), "GPU-1", 1000, 1100, 1200, 8, 1)])

    def test_user_key_is_stable_per_installation(self):
        key = self.store.user_key("alice")
        self.store.close()
        self.store = Store(self.path)
        self.assertEqual(self.store.user_key("alice"), key)

    def test_prune_drops_jobs_past_retention(self):
        store = Store(self.path, job_retain_days=1)
        store.upsert_jobs([job(id=1, submit=0, end=10), job(id=2, submit=100000)])
        store.prune(100000 + 3600)
        self.assertEqual([r[0] for r in store.jobs_window(0)], [2])
        store.close()

    def test_record_rolls_up_free_pools(self):
        self.store.record({"pools": POOLS}, 7200)
        self.store.record({"pools": POOLS}, 7300)
        rows = {pool: (n, free) for _, pool, n, free in self.store.pool_hours(0)}
        self.assertEqual(rows, {"a40": (2, 2), "h100": (2, 0), "cpu": (2, 2)})

    def test_pool_free_metrics(self):
        self.assertEqual(pool_free({"kind": "gpu", "gpu": {"free": 3, "maint": True}}), (3, 0))
        self.assertEqual(pool_free({"kind": "gpu", "gpu": None}), (0, 0))
        self.assertEqual(pool_free({"kind": "cpu", "idle_nodes": 0}), (0, 0))


if __name__ == "__main__":
    unittest.main()
