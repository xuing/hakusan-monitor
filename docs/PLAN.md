# Hakusan Monitor — Project Plan

A lightweight, multilingual **status & queue dashboard** for the JAIST **Hakusan**
HPC cluster. It lets anyone open a web page and, in one glance, see *how busy the
cluster is, where there is free capacity, how long the queue is, and how to run
their job (incl. containers)*.

## 1. Goal & audience

- **Audience:** all Hakusan users (students + researchers), mixed JA / EN / ZH.
- **Job to be done:** "Can I run *now*? Which partition / GPU is free? Why is my
  job pending? How do I submit (Slurm / Singularity / Conda)?"
- **Non-goals (v1):** job submission/control, auth/RBAC, per-job accounting UI,
  admin operations. Read-only, zero-privilege.

## 2. Why build (vs. reuse) — research conclusion

Surveyed the current (2026) ecosystem:

| Tool | Why it doesn't fit here |
|---|---|
| [Slurm-web (rackslab)](https://github.com/rackslab/Slurm-web) | Needs `slurmrestd` + Prometheus + LDAP/RBAC — **admin deployment**. |
| [SckyzO](https://github.com/SckyzO/slurm_exporter) / [vpenso](https://github.com/vpenso/prometheus-slurm-exporter) / [rivosinc](https://github.com/rivosinc/prometheus-slurm-exporter) exporters + Grafana | Require a Prometheus/Grafana stack + service account. |
| Open OnDemand | Heavy portal, admin install. |

We are an **unprivileged user** and need something a normal user can
run, that is **multilingual**, simple, and read-only. None of the above fit →
**custom lightweight collector + static dashboard** reading compact
`scontrol`/`squeue` format-string output. We avoid large Slurm JSON payloads on
the login node.

## 3. Live cluster facts (probed 2026-06-27, ground truth for the model)

- Cluster `hakusan`, **Slurm 25.05.5**, HA controllers `lcpcc-adm1/adm2`.
- `scontrol`, `squeue`, `sacct`, `sacctmgr`, and `sbatch --test-only` are
  available to ordinary users.
- **219 unique nodes** (partitions overlap — must dedupe by node name):
  - **124× CPU** `lcpcc-001..124` — 256 cores / ~1.5 TB each. Views: `DEF*`,
    `TINY/SINGLE/SMALL/LARGE/XLARGE/X2LARGE`, `LONG/LONG-L`, Materials-Studio
    app partitions (`MS_*`, `MatStudio`).
  - **20× A40** `spcc-a40g01..20` — 2× A40 each (40 GPUs). Views `GPU-1/S/L`.
  - **10× A100** `spcc-a100g01..10` — 2× A100 each (20 GPUs). Views `GPU-1A/LA`.
  - **44× VM-CPU** `spcc-cld-*` (32c) — partition `VM-CPU`.
  - **4× H100-80GB** `spcc-cld-gl01..04` — partition `VM-GPU-L`.
  - **1× large-mem** `spcc-cld-lm01` — `VM-LM`.
  - **4× H100-20c (MIG)** `spcc-cld-g09..12` — partition `i112` (maintenance).
- **Containers = Singularity-CE 4.3.7 only** (no Docker/Apptainer; compute nodes
  `module load singularity/3.9.5`).
- Snapshot at probe time: **35,064 CPUs @ 81.8% used**, GPUs A40 36/40, A100
  **20/20 full**, H100-80 **4/4 full**; queue **426 jobs (288 R / 138 PD)** —
  GPU partitions are the bottleneck (top pending reason `QOSMaxCpuPerJobLimit`,
  `Resources`, `Priority`).

## 4. Architecture

```
 ┌─────────────┐   ssh / local / mock   ┌──────────────────────────┐   HTTP/SSE ┌────────────┐
 │  hakusan2   │ ◀───  collector   ───▶ │  backend (stdlib Python) │ ◀────────▶ │  browser   │
 │ slurm CLIs  │   compact formats      │  • normalize + dedupe    │  /api/*    │  React SPA │
 │ login stats │   /proc,df,iostat,ps   │  • latest snapshot       │  static    │  i18n      │
 └─────────────┘                        │  • SQLite history        │            └────────────┘
                                        └──────────────────────────┘
```

- **Collector data sources (pluggable via env `HM_SOURCE`):**
  - `ssh` — `ssh "$HM_SSH_HOST" '<compact Slurm commands>'` (default; works
    from any JAIST-network box with the key).
  - `local` — run the CLIs directly (when deployed *on* a cluster login node).
  - `mock` — serve captured fixtures in `mock/` (offline dev / demo).
- **Backend:** **Python 3 stdlib** `http.server` — *zero pip deps* so anyone can
  run it (`python3 backend/server.py`). A sampler thread maintains the latest
  normalized snapshot, records SQLite history, and pushes SSE updates.
- **Frontend:** React + TypeScript SPA under `web/`, built to static files served
  by the backend. Runtime delivery has no CDN dependency.

## 5. Feature modules

**(a) Ease of use**
- One-glance header gauges: CPU %, GPU %, nodes up, queue length, "last updated".
- **"Where can I run now?"** helper: ranks partitions/GPU types by free capacity +
  shortest expected wait, with a copy-paste `srun`/`sbatch` snippet.
- Language switcher **JA / EN / ZH** (persisted), responsive/mobile, dark theme,
  no login.

**(b) Containers**
- Singularity panel: detected version, the `module load singularity/3.9.5` rule,
  pull/run examples, and the known gotchas (session-dir pre-create, no fakeroot,
  bind localhost networking) — surfaced from our prior cluster experience.
- Show count of running jobs that use a container (`squeue` `container` field).

**(c) Current pressure**
- Cluster utilization gauges (CPU cores, memory, GPUs, node states).
- Per-partition **pressure bars** (util + pending/running) with a computed
  pressure level (low/med/high/critical) and wait hint.
- **GPU board:** A40 / A100 / H100-80 / H100-20c — used vs free, per type.
- Queue insights: pending count, pending-by-partition, **pending reasons**
  (why jobs wait), longest wait.

**(d) Extras**
- Trend sparklines (CPU %, GPU %, pending) from the rolling store.
- Down/drained node watch (ops health).
- Top users/accounts by running jobs (privacy toggle; data already public via
  `squeue`).
- Quick-start cheatsheet (Slurm / Conda / Singularity / CUDA) + link to the
  official course material; job lookup by id/user.

## 6. i18n strategy

- All UI strings keyed; dictionaries `frontend/i18n/{en,ja,zh}.json`.
- Default language auto-detected from browser, overridable + persisted
  (`localStorage`). **JA is the cluster's primary language**, so JA is a
  first-class translation, not an afterthought.
- Backend returns **data + stable enum keys** (e.g. `state=allocated`,
  `reason=QOSMaxCpuPerJobLimit`); the frontend localizes labels. No prose from
  the backend.

## 7. Milestones

1. ✅ Research + live probe + fixtures.
2. ✅ Plan + design (`PLAN.md`, `DESIGN.md`).
3. Backend collector + normalized `/api/snapshot` (ssh/local/mock, cache, trend).
4. Multilingual frontend (gauges, partitions, GPU board, queue, containers, helper).
5. Live end-to-end test vs `sinfo/squeue`, README + run/deploy docs.

## 8. Risks / decisions

- **Login-node etiquette:** only cheap read commands, TTL-cached, modest poll —
  never heavy work on the login node (standing project rule).
- **Partition overlap:** always dedupe by node name (use `scontrol show nodes`).
- **Privacy:** usernames are already visible to any user via `squeue`; still
  provide `HM_MASK_USERS` to anonymize in the public view.
- **Portability:** stdlib-only backend + build-less frontend so it runs anywhere
  Python 3 exists, including directly on a login node in `local` mode.

## 9. As built — refinements during implementation

Two requirements landed mid-build and shaped the final design:

- **Real-time + retention/analytics.** A background **sampler thread** pushes each
  new snapshot over **SSE** (`/api/stream`) and persists it to a **SQLite** TSDB
  (`store.py`: raw `samples` pruned to `HM_RETAIN_DAYS` + an indefinitely-kept
  `samples_hourly` rollup). `/api/usage` derives peak/trough by hour-of-day and
  weekday for the *Usage patterns* view; `/api/history` feeds trend sparklines.
- **Minimal login-node load.** Switched from `--json` to **compact format-string**
  queries (`squeue` 16.8 MB → 45 KB; `scontrol` 604 KB → 164 KB), folded
  nodes + queue + singularity into **one SSH round trip** over a **reused
  `ControlMaster` connection**, and made the single sampler TTL-paced (default
  300 s). The controller (`lcpcc-adm1`) does the query work; the login node only
  runs brief read-only clients. See README → *Login-node load*.

## 10. v2 — frontend rewrite (React)

The build-less SPA was rewritten as a proper React app (`web/`) on a deliberate
design-system stack: **shadcn/ui** (owned Radix primitives) + owned SVG charts
on **Tailwind** with a **Radix Colors** dark palette. The Python backend is
unchanged except for two additions to expose *all* raw data — `GET /api/nodes`
and `GET /api/jobs` (full per-node / per-job fields). New structure: five routed
pages (Overview, Partitions, Analytics, Nodes, Jobs) as independent subsystems,
a single SSE connection shared via context, a type-checked ja/en/zh dictionary,
and TanStack data tables for the raw views. See `DESIGN.md` §7 and `../web/README.md`.
