# Hakusan Monitor

A lightweight, **multilingual** status dashboard for the JAIST **Hakusan** HPC
cluster. Open a web page and see — at a glance — how busy the cluster is, where
there is free capacity, how long the queue is, why jobs are waiting, when the
cluster is usually busy, and how to run your job (including containers).

- **Real-time** — pushed over Server-Sent Events (live, not just polling).
- **Gentle on the login node** — compact `scontrol`/`squeue` queries (~210 KB,
  not 17 MB), one reused SSH connection, read-only. See *Login-node load* below.
- **Data retention & analytics** — every sample is stored in SQLite; the
  *Usage patterns* view shows peak/trough by hour-of-day and weekday.
- **Answers "can I run now, and where?"** — a **hardware-pool** view (free cores
  per CPU pool, free GPUs per type), **who is currently using each resource**, and
  when GPUs next free up. The resource filter re-scopes the entire page.
- **All the raw data, too** — sortable, filterable tables of every node and every
  job, not just the summary.
- **Multilingual and theme-aware** — 日本語 / English / 中文; the theme follows
  the browser unless a user chooses one manually.
- **Zero-dependency backend** — Python 3 standard library only. The frontend is a
  modern React app (Vite + Tailwind + shadcn/ui + Tremor + Radix Colors) built to
  static files the backend serves.

## Architecture

```
 hakusan2 (login)        collector (this app)                       browser
 ┌───────────────┐  ssh  ┌──────────────────────────────────┐ HTTP ┌──────────┐
 │ scontrol -o   │◀──────│ sources.py  acquire (ssh/local/   │◀─────│ SPA      │
 │   show nodes  │ one   │             mock), compact format │ SSE  │ i18n     │
 │ squeue -o ... │ warm  │ normalize.py dedupe + roll up     │─────▶│ live     │
 │ (controller)  │ conn  │ store.py    SQLite TSDB (retain   │ REST │ analytics│
 └───────────────┘       │             + hourly rollup)      │      └──────────┘
                         │ server.py   sampler thread ─┬─ SSE fan-out            
                         │                             └─ /api + static          
                         └──────────────────────────────────┘
```

A background **sampler** thread polls on a fixed cadence and feeds three things
from one result: the in-memory *latest* snapshot (real-time), the SQLite store
(history), and the SSE subscribers (push). Collection is decoupled from requests.

- `backend/sources.py` — acquire raw Slurm data (ssh / local / mock) as compact
  text, parse to a JSON-shaped dict.
- `backend/login_nodes.py` — optional Hakusan 1 / Hakusan 2 health sampler:
  `/proc`, `df`/`df -i`, `iostat` if available, compact `ps`, top processes,
  top users.
- `backend/normalize.py` — pure transform: dedupe overlapping partitions by node,
  count GPUs (incl. ones offline for maintenance), per-partition pressure score.
- `backend/store.py` — SQLite: raw `samples` (retention-pruned) + `samples_hourly`
  rollup (kept) → history & peak/trough analytics.
- `backend/server.py` — sampler thread + SSE + REST + static file serving.
- `web/` — React + TypeScript SPA (Vite, Tailwind, shadcn/ui, Tremor, Radix
  Colors), built to `web/dist` and served by `server.py`. See `web/README.md`.

## Pages

- **Overview** — KPIs that adapt to the selected resource, physical **resource
  pools** (free cores / free GPUs per hardware pool, expandable to show who's
  using it + submission targets), "where can I run now?", upcoming releases,
  queue insights, down nodes, top users.
- **Partitions** — per-partition load and queue (per-node specs + node states)
  and whether each default request can start. CPU `salloc` commands are copyable
  only when backed by `sbatch --test-only`; GPU quick request and `--mem`
  workarounds live in the resource pool cards.
- **Analytics** — peak/trough usage (hour-of-day + weekday × hour heatmap) and 24 h trends.
- **Login nodes** — Hakusan 1 / Hakusan 2 load, CPU/iowait, memory, `iostat`
  disk pressure, top processes and top users. Disk space is shown only as a
  reference.
- **Nodes** / **Jobs** — full sortable, filterable tables of all raw node/job data.
- **Containers** (Guide) — Hakusan-oriented SingularityCE notes: SIF-first
  workflow, Docker/OCI image conversion, GPU `--nv`, bind mounts, clean
  environments, and container services.

The topbar **resource filter** (All / A40 / A100 / H100-80 / H100-MIG / CPU /
VM-CPU / Large-mem) **transforms the whole view** — KPIs, pools and lists all
re-scope to the chosen hardware.

> **Pools, not partitions.** Hakusan's 25 partitions are overlapping *views* of
> ~7 physical pools (the 16 CPU partitions are the same 124 `lcpcc` nodes). The
> dashboard leads with pools and reports **free cores** for CPU (idle cores on
> partially-used nodes), not just idle whole nodes. Aggregates are verified
> against `sinfo` to the digit.

## Login-node load (by design)

This was a hard requirement: **do not burden the Hakusan login node.**

- The heavy lifting (querying every node/job) happens on the **controller**
  (`lcpcc-adm1`), which is built for it — not on the login node. The login node
  only runs the thin read-only `scontrol`/`squeue` clients for a moment.
