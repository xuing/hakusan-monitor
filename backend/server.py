#!/usr/bin/env python3
"""Hakusan Monitor — backend (Python 3 stdlib only, zero pip deps).

Architecture:
    Source(ssh|local|mock) ─▶ normalize ─▶ Engine
                                              ├─ keeps latest snapshot (real-time)
                                              ├─ fan-out to SSE subscribers
                                              └─ Store (SQLite: pool_hourly, job history)
    HTTP: /api/snapshot /api/stream(SSE) /api/analytics /api/login-nodes[/history]
          /api/visits /api/policy-source /api/meta /api/site /api/health
          · POST /api/refresh + static SPA.

A background sampler thread polls on a fixed cadence, so collection never
runs in a request thread.

Run:  python3 backend/server.py     (see env vars below)
"""
from __future__ import annotations
import gzip, ipaddress, json, math, os, queue, re, secrets, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import MappingProxyType
from urllib.parse import parse_qs, quote, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analytics               # noqa: E402
import normalize as nz          # noqa: E402
import site_config              # noqa: E402
from job_history import JobHistoryCollector  # noqa: E402
from login_nodes import LoginNodeCollector, public_nodes, summarize_users  # noqa: E402
from sources import CLUSTER_TZ, Source  # noqa: E402
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


def public_location(public_url, path, query=""):
    """Redirect target for a page request that reached the port directly.
    The path and query come from the client, so they are percent-encoded:
    a control character (CR/LF) can never reach the Location header, while
    valid escapes and URL punctuation pass through unchanged."""
    url = public_url + quote(path, safe="/%-._~!$&'()*+,;=:@")
    return url + ("?" + quote(query, safe="/%-._~!$&'()*+,;=:@?") if query else "")


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
    # "refresh now" (POST /api/refresh): at most one extra sample per this many
    # seconds for everyone together; never below 15 s
    "refresh_min_interval": max(15.0, float(env("HM_REFRESH_MIN_INTERVAL", "15"))),
    "cpu_probe_interval": float(env("HM_CPU_PROBE_INTERVAL", "900")),
    "policy_interval": float(env("HM_POLICY_INTERVAL", "86400")),
    # last good policy reading (survives restarts) and the verification report
    # written by scripts/check_cluster_policy.py
    "policy_cache": env("HM_POLICY_CACHE", os.path.join(ROOT, "data", "cluster_policy.json")),
    "policy_check": env("HM_POLICY_CHECK", os.path.join(ROOT, "data", "policy_check.json")),
    # optional site file (sites/hakusan.json): pool names, GPU labels, order, copy
    "site": env("HM_SITE", ""),
    "job_submit_lua": env("HM_JOB_SUBMIT_LUA", ""),
    "mask_users": env("HM_MASK_USERS", "0") in ("1", "true", "yes"),
    "mock_dir":   env("HM_MOCK_DIR", os.path.join(ROOT, "mock")),
    "db":         env("HM_DB", os.path.join(ROOT, "data", "hakusan.sqlite")),
    "retain_days": int(env("HM_RETAIN_DAYS", "60")),
    "login_retain_days": int(env("HM_LOGIN_RETAIN_DAYS", env("HM_RETAIN_DAYS", "60"))),
    "visit_retain_days": int(env("HM_VISIT_RETAIN_DAYS", "365")),
    # job accounting history (sacct) behind /api/analytics
    "jobs_interval": float(env("HM_JOBS_INTERVAL", "600")),
    "jobs_retain_days": int(env("HM_JOBS_RETAIN_DAYS", "400")),
    "analytics_interval": float(env("HM_ANALYTICS_INTERVAL", "1800")),
    "max_sse":    int(env("HM_MAX_SSE", "64")),   # cap concurrent SSE connections
    "trust_proxy": env("HM_TRUST_PROXY", "0") in ("1", "true", "yes"),
    # Page requests that reach the port directly (not via the proxy, not from
    # this host) are redirected here, e.g. http://host/hakusan/. Empty = off.
    "public_url": env("HM_PUBLIC_URL", "").rstrip("/"),
    "access_log": env("HM_ACCESS_LOG", "0") in ("1", "true", "yes"),
    "login_nodes": env("HM_LOGIN_NODES", ""),
    "login_interval": float(env("HM_LOGIN_INTERVAL", env("HM_SAMPLE_INTERVAL", "300"))),
    "login_top_n": int(env("HM_LOGIN_TOP_N", "12")),
    "login_show_args": env("HM_LOGIN_SHOW_ARGS", "0") in ("1", "true", "yes"),
    "login_timeout": float(env("HM_LOGIN_TIMEOUT", "25")),
}

