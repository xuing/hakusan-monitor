#!/usr/bin/env python3
"""Hakusan Monitor — backend (Python 3 stdlib only, zero pip deps).

Architecture:
    Source(ssh|local|mock) ─▶ normalize ─▶ Engine
                                              ├─ keeps latest snapshot (real-time)
                                              ├─ Store (SQLite TSDB: retention + rollup)
                                              └─ fan-out to SSE subscribers
    HTTP: /api/snapshot /api/stream(SSE) /api/history /api/usage /api/visits /api/meta /api/health
          + static SPA.

A background Sampler thread polls on a fixed cadence, so data collection is
decoupled from requests (true real-time push + durable history for peak/trough).

Run:  python3 backend/server.py     (see env vars below)
"""
from __future__ import annotations
import gzip, json, math, os, queue, re, secrets, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import MappingProxyType
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


def clamp(value, low, high):
    return max(low, min(high, value))


def query_float(q, key, default, low, high):
    try:
        value = float(q.get(key, [str(default)])[0])
    except (TypeError, ValueError):
        value = default
    if not math.isfinite(value):
        value = default
    return clamp(value, low, high)


def query_int(q, key, default, low, high):
    try:
        value = int(float(q.get(key, [str(default)])[0]))
    except (OverflowError, TypeError, ValueError):
        value = default
    if not math.isfinite(value):
        value = default
    return clamp(value, low, high)


