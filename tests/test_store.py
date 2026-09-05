import os
import tempfile
import unittest
import sqlite3
from unittest.mock import patch

from backend.store import Store


class StoreHistoryTests(unittest.TestCase):
    def record_sample(self, ts, util=0.5):
        metrics = dict(cpu_util=util, gpu_util=util, mem_util=util,
                       cpus_total=10, cpus_alloc=5, gpus_total=10, gpus_used=5,
                       nodes_total=1, nodes_avail=1, nodes_down=0, running=1, pending=0)
        with patch("backend.store._metrics", return_value=metrics):
            self.store.record({}, ts)

    def test_duplicate_samples_do_not_change_rollup_after_reopen(self):
        self.record_sample(3600)
        self.record_sample(3601)
        self.store.close()
        self.store = Store(self.path)
        self.record_sample(3600, util=1)
        c = self.store._conn()
        self.assertEqual(c.execute("SELECT count(*) FROM samples").fetchone()[0], 2)
        row = c.execute("SELECT n,cpu_avg FROM samples_hourly").fetchone()
        self.assertEqual(tuple(row), (2, 0.5))

    def test_failed_rollup_rolls_back_and_can_retry_same_timestamp(self):
        c = self.store._conn()
        c.execute("""CREATE TRIGGER fail_rollup BEFORE INSERT ON samples_hourly
                     BEGIN SELECT RAISE(ABORT, 'test failure'); END""")
        with self.assertRaises(sqlite3.IntegrityError):
            self.record_sample(3600)
        self.assertEqual(c.execute("SELECT count(*) FROM samples").fetchone()[0], 0)
        c.execute("DROP TRIGGER fail_rollup")
        self.record_sample(3600)
        self.assertEqual(c.execute("SELECT n FROM samples_hourly").fetchone()[0], 1)

    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".sqlite")
        os.close(fd)
        os.unlink(self.path)
        self.store = Store(self.path, retain_days=2, login_retain_days=2, visit_retain_days=2)

    def tearDown(self):
        self.store.close()
        for suffix in ("", "-wal", "-shm"):
            try:
                os.unlink(self.path + suffix)
            except FileNotFoundError:
                pass

    def test_login_history_preserves_every_node_series_and_endpoints(self):
        c = self.store._conn()
        with c:
            for ts in range(1, 7):
                for node_id in ("a", "b"):
                    c.execute(
                        "INSERT INTO login_samples (ts,node_id,load1) VALUES (?,?,?)",
                        (ts, node_id, ts),
                    )

        rows = self.store.login_history(1, 6, max_points=10)
        by_node = {node_id: [r for r in rows if r["node_id"] == node_id] for node_id in ("a", "b")}

        self.assertTrue(by_node["a"])
        self.assertTrue(by_node["b"])
        self.assertEqual(by_node["a"][0]["ts"], 1)
        self.assertEqual(by_node["a"][-1]["ts"], 6)
        self.assertEqual(by_node["b"][0]["ts"], 1)
        self.assertEqual(by_node["b"][-1]["ts"], 6)
        self.assertLessEqual(len(rows), 10)

    def test_history_does_not_halve_exact_budget_and_keeps_latest(self):
        c = self.store._conn()
        with c:
            for ts in range(1, 11):
                c.execute("INSERT INTO samples (ts,cpu_util) VALUES (?,?)", (ts, ts / 10))

        exact = self.store.history(1, 10, max_points=10)
        sampled = self.store.history(1, 10, max_points=4)

        self.assertEqual(len(exact), 10)
        self.assertEqual(sampled[0]["ts"], 1)
        self.assertEqual(sampled[-1]["ts"], 10)
        self.assertLessEqual(len(sampled), 4)

    def test_prune_applies_to_cluster_login_and_visits(self):
        now = 10 * 86400
        old = now - 3 * 86400
        recent = now - 86400
        c = self.store._conn()
        with c:
            c.execute("INSERT INTO samples (ts) VALUES (?)", (old,))
            c.execute("INSERT INTO samples (ts) VALUES (?)", (recent,))
            c.execute("INSERT INTO login_samples (ts,node_id) VALUES (?,?)", (old, "a"))
            c.execute("INSERT INTO login_samples (ts,node_id) VALUES (?,?)", (recent, "a"))
            c.execute("INSERT INTO visits (day,visitor,hits) VALUES ('1970-01-07','old',1)")
            c.execute("INSERT INTO visits (day,visitor,hits) VALUES ('1970-01-10','new',1)")

        self.store.prune(now)

        self.assertEqual(c.execute("SELECT count(*) FROM samples").fetchone()[0], 1)
        self.assertEqual(c.execute("SELECT count(*) FROM login_samples").fetchone()[0], 1)
        self.assertEqual(c.execute("SELECT count(*) FROM visits").fetchone()[0], 1)

    def test_visitor_id_is_stable_but_keyed(self):
        first = self.store.visitor_id("192.0.2.1", "browser")
        second = self.store.visitor_id("192.0.2.1", "browser")
        other = self.store.visitor_id("192.0.2.2", "browser")
        self.assertEqual(first, second)
        self.assertNotEqual(first, other)
        self.assertEqual(len(first), 32)


if __name__ == "__main__":
    unittest.main()
