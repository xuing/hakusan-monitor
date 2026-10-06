# Hakusan Monitor

A status dashboard for JAIST's **Hakusan** HPC cluster. One web page shows how
busy the cluster is, where a job can start right now, why queued jobs wait,
and how the cluster is used over time — in 日本語, English and 中文.

It is read-only and gentle on the login node: one reused SSH connection, compact
Slurm queries, and nothing is ever submitted or cancelled. The backend is pure
Python (standard library only); the frontend is a React app the backend serves.

> Community tool, not an official JAIST service.

## What you can see

| Page | What it answers |
|---|---|
| **Overview** | How full is each hardware pool (A40, A100, H100, CPU, …)? Where can my job start now? Who is using what, and when do GPUs free up? |
| **Partitions** | Per-partition load and queue, limits, and whether the default request starts now — with a copyable `salloc` / `sbatch` command. |
| **Analytics** | From the job history: when people submit, when GPUs or whole nodes are free, queue wait per partition, how much of the requested time jobs use, job shapes, interactive sessions, weekly allocation, active users, outcomes. GPU and CPU views. |
| **Login nodes** | Load, CPU / I/O wait, memory, disk pressure and top processes on hakusan1 / hakusan2. |
| **Nodes**, **Jobs** | Every node and every job in sortable, filterable tables. |
| **Slurm guide**, **Containers** | How to submit on Hakusan, and SingularityCE usage (SIF images, Docker conversion, `--nv`). |

Hakusan's 25 partitions are overlapping views of about 7 physical pools (the 16
CPU partitions all share the same 124 `lcpcc` nodes), so the dashboard leads with
**pools** and reports free cores and free GPUs per pool. Every limit and default
it shows is read from the cluster (QoS, partition config, `job_submit.lua`), not
written into the code.

## How it works

![Architecture: the collector reads Slurm on the Hakusan login node over one SSH connection, stores samples and job history in SQLite, and serves the web app with a REST API and Server-Sent Events.](docs/architecture.svg)

- **Sampler thread** — every `HM_SAMPLE_INTERVAL` it reads nodes, queue and
  policy in one SSH round trip (`sources.py`), turns them into pools, partitions
  and verdicts (`normalize.py`), keeps the result in memory, saves it to SQLite
  (`store.py`) and pushes it to every open page over Server-Sent Events.
- **Job-history thread** — reads Slurm accounting with `sacct`
  (`job_history.py`): the full history once, in 30-day chunks, then only the
  latest window. `analytics.py` turns it into the Analytics page, weighting
  every *user* equally so a few accounts with 100k+ jobs don't dominate.
- **HTTP server** (`server.py`) — serves `/api/*` and the built frontend.
  Requests never trigger collection, so pages stay fast even when the cluster
  is slow.
- **Frontend** (`web/`) — React + TypeScript (Vite, Tailwind, shadcn/ui, SVG
  charts, Radix Colors). See [`web/README.md`](web/README.md).

## Load on the cluster

Everything is read-only. One sample serves every viewer — 100 open browsers
still cause one query stream.

| What | How often | Cost |
|---|---|---|
| Nodes, queue, pending jobs' requested totals (`scontrol`, `squeue`, `sacct --state=PENDING`) | `HM_SAMPLE_INTERVAL` (default 300 s) | one SSH round trip, typically 2–5 s |
| CPU start check (`sbatch --test-only`, submits nothing) | `HM_CPU_PROBE_INTERVAL` (900 s) | rides on the same connection |
| Policy: QoS, partitions, `job_submit.lua` | `HM_POLICY_INTERVAL` (24 h) | a few seconds |
| Job history (`sacct -aX`) | `HM_JOBS_INTERVAL` (600 s); first start reads the whole history in chunks, a few minutes | under a second per read |
| Login-node health (`/proc`, `df`, `iostat`, `ps`) | `HM_LOGIN_INTERVAL` (300 s) | one SSH per node, 1–3 s |

The SSH connection is kept warm (`ControlPersist` longer than the sample
interval), and `HM_SSH_HOST` may list fallbacks (`you@hakusan2,you@hakusan1`).

## Try it without a cluster

```bash
cd web && npm install && npm run build && cd ..   # build the web app once
HM_SOURCE=mock python3 backend/server.py          # open http://localhost:8787
```

Mock mode reads `mock/nodes.json`, `mock/squeue.json` and `mock/login_nodes.json`.
They were captured from the live cluster, so they are not in this repository —
supply your own. `python3 scripts/seed_demo.py` adds 14 days of fake history.

## Run it against Hakusan

Use a host on the JAIST network that can `ssh` to the login node without a
password prompt. Keep your account out of git by putting it in `.env`:

```bash
cp .env.example .env              # set HM_SSH_HOST=you@hakusan2 (and optionally HM_LOGIN_NODES)
HM_SOURCE=ssh python3 backend/server.py
```