# a relative HM_SITE (sites/hakusan.json) is read from the repository root
SITE = site_config.load(os.path.join(ROOT, CFG["site"]) if CFG["site"] else "")
# the submit plugin's path: HM_JOB_SUBMIT_LUA, else the site file's; empty = none
CFG["job_submit_lua"] = CFG["job_submit_lua"] or SITE.job_submit_lua


# --------------------------------------------------------------------------- #
#  Engine: sample loop + latest snapshot + SSE fan-out
# --------------------------------------------------------------------------- #
class Engine:
    def __init__(self, cfg):
        self.cfg = cfg
        self.src = Source(cfg["source"], cfg["ssh_host"], cfg["ssh_opts"],
                          cfg["mock_dir"], timeout=cfg["source_timeout"],
                          cpu_probe_interval=cfg["cpu_probe_interval"],
                          policy_interval=cfg["policy_interval"],
                          policy_cache=cfg["policy_cache"], policy_check=cfg["policy_check"],
                          lua_path=cfg["job_submit_lua"], probe_order=SITE.probe_order)
        self.login = LoginNodeCollector(
            mode=cfg["source"], nodes=cfg["login_nodes"], ssh_opts=cfg["ssh_opts"],
            mock_dir=cfg["mock_dir"], interval=cfg["login_interval"],
            timeout=cfg["login_timeout"], top_n=cfg["login_top_n"],
            show_args=cfg["login_show_args"], mask_users=cfg["mask_users"])
        self.store = Store(
            cfg["db"], retain_days=cfg["retain_days"],
            login_retain_days=cfg["login_retain_days"],
            visit_retain_days=cfg["visit_retain_days"],
            job_retain_days=cfg["jobs_retain_days"],
        )
        self.jobs = JobHistoryCollector(
            self.src, self.store, lambda: self.latest,
            lambda store, snap, prio, now: analytics.compute_from_store(
                store, snap, prio, now, CLUSTER_TZ, retain_days=cfg["jobs_retain_days"]),
            interval=cfg["jobs_interval"], retain_days=cfg["jobs_retain_days"],
            analytics_interval=cfg["analytics_interval"])
        self.max_sse = cfg["max_sse"]
        self.latest = None
        self.error = None
        self.store_error = None  # the last database write failed (collection may be fine)
        self.fail_count = 0     # consecutive failed sample cycles
        self.last_fail_at = 0
        self.login_nodes = None
        self._subs = set()
        self._lock = threading.Lock()
        self._fetch_lock = threading.Lock()   # only one collection at a time
        self._ready = threading.Event()       # set once the first sample lands
        self._wake = threading.Event()        # "refresh now": cut the sampler's wait short
        self._last_attempt = 0.0              # when the latest collection started
        self._n = 0

    # ---- one sample cycle ----
    def sample_once(self):
        with self._fetch_lock:
            return self._collect()

    def _collect(self):
        now = time.time()
        self._last_attempt = now
        try:
            nodes, squeue = self.src.fetch()
            pool_of = SITE.assign_pools(nodes.get("nodes", []))
            outside = nz.outside_nodes(nodes, pool_of, SITE)
            nodes = nz.cluster_nodes(nodes)
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
                nd["pool"] = pool_of.get(nd.get("name", ""), "other")
                states = nz.state_list(nd)
                nd["state_bucket"] = nz.bucket_state(states)
                nd["schedulable"] = nz.is_schedulable(states)
            jobs = squeue.get("jobs", [])
            if self.cfg["mask_users"]:   # honour the privacy flag in raw data too
                jobs = [{**j, "user_name": nz.mask_user(j.get("user_name", ""), True)} for j in jobs]
            policy = self.src.policy_snapshot
            snap = nz.normalize(nodes, squeue, site=SITE, pool_of=pool_of,
                                cluster=SITE.cluster_name(policy),
                                slurm_version=self.src.slurm_version(nodes),
                                mask_users=self.cfg["mask_users"])
            snap.update(generated_at=int(now), age_s=0.0,
                        refresh_min_interval=self.cfg["refresh_min_interval"],
                        source=self.cfg["source"], stale=False)
            snap["outside_nodes"] = outside
            snap["build"] = self.cfg.get("build", "")
            snap["partition_order"] = SITE.display_order(policy)
            seen = {}
            for pool in snap["pools"]:
                for part in pool["partitions"]:
                    seen[part] = seen.get(part, 0) + 1
            shared = {part for part, n in seen.items() if n > 1}
            for pool in snap["pools"]:
                pool["sample_partition"] = SITE.sample_partition(pool, policy, shared)
            snap["licenses"] = squeue.get("licenses", [])
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
            # Push the cluster snapshot before anything slower: a login node
            # timing out must not delay fresh cluster data by its timeout.
            self._broadcast(snap)
            self._persist(snap, now)
            return snap
        except Exception as e:
            self.error = str(e)
            self.fail_count += 1
            self.last_fail_at = int(now)
            if self.latest is not None:           # keep serving stale data
                self.latest = {**self.latest, "stale": True, "error": str(e),
                               "fail_count": self.fail_count,
                               "last_fail_at": self.last_fail_at}
                # the stored age_s is the one from when it was fresh (0);
                # subscribers must see how old it really is now
                self._broadcast({**self.latest, "age_s": round(
                    time.time() - self.latest.get("generated_at", time.time()), 1)})
            print(f"collect failed ({self.fail_count}x): {self.error}", flush=True)
            return None

    def _persist(self, snap, now):
        """Save the sample's history. A database error costs that history,
        not the snapshot: it is already served and stays fresh, and
        /api/health reports the error apart from collection."""
        try:
            self.store.record(snap, int(now))
            self._n += 1
            if self._n % 120 == 1:
                self.store.prune(now)
            self.store_error = None
        except Exception as e:
            self.store_error = str(e)
            print(f"store failed: {e}", flush=True)

    def _sample_login(self, now):
        try:
            login_payload, refreshed = self.login.fetch(now)
            nodes = login_payload.get("nodes", [])
            login_payload = {**login_payload,
                             "nodes": public_nodes(nodes),
                             "top_users": summarize_users(nodes, self.cfg["login_top_n"])}
            self.login_nodes = login_payload
            if refreshed:
                self.store.record_login(login_payload, int(now))
        except Exception as e:
            self.login_nodes = {"generated_at": int(now), "age_s": 0,
                                "configured": bool(self.cfg["login_nodes"]),
                                "nodes": [], "top_users": [], "stale": True,
                                "error": str(e)}

    def run_login(self):
        """Login nodes are separate machines on their own cadence
        (HM_LOGIN_INTERVAL): a slow or failing cluster sample neither
        delays nor stops them, and they never delay the cluster data."""
        while True:
            t0 = time.time()
            self._sample_login(t0)
            time.sleep(max(5.0, self.cfg["login_interval"] - (time.time() - t0)))

    def run(self):
        while True:
            t0 = time.time()
            self.sample_once()
            # Fixed cadence: subtract the collection time so a slow round (login
            # node timing out, probe cycle) doesn't push every later sample back —
            # that drift is how data age crept to 6-8 min under failures.
            self._wake.wait(max(5.0, self.cfg["interval"] - (time.time() - t0)))
            self._wake.clear()

    def request_refresh(self, now=None):
        """Wake the sampler for an extra sample, at most once per
        refresh_min_interval across all viewers (one sample serves everyone,
        so the cluster sees the same load however many people click).
        A click while a collection runs queues the next one (the running
        one started before the click), so a new sample always follows.
        -> {"accepted": bool, "retry_after": seconds, "queued": bool}."""
        now = time.time() if now is None else now
        with self._lock:
            if self._wake.is_set():
                return {"accepted": False, "retry_after": 0, "queued": True}
            wait = self.cfg["refresh_min_interval"] - (now - self._last_attempt)
            if wait > 0:
                return {"accepted": False, "retry_after": math.ceil(wait)}
            self._wake.set()
            return {"accepted": True, "retry_after": 0}

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
        sing = self.src.singularity   # read once, kept in the policy cache
        ci = {"runtime": sing["runtime"], "version": sing["version"],
              "command": "singularity"} if sing else None
        return {"cluster": snap.get("cluster") or SITE.cluster_name(self.src.policy_snapshot),
                "slurm_version": snap.get("slurm_version", ""),
                "source": self.cfg["source"], "interval": self.cfg["interval"],
                "login_nodes": {"configured": bool(self.cfg["login_nodes"]) or self.cfg["source"] in ("mock", "local"),
                                "interval": self.cfg["login_interval"],
                                "top_n": self.cfg["login_top_n"],
                                "show_args": self.cfg["login_show_args"]},
                "policy": self.src.policy_snapshot,
                "container": ci,
                "partitions": [{"name": p["name"], "kind": p["kind"]}
                               for p in snap.get("partitions", [])],
                "store": self.store.stats()}

    def health(self):
        ok = self.latest is not None and not self.error
        age = round(time.time() - self.latest["generated_at"], 1) if self.latest else None
        return {"ok": ok, "source": self.cfg["source"], "error": self.error,
                "store_error": self.store_error,
                "stale": bool(self.latest and self.latest.get("stale")), "age_s": age}

    def policy_source(self):
        """Raw cluster policy texts (job_submit.lua, sacctmgr QoS, scontrol
        partitions) plus our reading of them and the last verification run —
        the project page shows these side by side. Large, so never part of
        the snapshot."""
        src = self.src.policy_sources or {}
        pol = self.src.policy_snapshot or {}
        return {"fetched_at": src.get("fetched_at", 0),
                "interval": self.cfg["policy_interval"],
                "lua_text": src.get("lua", ""),
                "qos_text": src.get("qos", ""),
                "partitions_text": src.get("partitions", ""),
                "lua": pol.get("lua") or {},
                "check": self.src._read_check()}

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
        # data older than three sampling rounds is stale whatever the last
        # round claimed (a hung collector never gets to flip the flag itself)
        if s.get("generated_at") and s["age_s"] > 3 * max(60, self.cfg["login_interval"]):
            s["stale"] = True
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


