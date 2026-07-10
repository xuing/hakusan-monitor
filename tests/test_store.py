import os
import tempfile
import unittest

from backend.store import Store


class StoreHistoryTests(unittest.TestCase):
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