On a machine that has the Slurm commands itself, use `HM_SOURCE=local`.
`scripts/run.sh ssh|local|mock` wraps both.

For an always-on deployment (systemd user service, Docker Compose, a dedicated
SSH key, serving under a path prefix such as `/hakusan/`, daily policy check),
see [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Develop and test

```bash
python3 -m unittest discover -s tests   # backend
cd web
npm run dev      # http://localhost:5173, proxies /api to :8787 (run the backend too)
npm test         # Vitest
npm run lint     # oxlint
npm run build    # → web/dist, which the backend serves
```

## Configuration

Set these in the environment or in `.env`.

| Variable | Default | Meaning |
|---|---|---|
| `HM_SOURCE` | `mock` | `ssh`, `local` or `mock` |
| `HM_SSH_HOST` | — | SSH target(s), e.g. `you@hakusan2,you@hakusan1` |
| `HM_SSH_OPTS` | keep-alive defaults | extra `ssh` options (key, ControlMaster) |
| `HM_PORT` | `8787` | listen port |
| `HM_SAMPLE_INTERVAL` | `300` | seconds between cluster samples |
| `HM_SOURCE_TIMEOUT` | `75` | seconds before a sample gives up |
| `HM_CPU_PROBE_INTERVAL` | `900` | seconds between CPU start checks |
| `HM_POLICY_INTERVAL` | `86400` | seconds between policy reads |
| `HM_JOB_SUBMIT_LUA` | `/app/slurm/job_submit.lua` | where the submit plugin lives on the cluster |
| `HM_LOGIN_NODES` | — | login nodes to watch, e.g. `hakusan1=you@hakusan1,hakusan2=you@hakusan2` |
| `HM_LOGIN_INTERVAL` | `HM_SAMPLE_INTERVAL` | seconds between login-node samples |
| `HM_LOGIN_TIMEOUT` | `25` | seconds per login-node read |
| `HM_LOGIN_TOP_N` | `12` | top processes / users kept per node |
| `HM_LOGIN_SHOW_ARGS` | `0` | `1` shows (truncated) command arguments |
| `HM_JOBS_INTERVAL` | `600` | seconds between job-history reads |
| `HM_JOBS_RETAIN_DAYS` | `400` | days of job history kept (and read on first start) |
| `HM_ANALYTICS_INTERVAL` | `1800` | seconds between Analytics recomputations |
| `HM_DB` | `data/hakusan.sqlite` | database file |
| `HM_RETAIN_DAYS` | `60` | days of raw samples kept (hourly rollups are kept longer) |
| `HM_LOGIN_RETAIN_DAYS` | `HM_RETAIN_DAYS` | days of login-node samples kept |
| `HM_VISIT_RETAIN_DAYS` | `365` | days of anonymous visit counts kept |
| `HM_CLUSTER_TZ` | `Asia/Tokyo` | time zone Slurm prints times in |
| `HM_MASK_USERS` | `0` | `1` hides user names in the public view |
| `HM_MAX_SSE` | `64` | maximum live connections |
| `HM_PUBLIC_URL` | — | redirect page requests that reach the port directly to this URL |
| `HM_TRUST_PROXY` | `0` | `1` trusts `X-Forwarded-For` (only behind your own proxy) |
| `HM_ACCESS_LOG` | `0` | `1` logs every HTTP request |
| `HM_FRONTEND` | `web/dist` | built web app to serve |

## API

| Endpoint | Returns |
|---|---|
| `GET /api/snapshot` | the current cluster snapshot (versioned JSON) |
| `GET /api/stream` | Server-Sent Events: a new snapshot after every sample |
| `GET /api/analytics` | job-history aggregates for the Analytics page (GPU and CPU views) |
| `GET /api/history?hours=24` | down-sampled cluster time series |
| `GET /api/usage?days=30` | allocation by hour of day and weekday |
| `GET /api/login-nodes` | current login-node health |
| `GET /api/login-nodes/history?hours=24` | login-node history |
| `GET /api/meta` | cluster name, Slurm version, partitions, container info |
| `GET /api/health` | liveness, data source and data age |

## Data and privacy

- Any Hakusan user can already see everyone's jobs with `squeue` / `sacct`;
  `HM_MASK_USERS=1` still hides user names on the public page.
- The job history stores user names only as installation-keyed hashes, and a
  job's submit line only as its first word (`sbatch`, `salloc`, `srun`) — script
  names and paths never leave the cluster.
- Analytics needs a cluster whose `PrivateData` setting lets users see all jobs
  (`sacct -a`), as Hakusan's does.

## Repository layout

```
backend/   server.py · sources.py · normalize.py · store.py · job_history.py ·
           analytics.py · login_nodes.py · lua_policy.py
web/       React frontend (see web/README.md)
tests/     backend unit tests
scripts/   run.sh, demo data, cluster policy check, GPU memory probe
deploy/    systemd units
docs/      deployment, design notes, architecture.svg
```