- We use **compact format strings**, not `--json`: `squeue` output drops from
  **~16.8 MB → ~45 KB** (370×), `scontrol` nodes from 604 KB → 164 KB. Far less
  to serialize and to push through the login node's sshd.
- **One round trip per sample** (nodes + queue + singularity version combined),
  over a **reused SSH connection** (`ControlMaster`/`ControlPersist`) — no repeated
  handshakes.
- A **single TTL-paced sampler** (default **300 s**, configurable) serves all
  viewers; 100 browsers still cause just one query stream. Updates are pushed to
  clients over Server-Sent Events (SSE). Everything is non-mutating: CPU probes
  use `sbatch --test-only`, and the app never submits real jobs, cancels jobs, or
  installs software.

The optional **Login nodes** page monitors Hakusan 1 / Hakusan 2 themselves. It
uses one short read-only command per configured node per interval
(`HM_LOGIN_INTERVAL`, default 300 s): `/proc/loadavg`, `/proc/stat`,
`/proc/meminfo`, `df`, `df -i`, `iostat -x -y 1 1` when available, and compact
`ps` summaries. It stores only summary metrics plus Top N process/user rows in
SQLite. Disk space is displayed for reference; pressure signals come from load,
CPU, memory, D-state processes, and `iostat`.

## Quick start (demo, no cluster)

```bash
# 1) build the web app once
cd web && npm install && npm run build && cd ..
# 2) optional: seed 14 days of fake history for the Analytics page
python3 scripts/seed_demo.py
# 3) run with demo data
HM_SOURCE=mock python3 backend/server.py
# open http://localhost:8787
```

`HM_SOURCE=mock` serves the captured fixtures in `mock/`.

## Live mode (against Hakusan)

Run it from any host on the JAIST network that can `ssh` to the login node with a
working key/agent (no password prompts). Put your own SSH target in a local
`.env` (copy `.env.example`) so your ID never gets committed:

```bash
cp .env.example .env        # then edit HM_SSH_HOST=you@hakusan2
# optional: edit HM_LOGIN_NODES=hakusan1=you@hakusan1,hakusan2=you@hakusan2
# ensure your key is loaded, e.g.  ssh-add ~/.ssh/id_ed25519
HM_SOURCE=ssh python3 backend/server.py      # reads HM_SSH_HOST from .env
```

Or run it **on** a node that has the Slurm CLIs locally:

```bash
HM_SOURCE=local python3 backend/server.py
```

Helper script: `scripts/run.sh ssh` / `scripts/run.sh mock`.

## Frontend development

```bash
cd web
npm install
npm run dev      # http://localhost:5173, proxies /api → :8787 (run the backend too)
npm run build    # → web/dist (what the backend serves in production)
npm run lint     # oxlint
```

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `HM_SOURCE` | `mock` | `ssh` \| `local` \| `mock` |
| `HM_SSH_HOST` | _(unset — put `you@hakusan2` in `.env`)_ | SSH target for `ssh` mode |
| `HM_SSH_OPTS` | sane defaults | ssh options (incl. ControlMaster reuse) |
| `HM_PORT` | `8787` | listen port |
| `HM_SOURCE_TIMEOUT` | `75` | Slurm collection timeout, seconds |
| `HM_SAMPLE_INTERVAL` | `300` | seconds between cluster samples |
| `HM_LOGIN_NODES` | _(unset)_ | optional comma list, e.g. `hakusan1=you@hakusan1,hakusan2=you@hakusan2` |
| `HM_LOGIN_INTERVAL` | `HM_SAMPLE_INTERVAL` | seconds between login-node health samples |
| `HM_LOGIN_TOP_N` | `12` | top process/user rows kept per login node |
| `HM_LOGIN_SHOW_ARGS` | `0` | `1` shows truncated full command args; default shows command name only |
| `HM_LOGIN_TIMEOUT` | `25` | per-node login health command timeout, seconds |
| `HM_MASK_USERS` | `0` | `1` anonymizes usernames in the public view |
| `HM_DB` | `data/hakusan.sqlite` | time-series database path |
| `HM_RETAIN_DAYS` | `60` | raw-sample retention (hourly rollup kept beyond) |
| `HM_FRONTEND` | `web/dist` | directory of the built web app to serve |

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/snapshot` | current normalized snapshot (real-time) |
| `GET /api/stream` | **SSE** — pushes the snapshot on every new sample |
| `GET /api/history?hours=24` | down-sampled time-series for trend charts |
| `GET /api/login-nodes` | current Hakusan login-node health: load, CPU, memory, disk pressure, processes, users |
| `GET /api/login-nodes/history?hours=24` | down-sampled login-node health history |
| `GET /api/usage?days=30` | peak/trough by hour-of-day & weekday (local time) |
| `GET /api/nodes` | full raw node list (every field) — for the Nodes table |
| `GET /api/jobs` | full raw job list (every field) — for the Jobs table |
| `GET /api/meta` | cluster, slurm version, container info, partitions |
| `GET /api/health` | liveness + source + data age |

## Notes & limitations

- Usernames are already visible to any user via `squeue`; `HM_MASK_USERS=1`
  anonymizes them in this public view anyway.
- Usage-pattern times are **server local time** — set `TZ=Asia/Tokyo` for the
  process if the host clock isn't JST.
- Read-only community tool; not an official JAIST service.

See `PLAN.md` and `DESIGN.md` for the full plan and design.