CFG = {
    "source":     env("HM_SOURCE", "mock"),
    "ssh_host":   env("HM_SSH_HOST", ""),   # set per-user in .env (e.g. you@hakusan2)
    "ssh_opts":   env("HM_SSH_OPTS",
                  "-o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=15 "
                  "-o StrictHostKeyChecking=accept-new "
                  "-o ControlMaster=auto -o ControlPath=~/.ssh/hm-%r@%h:%p "
                  # persist must outlive the sample interval (default 300 s) or
                  # every cycle pays a cold TCP+KEX+auth handshake
                  "-o ControlPersist=600"),
    "port":       int(env("HM_PORT", "8787")),
    "source_timeout": float(env("HM_SOURCE_TIMEOUT", "75")),
    "interval":   float(env("HM_SAMPLE_INTERVAL", "300")),   # 5 min — gentle on the login node
    "cpu_probe_interval": float(env("HM_CPU_PROBE_INTERVAL", "900")),
    "policy_interval": float(env("HM_POLICY_INTERVAL", "86400")),
    "mask_users": env("HM_MASK_USERS", "0") in ("1", "true", "yes"),
    "mock_dir":   env("HM_MOCK_DIR", os.path.join(ROOT, "mock")),
    "db":         env("HM_DB", os.path.join(ROOT, "data", "hakusan.sqlite")),
    "retain_days": int(env("HM_RETAIN_DAYS", "60")),
    "login_retain_days": int(env("HM_LOGIN_RETAIN_DAYS", env("HM_RETAIN_DAYS", "60"))),
    "visit_retain_days": int(env("HM_VISIT_RETAIN_DAYS", "365")),
    "max_sse":    int(env("HM_MAX_SSE", "64")),   # cap concurrent SSE connections
    "trust_proxy": env("HM_TRUST_PROXY", "0") in ("1", "true", "yes"),
    "access_log": env("HM_ACCESS_LOG", "0") in ("1", "true", "yes"),
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
                          cfg["mock_dir"], timeout=cfg["source_timeout"],
                          cpu_probe_interval=cfg["cpu_probe_interval"],
                          policy_interval=cfg["policy_interval"])
        self.login = LoginNodeCollector(
            mode=cfg["source"], nodes=cfg["login_nodes"], ssh_opts=cfg["ssh_opts"],
            mock_dir=cfg["mock_dir"], interval=cfg["login_interval"],
            timeout=cfg["login_timeout"], top_n=cfg["login_top_n"],
            show_args=cfg["login_show_args"], mask_users=cfg["mask_users"])
        self.store = Store(
            cfg["db"], retain_days=cfg["retain_days"],
            login_retain_days=cfg["login_retain_days"],
            visit_retain_days=cfg["visit_retain_days"],
        )
        self.max_sse = cfg["max_sse"]
        self.latest = None
        self.error = None
        self.fail_count = 0     # consecutive failed sample cycles
        self.last_fail_at = 0
        self.sing_version = None
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
            raw_nodes = nodes.get("nodes", [])
            # same last-wins dedupe as normalize(): the per-node array the
            # client iterates must never disagree with the aggregates
            by_name = {}
            for nd in raw_nodes:
                by_name[nd.get("name") or id(nd)] = nd
            raw_nodes = list(by_name.values())
            # Tag each raw node with its hardware pool here — single source of truth;
            # the client also receives the normalized scheduling verdict instead
            # of re-deriving Slurm state semantics in multiple TypeScript modules.
            for nd in raw_nodes:
                nd["pool"] = nz.node_pool(nd.get("name", ""))
                states = nz.state_list(nd)
                nd["state_bucket"] = nz.bucket_state(states)
                nd["schedulable"] = nz.is_schedulable(states)
            jobs = squeue.get("jobs", [])
            if self.cfg["mask_users"]:   # honour the privacy flag in raw data too
                jobs = [{**j, "user_name": nz.mask_user(j.get("user_name", ""), True)} for j in jobs]
            snap = nz.normalize(nodes, squeue,
                                slurm_version=self.src.slurm_version(nodes),
                                mask_users=self.cfg["mask_users"])
            snap.update(generated_at=int(now), age_s=0.0,
                        source=self.cfg["source"], stale=False)
            snap["cpu_submit_probes"] = squeue.get("cpu_submit_probes", [])
            snap["cpu_submit_probes_generated_at"] = squeue.get("cpu_submit_probes_generated_at", 0)
            snap["cpu_submit_probe_interval"] = self.cfg["cpu_probe_interval"]
            if self.src.policy_snapshot:
                snap["policy"] = self.src.policy_snapshot
            # ship the raw data in the same payload — one pull feeds tables,
            # occupancy and the derived dashboard alike (no repeated fetching).
            snap["nodes"] = raw_nodes
            snap["jobs"] = jobs
            self.latest = snap
            self.error = None
            self.fail_count = 0
            self._ready.set()
            self.store.record(snap, int(now))
            self._n += 1
            if self._n % 120 == 1:
                self.store.prune(now)
            # Push the cluster snapshot before login-node collection: a login
            # node timing out must not delay fresh cluster data by its timeout.
            self._broadcast(snap)
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
            return snap
        except Exception as e:
            self.error = str(e)
            self.fail_count += 1
            self.last_fail_at = int(now)
            if self.latest is not None:           # keep serving stale data
                self.latest = {**self.latest, "stale": True, "error": str(e),
                               "fail_count": self.fail_count,
                               "last_fail_at": self.last_fail_at}
                self._broadcast(self.latest)
            print(f"collect failed ({self.fail_count}x): {self.error}", flush=True)
            return None

    def run(self):
        while True:
            t0 = time.time()
            self.sample_once()
            # Fixed cadence: subtract the collection time so a slow round (login
            # node timing out, probe cycle) doesn't push every later sample back —
            # that drift is how data age crept to 6-8 min under failures.
            time.sleep(max(5.0, self.cfg["interval"] - (time.time() - t0)))

    def snapshot(self):
        # Wait briefly for the background sampler's first result, then give up
        # with a fast 503. NEVER collect in the request thread: a slow login node
        # would hold page requests for minutes, and with lazy-loaded routes even
        # route switches hang once the browser's per-origin pool fills up.
        if self.latest is None:
            self._ready.wait(timeout=8)
        if self.latest is None:
            raise RuntimeError(self.error or "warming up — first sample is still collecting")
        s = dict(self.latest)
        s["age_s"] = round(time.time() - s.get("generated_at", time.time()), 1)
        s["fail_count"] = self.fail_count
        if self.last_fail_at:
            s["last_fail_at"] = self.last_fail_at
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
                # Slow subscribers need the newest truth, not four increasingly
                # stale snapshots. Drop the oldest frame and enqueue latest.
                try:
                    q.get_nowait()
                    q.put_nowait(snap)
                except (queue.Empty, queue.Full):
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
                "policy": self.src.policy_snapshot,
                "container": ci, "docs": DOCS,
                "partitions": [{"name": p["name"], "kind": p["kind"]}
                               for p in snap.get("partitions", [])],
                "store": self.store.stats()}

    def health(self):
        ok = self.latest is not None and not self.error
        age = round(time.time() - self.latest["generated_at"], 1) if self.latest else None
        return {"ok": ok, "source": self.cfg["source"], "error": self.error,
                "stale": bool(self.latest and self.latest.get("stale")), "age_s": age}

    def login_snapshot(self):
        if self.login_nodes is None:
            # Never multiply SSH work by request count. The background sampler is
            # the sole collector; during its first pass return an explicit warmup.
            return {"generated_at": 0, "age_s": 0,
                    "interval": self.cfg["login_interval"],
                    "configured": bool(self.cfg["login_nodes"]) or self.cfg["source"] in ("mock", "local"),
                    "nodes": [], "top_users": [], "stale": True,
                    "warming_up": True}
        s = dict(self.login_nodes)
        s["age_s"] = round(time.time() - s.get("generated_at", time.time()), 1)
        return s


