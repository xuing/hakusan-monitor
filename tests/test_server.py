import http.client
import os
import tempfile
import threading
import unittest
from unittest.mock import patch

from backend.server import Engine, Handler, ThreadingHTTPServer


class _FakeEngine:
    def subscribe(self):
        raise AssertionError("HEAD must not subscribe")


class ServerBehaviorTests(unittest.TestCase):
    def request(self, method, path, *, frontend=None, headers=None):
        missing = object()
        old_engine = getattr(Handler, "engine", missing)
        Handler.engine = _FakeEngine()
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            ctx = patch("backend.server.FRONTEND", frontend) if frontend else _nullcontext()
            with ctx:
                conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
                conn.request(method, path, headers=headers or {})
                response = conn.getresponse()
                body = response.read()
                result = response.status, response.getheaders(), body
                conn.close()
                return result
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
            if old_engine is missing:
                delattr(Handler, "engine")
            else:
                Handler.engine = old_engine

    def test_head_stream_is_rejected_without_subscribing(self):
        status, _, body = self.request("HEAD", "/api/stream")
        self.assertEqual(status, 405)
        self.assertEqual(body, b"")

    def test_missing_asset_and_robots_do_not_fall_back_to_spa(self):
        with tempfile.TemporaryDirectory() as frontend:
            with open(os.path.join(frontend, "index.html"), "w") as f:
                f.write("spa")
            status, _, _ = self.request("GET", "/robots.txt", frontend=frontend, headers={"Accept": "text/plain"})
            self.assertEqual(status, 404)
            status, _, _ = self.request("GET", "/assets/missing.js", frontend=frontend, headers={"Accept": "*/*"})
            self.assertEqual(status, 404)
            status, _, body = self.request("GET", "/app/route", frontend=frontend, headers={"Accept": "text/html"})
            self.assertEqual(status, 200)
            self.assertEqual(body, b"spa")

    def test_login_snapshot_never_fetches_in_request_thread(self):
        engine = object.__new__(Engine)
        engine.login_nodes = None
        engine.cfg = {"login_nodes": "node=a@b", "source": "ssh", "login_interval": 300}
        engine.login = _ExplodingLogin()

        payload = engine.login_snapshot()

        self.assertTrue(payload["warming_up"])
        self.assertEqual(payload["nodes"], [])
        self.assertEqual(engine.login.calls, 0)


class _ExplodingLogin:
    calls = 0

    def fetch(self, _now):
        self.calls += 1
        raise AssertionError("request thread must not collect")


class _nullcontext:
    def __enter__(self):
        return None

    def __exit__(self, *_args):
        return False


if __name__ == "__main__":
    unittest.main()
