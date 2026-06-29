#!/usr/bin/env python3
"""Hakusan Monitor — backend (Python 3 stdlib only, zero pip deps).

Architecture:
    Source(ssh|local|mock) ─▶ normalize ─▶ Engine
                                              ├─ keeps latest snapshot (real-time)
                                              ├─ Store (SQLite TSDB: retention + rollup)
                                              └─ fan-out to SSE subscribers
    HTTP: /api/snapshot /api/stream(SSE) /api/history /api/usage /api/meta /api/health
          + static SPA.

A background Sampler thread polls on a fixed cadence, so data collection is
decoupled from requests (true real-time push + durable history for peak/trough).

Run:  python3 backend/server.py     (see env vars below)
"""
from __future__ import annotations
import json, os, sys, time, queue, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import normalize as nz          # noqa: E402
from login_nodes import LoginNodeCollector, summarize_users  # noqa: E402
from sources import Source      # noqa: E402
from store import Store         # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Serve the built React app (web/dist); HM_FRONTEND overrides it.
FRONTEND = os.environ.get("HM_FRONTEND", os.path.join(ROOT, "web", "dist"))


def load_dotenv(path: str) -> None:
    """Tiny KEY=VALUE loader (stdlib only) so config like HM_SSH_HOST can live in
    a local .env. Real environment / systemd / docker values take precedence."""
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except FileNotFoundError:
        pass


load_dotenv(os.path.join(ROOT, ".env"))   # before CFG is read


def env(name: str, default: str) -> str:
    return os.environ.get(name, default)


CFG = {
    "source":     env("HM_SOURCE", "mock"),
    "ssh_host":   env("HM_SSH_HOST", ""),   # set per-user in .env (e.g. you@hakusan2)
    "ssh_opts":   env("HM_SSH_OPTS",
                  "-o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=15 "
                  "-o StrictHostKeyChecking=accept-new "
                  "-o ControlMaster=auto -o ControlPath=~/.ssh/hm-%r@%h:%p "
                  "-o ControlPersist=120"),   # reuse one warm connection
    "port":       int(env("HM_PORT", "8787")),
    "source_timeout": float(env("HM_SOURCE_TIMEOUT", "75")),
    "interval":   float(env("HM_SAMPLE_INTERVAL", "300")),   # 5 min — gentle on the login node
    "mask_users": env("HM_MASK_USERS", "0") in ("1", "true", "yes"),
    "mock_dir":   env("HM_MOCK_DIR", os.path.join(ROOT, "mock")),
    "db":         env("HM_DB", os.path.join(ROOT, "data", "hakusan.sqlite")),
    "retain_days": int(env("HM_RETAIN_DAYS", "60")),
    "max_sse":    int(env("HM_MAX_SSE", "64")),   # cap concurrent SSE connections
    "login_nodes": env("HM_LOGIN_NODES", ""),
    "login_interval": float(env("HM_LOGIN_INTERVAL", env("HM_SAMPLE_INTERVAL", "300"))),
    "login_top_n": int(env("HM_LOGIN_TOP_N", "12")),
    "login_show_args": env("HM_LOGIN_SHOW_ARGS", "0") in ("1", "true", "yes"),
    "login_timeout": float(env("HM_LOGIN_TIMEOUT", "25")),
}

CONTAINER_INFO = {
    "runtime": "SingularityCE", "version": "4.3.7-noble", "has_docker": False,
    "login_module": None, "compute_module": None, "command": "singularity",
    "examples": [
        "singularity pull python_3.12.sif docker://python:3.12",
        "srun -p VM-CPU -c 8 --mem 16G --pty bash -lc "
        "'singularity exec python_3.12.sif python3 -V'",
    ],
}
DOCS = {"course_material": "https://jstorage.app.box.com/v/hakusan20260618ja"}