# --------------------------------------------------------------------------- #
#  HTTP
# --------------------------------------------------------------------------- #
MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
        ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8"}


def load_static_assets(frontend):
    """Load the trusted web build once; requests only select from this allowlist."""
    assets = {}
    root = os.path.realpath(frontend)
    for directory, subdirs, filenames in os.walk(root, followlinks=False):
        # A build artifact should never need symlinks. Ignoring them prevents a
        # link from making content outside the build available over HTTP.
        subdirs[:] = [name for name in subdirs
                      if not os.path.islink(os.path.join(directory, name))]
        for filename in filenames:
            full = os.path.join(directory, filename)
            if os.path.islink(full) or not os.path.isfile(full):
                continue
            relative = os.path.relpath(full, root).replace(os.sep, "/")
            with open(full, "rb") as f:
                data = f.read()
            assets["/" + relative] = (data, os.path.splitext(filename)[1], filename)
    return MappingProxyType(assets)


class Handler(BaseHTTPRequestHandler):
    server_version = "HakusanMonitor/1.0"
    protocol_version = "HTTP/1.1"
    engine: "Engine"  # injected in main() before serving
    static_assets = {}  # injected in main() before serving

    def log_message(self, format, *args):  # noqa: A002 — silence access log
        if CFG["access_log"]:
            super().log_message(format, *args)

    # ---- helpers ----
    def _json(self, code, body):
        data = json.dumps(body).encode()
        compressed = len(data) >= 1024 and "gzip" in self.headers.get("Accept-Encoding", "").lower()
        if compressed:
            data = gzip.compress(data, compresslevel=5)
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        if compressed:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
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
            request_id = secrets.token_hex(4)
            print(json.dumps({"event": "http_error", "request_id": request_id,
                              "path": path, "type": type(e).__name__, "error": str(e)}),
                  file=sys.stderr, flush=True)
            try:
                self._json(500, {"error": "internal server error", "request_id": request_id})
            except Exception:
                pass

    def do_HEAD(self):
        if urlparse(self.path).path == "/api/stream":
            self.send_response(405)
            self.send_header("Allow", "GET")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.do_GET()

    def _api(self, path):
        eng = self.engine
        q = self._qs()
        if path == "/api/snapshot":
            try:
                return self._json(200, eng.snapshot())
            except Exception:
                return self._json(503, {"error": "snapshot unavailable", "source": CFG["source"]})
        if path == "/api/history":
            hours = query_float(q, "hours", 24, 1, 168)
            until = int(time.time())
            since = until - int(hours * 3600)
            mp = query_int(q, "points", 600, 10, 2000)
            return self._json(200, {"since": since, "until": until,
                                    "points": eng.store.history(since, until, mp)})
        if path == "/api/login-nodes":
            return self._json(200, eng.login_snapshot())
        if path == "/api/login-nodes/history":
            hours = query_float(q, "hours", 24, 1, 168)
            until = int(time.time())
            since = until - int(hours * 3600)
            mp = query_int(q, "points", 600, 10, 2000)
            return self._json(200, {"since": since, "until": until,
                                    "points": eng.store.login_history(since, until, mp)})
        if path == "/api/usage":
            days = query_int(q, "days", 30, 1, 365)
            return self._json(200, eng.store.usage_pattern(days))
        if path == "/api/visits":
            days = query_int(q, "days", 30, 1, 365)
            return self._json(200, eng.store.visit_stats(days))
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
                    # Named event (not an SSE comment): comments are invisible to
                    # EventSource, so the client couldn't tell a quiet-but-alive
                    # stream from a silently dead socket. This feeds its watchdog.
                    self.wfile.write(b"event: ping\ndata: {}\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            eng.unsubscribe(q)

    def _event(self, obj):
        self.wfile.write(b"data: " + json.dumps(obj).encode() + b"\n\n")
        self.wfile.flush()

    def _record_visit(self):
        """Anonymous visit counter: hash(ip|user-agent), never blocks serving."""
        try:
            ua = self.headers.get("User-Agent", "")
            if any(m in ua.lower() for m in ("bot", "crawl", "spider", "curl", "wget")):
                return
            fwd = self.headers.get("X-Forwarded-For", "") if CFG["trust_proxy"] else ""
            ip = fwd.split(",")[0].strip() if fwd else self.client_address[0]
            visitor = self.engine.store.visitor_id(ip, ua)
            self.engine.store.record_visit(visitor, time.time())
        except Exception:
            pass

    def _static(self, path):
        requested = "/index.html" if path in ("/", "") else path
        asset = self.static_assets.get(requested)
        if asset is None:
            # SPA fallback is only for extensionless browser navigations. Missing
            # assets and robots.txt must be honest 404s, never index.html with 200.
            accepts_html = "text/html" in self.headers.get("Accept", "").lower()
            extensionless = not os.path.splitext(requested)[1]
            if accepts_html and extensionless:
                asset = self.static_assets.get("/index.html")
            if asset is None:
                return self._json(404, {"error": "not found"})
        data, ext, filename = asset
        # A served index.html is one SPA page entry — assets/API calls don't count.
        if filename == "index.html" and self.command == "GET":
            self._record_visit()
        compressed = (len(data) >= 1024 and ext in (".html", ".js", ".css", ".json", ".svg")
                      and "gzip" in self.headers.get("Accept-Encoding", "").lower())
        if compressed:
            data = gzip.compress(data, compresslevel=6)
        hashed_asset = bool(re.search(r"-[A-Za-z0-9_-]{8,}\.(?:js|css|svg|png|woff2)$", filename))
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable" if hashed_asset
                         else "public, max-age=3600" if ext in (".svg", ".png", ".woff2")
                         else "no-store")
        if compressed:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)


def main():
    eng = Engine(CFG)
    Handler.engine = eng
    Handler.static_assets = load_static_assets(FRONTEND)
    # Sample in the background so the port binds immediately; early requests get
    # an explicit warming-up response and never perform collection themselves.
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
    if "/index.html" not in Handler.static_assets:
        print(f"  note: no web build at {FRONTEND} — run `cd web && npm install && npm run build`", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