def build_id(assets):
    """The web build being served: the hash in its entry script's name
    (index-<hash>.js), "" without a build. Open pages compare it with their
    own and reload onto a new deploy."""
    page = assets.get("/index.html")
    m = re.search(rb"assets/index-([A-Za-z0-9_-]+)\.js", page[0]) if page else None
    return m.group(1).decode() if m else ""


class Handler(BaseHTTPRequestHandler):
    server_version = "HakusanMonitor/1.0"
    protocol_version = "HTTP/1.1"
    # Each connection holds a thread. A client that connects and sends
    # nothing, idles on keep-alive, or stops reading its live stream is
    # dropped after this long instead of holding its thread forever; at
    # 60 s a 600 KB snapshot still reaches a 10 KB/s link.
    timeout = 60
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
            if self._should_redirect_public():
                return self._redirect_public(path)
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

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            # no body is expected; drain one if sent so keep-alive stays in sync
            length = min(int(self.headers.get("Content-Length") or 0), 4096)
            if length > 0:
                self.rfile.read(length)
            if path != "/api/refresh":
                return self._json(404, {"error": "unknown endpoint"})
            result = self.engine.request_refresh()
            # 202: a sample is on its way and arrives over the stream;
            # 429: someone refreshed moments ago (or one is running)
            return self._json(202 if result["accepted"] else 429, result)
        except (BrokenPipeError, ConnectionResetError):
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
        if path == "/api/login-nodes":
            return self._json(200, eng.login_snapshot())
        if path == "/api/login-nodes/history":
            hours = query_float(q, "hours", 24, 1, 168)
            until = int(time.time())
            since = until - int(hours * 3600)
            mp = query_int(q, "points", 600, 10, 2000)
            return self._json(200, {"since": since, "until": until,
                                    "points": eng.store.login_history(since, until, mp)})
        if path == "/api/analytics":
            return self._json(200, eng.jobs.payload())
        if path == "/api/visits":
            days = query_int(q, "days", 30, 1, 365)
            return self._json(200, eng.store.visit_stats(days))
        if path == "/api/policy-source":
            return self._json(200, eng.policy_source())
        if path == "/api/site":
            out = SITE.public(eng.src.policy_snapshot)
            # the zone Slurm prints its times in; the page reads them in it
            out["time_zone"] = getattr(CLUSTER_TZ, "key", "")
            # the Containers page only where `singularity` answered on the cluster
            out["pages"]["containers"] = bool(eng.src.singularity) or CFG["source"] == "mock"
            return self._json(200, out)
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
                    ping = json.dumps({"build": CFG.get("build", "")}).encode()
                    self.wfile.write(b"event: ping\ndata: " + ping + b"\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass   # gone, or stopped reading for `timeout` seconds
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

    def _should_redirect_public(self):
        if not CFG["public_url"] or self.headers.get("X-Forwarded-For"):
            return False
        return not ipaddress.ip_address(self.client_address[0].removeprefix("::ffff:")).is_loopback

    def _redirect_public(self, path):
        self.send_response(302)
        self.send_header("Location", public_location(CFG["public_url"], path, urlparse(self.path).query))
        self.send_header("Content-Length", "0")
        self.end_headers()

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
    CFG["build"] = build_id(Handler.static_assets)
    # Sample in the background so the port binds immediately; early requests get
    # an explicit warming-up response and never perform collection themselves.
    threading.Thread(target=eng.run, daemon=True).start()
    threading.Thread(target=eng.run_login, daemon=True).start()
    if eng.jobs.enabled:
        threading.Thread(target=eng.jobs.run, daemon=True).start()
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