# --------------------------------------------------------------------------- #
#  Engine: sample loop + latest snapshot + SSE fan-out
# --------------------------------------------------------------------------- #
class Engine:
    def __init__(self, cfg):
        self.cfg = cfg
        self.src = Source(cfg["source"], cfg["ssh_host"], cfg["ssh_opts"],
                          cfg["mock_dir"], timeout=cfg["source_timeout"])
        self.login = LoginNodeCollector(
            mode=cfg["source"], nodes=cfg["login_nodes"], ssh_opts=cfg["ssh_opts"],
            mock_dir=cfg["mock_dir"], interval=cfg["login_interval"],
            timeout=cfg["login_timeout"], top_n=cfg["login_top_n"],
            show_args=cfg["login_show_args"], mask_users=cfg["mask_users"])
        self.store = Store(cfg["db"], retain_days=cfg["retain_days"])
        self.max_sse = cfg["max_sse"]
        self.latest = None
        self.error = None
        self.sing_version = None
        self.raw_nodes = []        # full parsed lists for the raw-data tables
        self.raw_jobs = []
        self.login_nodes = None
        self._subs = set()
        self._lock = threading.Lock()
        self._fetch_lock = threading.Lock()   # only one collection at a time
        self._ready = threading.Event()       # set once the first sample lands
        self._n = 0

    # ---- one sample cycle ----
    def sample_once(self):
        with self._fetch_lock:
            return self._collect()

    def _collect(self):
        now = time.time()
        try:
            nodes, squeue = self.src.fetch()
            self.sing_version = self.src.singularity   # captured in the same round trip
            self.raw_nodes = nodes.get("nodes", [])
            # Tag each raw node with its hardware pool here — single source of truth;
            # the client reads node.pool instead of re-deriving the name→pool mapping.
            for nd in self.raw_nodes:
                nd["pool"] = nz.node_pool(nd.get("name", ""))
            jobs = squeue.get("jobs", [])
            if self.cfg["mask_users"]:   # honour the privacy flag in raw data too
                jobs = [{**j, "user_name": nz.mask_user(j.get("user_name", ""), True)} for j in jobs]
            self.raw_jobs = jobs
            snap = nz.normalize(nodes, squeue,
                                slurm_version=self.src.slurm_version(nodes),
                                mask_users=self.cfg["mask_users"])
            snap.update(generated_at=int(now), age_s=0.0,
                        source=self.cfg["source"], stale=False)
            snap["cpu_submit_probes"] = squeue.get("cpu_submit_probes", [])
            # ship the raw data in the same payload — one pull feeds tables,
            # occupancy and the derived dashboard alike (no repeated fetching).
            snap["nodes"] = self.raw_nodes
            snap["jobs"] = self.raw_jobs
            self.latest = snap
            self.error = None
            self._ready.set()
            self.store.record(snap, int(now))
            self._n += 1
            if self._n % 120 == 1:
                self.store.prune(now)
            try:
                login_payload, refreshed = self.login.fetch(now)
                login_payload = {**login_payload,
                                 "top_users": summarize_users(login_payload.get("nodes", []))}
                self.login_nodes = login_payload
                if refreshed:
                    self.store.record_login(login_payload, int(now))
            except Exception as e:
                self.login_nodes = {"generated_at": int(now), "age_s": 0,
                                    "configured": bool(self.cfg["login_nodes"]),
                                    "nodes": [], "top_users": [], "stale": True,
                                    "error": str(e)}
            self._broadcast(snap)
            return snap
        except Exception as e:
            self.error = str(e)
            if self.latest is not None:           # keep serving stale data
                self.latest = {**self.latest, "stale": True, "error": str(e)}
            return None

    def run(self):
        while True:
            self.sample_once()
            time.sleep(self.cfg["interval"])

    def snapshot(self):
        # Wait briefly for the background sampler's first result before triggering
        # our own fetch — avoids a duplicate query on the login node.
        if self.latest is None:
            self._ready.wait(timeout=12)
        if self.latest is None:
            self.sample_once()
        if self.latest is None:
            raise RuntimeError(self.error or "no data yet")
        s = dict(self.latest)
        s["age_s"] = round(time.time() - s.get("generated_at", time.time()), 1)
        return s

    # ---- SSE pub/sub ----
    def subscribe(self):
        with self._lock:
            if len(self._subs) >= self.max_sse:   # too many live connections
                return None
            q = queue.Queue(maxsize=4)
            self._subs.add(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            self._subs.discard(q)

    def _broadcast(self, snap):
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(snap)
            except queue.Full:
                pass

    def meta(self):
        snap = self.latest or {}
        ci = dict(CONTAINER_INFO)
        if self.sing_version:
            ci["version"] = self.sing_version
        return {"cluster": snap.get("cluster", "hakusan"),
                "slurm_version": snap.get("slurm_version", ""),
                "source": self.cfg["source"], "interval": self.cfg["interval"],
                "login_nodes": {"configured": bool(self.cfg["login_nodes"]) or self.cfg["source"] in ("mock", "local"),
                                "interval": self.cfg["login_interval"],
                                "top_n": self.cfg["login_top_n"],
                                "show_args": self.cfg["login_show_args"]},
                "container": ci, "docs": DOCS,
                "partitions": [{"name": p["name"], "kind": p["kind"]}
                               for p in snap.get("partitions", [])],
                "store": self.store.stats()}

    def health(self):
        ok = self.latest is not None and not self.error
        return {"ok": ok, "source": self.cfg["source"], "error": self.error,
                "age_s": round(time.time() - self.latest["generated_at"], 1)
                if self.latest else None}

    def login_snapshot(self):
        if self.login_nodes is None:
            payload, _ = self.login.fetch(time.time())
            self.login_nodes = {**payload, "top_users": summarize_users(payload.get("nodes", []))}
        s = dict(self.login_nodes)
        s["age_s"] = round(time.time() - s.get("generated_at", time.time()), 1)
        return s


# --------------------------------------------------------------------------- #
#  HTTP
# --------------------------------------------------------------------------- #
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
        ".woff2": "font/woff2"}


class Handler(BaseHTTPRequestHandler):
    server_version = "HakusanMonitor/1.0"
    protocol_version = "HTTP/1.1"
    engine: "Engine"  # injected in main() before serving

    def log_message(self, format, *args):  # noqa: A002 — silence access log
        pass

    # ---- helpers ----
    def _json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _qs(self):
        return parse_qs(urlparse(self.path).query)

    # ---- routing ----
    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/stream":
                return self._stream()
            if path.startswith("/api/"):
                return self._api(path)
            return self._static(path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                self._json(500, {"error": str(e)})
            except Exception:
                pass

    do_HEAD = do_GET

    def _api(self, path):
        eng = self.engine
        q = self._qs()
        if path == "/api/snapshot":
            try:
                return self._json(200, eng.snapshot())
            except Exception as e:
                return self._json(503, {"error": str(e), "source": CFG["source"]})
        if path == "/api/nodes":
            return self._json(200, {"generated_at": int(time.time()),
                                    "count": len(eng.raw_nodes), "nodes": eng.raw_nodes})
        if path == "/api/jobs":
            return self._json(200, {"generated_at": int(time.time()),
                                    "count": len(eng.raw_jobs), "jobs": eng.raw_jobs})
        if path == "/api/history":
            hours = float(q.get("hours", ["24"])[0])
            until = int(time.time())
            since = until - int(hours * 3600)
            mp = int(q.get("points", ["600"])[0])
            return self._json(200, {"since": since, "until": until,
                                    "points": eng.store.history(since, until, mp)})
        if path == "/api/login-nodes":
            return self._json(200, eng.login_snapshot())
        if path == "/api/login-nodes/history":
            hours = float(q.get("hours", ["24"])[0])
            until = int(time.time())
            since = until - int(hours * 3600)
            mp = int(q.get("points", ["600"])[0])
            return self._json(200, {"since": since, "until": until,
                                    "points": eng.store.login_history(since, until, mp)})
        if path == "/api/usage":
            days = int(q.get("days", ["30"])[0])
            return self._json(200, eng.store.usage_pattern(days))
        if path == "/api/meta":
            return self._json(200, eng.meta())
        if path == "/api/health":
            h = eng.health()
            return self._json(200 if h["ok"] else 503, h)
        return self._json(404, {"error": "unknown endpoint"})

    def _stream(self):
        """Server-Sent Events: push the snapshot on every new sample."""
        self.close_connection = True
        eng = self.engine
        q = eng.subscribe()
        if q is None:   # connection cap reached — tell the client to poll instead
            self.send_response(503)
            self.send_header("Retry-After", "30")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            if eng.latest is not None:
                self._event(eng.snapshot())
            while True:
                try:
                    snap = q.get(timeout=15)
                    self._event(snap)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")   # heartbeat
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            eng.unsubscribe(q)

    def _event(self, obj):
        self.wfile.write(b"data: " + json.dumps(obj).encode() + b"\n\n")
        self.wfile.flush()

    def _static(self, path):
        root = os.path.realpath(FRONTEND)
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        full = os.path.realpath(os.path.join(root, rel))
        # contain to FRONTEND (commonpath isn't fooled by sibling-prefix dirs)
        if os.path.commonpath([full, root]) != root or not os.path.isfile(full):
            full = os.path.join(root, "index.html")   # SPA fallback
            if not os.path.isfile(full):
                return self._json(404, {"error": "not found"})
        with open(full, "rb") as f:
            data = f.read()
        ext = os.path.splitext(full)[1]
        cacheable = ext in (".js", ".css", ".svg", ".png", ".woff2")
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=60" if cacheable else "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)


def main():
    eng = Engine(CFG)
    Handler.engine = eng
    # Sample in the background so the port binds immediately; the first request
    # lazily triggers a fetch if the background sample hasn't landed yet.
    threading.Thread(target=eng.run, daemon=True).start()
    httpd = ThreadingHTTPServer(("0.0.0.0", CFG["port"]), Handler)
    print(f"Hakusan Monitor · source={CFG['source']} · "
          f"http://localhost:{CFG['port']} · sample={CFG['interval']}s · "
          f"db={CFG['db']} · mask_users={CFG['mask_users']}", flush=True)
    if CFG["source"] == "ssh":
        if CFG["ssh_host"]:
            print(f"  SSH target: {CFG['ssh_host']} (needs working key/agent)", flush=True)
        else:
            print("  WARNING: HM_SSH_HOST is not set — set it in .env (e.g. you@hakusan2). "
                  "See .env.example.", flush=True)
    if not os.path.isfile(os.path.join(FRONTEND, "index.html")):
        print(f"  note: no web build at {FRONTEND} — run `cd web && npm install && npm run build`", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
