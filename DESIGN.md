# Hakusan Monitor — Overall Design

Realizes `PLAN.md`. Covers the data model, API contract, the normalization rules,
the UI layout/components, the visual language, and the i18n key map.

## 1. Data flow & normalization

```
scontrol show nodes --json ─┐
squeue --json ──────────────┼─▶ normalize() ─▶ snapshot (compact) ─▶ cache(TTL) ─▶ /api/snapshot
sinfo --json (fallback) ────┘                         │
                                                       └─▶ append trend point ─▶ trend.jsonl (ring)
```

Normalization rules (the important correctness bits):
- **Dedupe nodes** by `name` from `scontrol show nodes` — never sum `sinfo`
  partition rows (partitions overlap the same physical nodes).
- **Node pools** (physical hardware groups) are derived from node-name prefix +
  gres, independent of the many logical partitions:
  `cpu` (`lcpcc-*`), `a40`, `a100`, `vm-cpu` (`spcc-cld-NN`), `h100-80`
  (`spcc-cld-gl*`), `h100-20c` (`spcc-cld-g09..12`), `lm` (`spcc-cld-lm*`).
- **GPU counting** parses `gres` / `gres_used`: `gpu:<type>:<n>(...)` → totals and
  used per type. Free = total − used.
- **State bucketing:** map raw Slurm states → `{allocated, mixed, idle, down,
  drain, reserved}`. A node is "available" if idle/mixed and not drain/down.
- **Queue:** group `squeue` jobs by `state` (RUNNING/PENDING) and `partition`;
  tally `state_reason` for pending; extract per-job GPU ask from `tres_req_str`.
- **Pressure score** per partition ∈ [0,1]:
  `0.6 * util + 0.4 * min(pending/(running+1), 1)`
  where `util` = GPU util for GPU partitions else CPU util. Buckets:
  `<0.5 low · <0.75 moderate · <0.9 high · ≥0.9 critical`.

## 2. API contract

Backend serves the SPA (static) **and** JSON endpoints. All localizable values are
**stable enum keys**, never prose.

- `GET /api/snapshot` — the whole normalized snapshot (primary; frontend polls
  this). `?fresh=1` bypasses cache.
- `GET /api/trend` — rolling time-series for sparklines.
- `GET /api/health` — `{ok, source, stale, age_s}`.
- `GET /api/meta` — cluster name, slurm version, partitions catalog, container
  info (static + detected).

### `/api/snapshot` shape

```jsonc
{
  "generated_at": 1779800000, "cluster": "hakusan", "slurm_version": "25.05.5",
  "source": "ssh", "stale": false, "age_s": 3,
  "totals": {
    "nodes": { "total": 219, "available": 104, "down": 17,
               "by_state": { "allocated": 88, "mixed": 66, "idle": 47, "down": 17, "drain": 1 } },
    "cpus":   { "total": 35064, "alloc": 28693, "free": 6371, "util": 0.818 },
    "memory": { "total_mb": 0, "alloc_mb": 0, "util": 0.0 },
    "gpus":   { "total": 80, "used": 60, "free": 20, "util": 0.75,
                "by_type": { "nvidia_a40": {"total":40,"used":36}, "...": {} } }
  },
  "pools": [ { "id":"a40","kind":"gpu","nodes":20,"cpus_total":1040,"cpus_alloc":620,
               "util":0.6,"gpu":{"total":40,"used":36,"free":4} } ],
  "partitions": [ { "name":"GPU-1","kind":"gpu","nodes":20,
                    "cpus":{"total":1040,"alloc":620,"util":0.6},
                    "gpu":{"total":40,"used":36,"free":4,"util":0.9},
                    "jobs":{"running":25,"pending":55},
                    "pending_reasons":{"Resources":30,"Priority":15,"QOSMaxCpuPerJobLimit":10},
                    "pressure":0.91,"level":"critical","timelimit":"infinite" } ],
  "gpus": [ { "type":"nvidia_a40","label":"A40","total":40,"used":36,"free":4 } ],
  "queue": { "running":288,"pending":138,"total":426,
             "pending_reasons":{"Resources":50,"Priority":40,"QOSMaxCpuPerJobLimit":30},
             "by_partition":[ {"partition":"GPU-1","running":25,"pending":55} ],
             "top_pending":[ {"job_id":141369,"user":"s2***","partition":"GPU-1A",
                              "gpu":"h100-80c×1","reason":"QOSMaxCpuPerJobLimit","wait_s":3600} ],
             "container_jobs": 0 },
  "nodes_down": [ { "name":"spcc-cld-g09","state":["DOWN"],"reason":"maintenance" } ],
  "top_users": [ { "user":"reno-h","running":12,"cpus":3072,"gpus":0 } ]
}
```

## 3. UI layout

Single scrollable dashboard, max-width ~1240px, 12-col responsive grid.

```
┌──────────────────────────────────────────────────────────────────────┐
│ HAKUSAN ·status   [hakusan ▾ slurm 25.05.5]      🌐 JA EN ZH   ↻ 12s  │  topbar
├──────────────────────────────────────────────────────────────────────┤
│ ┌─ CPU 81.8% ─┐ ┌─ GPU 75% ─┐ ┌─ Nodes 104/219 ─┐ ┌─ Queue 138 wait ─┐ │  hero gauges (KPI)
│ │  ◔ radial   │ │ ◔ radial  │ │  up / busy/down  │ │  R 288 · PD 138  │ │
│ └─────────────┘ └───────────┘ └──────────────────┘ └──────────────────┘ │
├───────────────────────────────────┬──────────────────────────────────┤
│  GPU BOARD                         │  WHERE CAN I RUN NOW? (helper)    │
│  A40   ▓▓▓▓▓▓▓▓▓░  36/40           │  1. VM-CPU   44 idle  ★ instant   │
│  A100  ▓▓▓▓▓▓▓▓▓▓▓▓  20/20 FULL    │  2. A40      4 free    ~short     │
│  H100-80 ▓▓▓▓▓▓▓▓▓▓  4/4  FULL     │  3. A100     full      ~long      │
│  H100-20c ░░░░░░░░ 0/16 (maint)    │  → copy: srun -p VM-CPU ...       │
├───────────────────────────────────┴──────────────────────────────────┤
│  PARTITION PRESSURE                                                     │
│  GPU-1  [████████░] crit  util .90  R25/PD55  reasons: Resources…       │
│  DEF    [██████░░░] high  util .82  R109/PD0                            │
│  VM-CPU [░░░░░░░░░] low   util .00  R3/PD0                              │
│  …                                                                      │
├───────────────────────────────────┬──────────────────────────────────┤
│  QUEUE INSIGHTS                    │  CONTAINERS (Singularity)         │
│  pending reasons donut             │  v4.3.7 · module load …/3.9.5     │
│  longest waits table               │  pull/run examples · gotchas      │
│  trend sparklines (CPU/GPU/PD)     │  container jobs running: N        │
├───────────────────────────────────┴──────────────────────────────────┤
│  QUICK START cheatsheet (Slurm · Conda · Singularity · CUDA)  + docs    │
└──────────────────────────────────────────────────────────────────────┘
   footer: data age · source · disclaimer · official links
```

Components: `KpiGauge`, `GpuBar`, `PartitionRow`, `HelperCard`, `ReasonDonut`,
`Sparkline`, `ContainerPanel`, `Cheatsheet`, `LangSwitcher`, `DownNodes`,
`TopUsers`. All pure functions `render(data, t) -> DOM`.

## 4. Visual language

- **Dark, control-room aesthetic** (HPC ops feel), light mode available.
- Palette: bg `#0c1018`, panel `#151b26`, line `#222c3a`, text `#e6edf6`,
  muted `#8a97a8`. Accent `#4cc2ff` (Hakusan blue). Load ramp green→amber→red:
  `#3fb950 / #d29922 / #f85149`; "full/critical" pulses subtly.
- Type: system UI stack + `ui-monospace` for numbers/IDs. Big tabular-nums for KPIs.
- Charts are **inline SVG**, no libs: radial gauges, horizontal load bars,
  donuts, sparklines. Animated via CSS transitions on width/stroke.
- Accessibility: levels carry text labels + ARIA, not color alone; ≥4.5:1 contrast.

## 5. i18n keys (excerpt)

```
app.title, app.subtitle, refresh.in, refresh.now, updated.ago,
kpi.cpu, kpi.gpu, kpi.nodes, kpi.queue, kpi.running, kpi.pending,
nodes.up, nodes.busy, nodes.down,
gpu.board, gpu.free, gpu.full, gpu.maint,
helper.title, helper.instant, helper.short, helper.long, helper.copy, helper.none,
part.pressure, level.low, level.moderate, level.high, level.critical,
reason.Resources, reason.Priority, reason.QOSMaxCpuPerJobLimit, reason.Other,
queue.insights, queue.longestWait, queue.reasons, trend.title,
container.title, container.version, container.module, container.examples,
container.gotchas, container.jobs,
cheatsheet.title, cheatsheet.slurm, cheatsheet.conda, cheatsheet.singularity,
cheatsheet.cuda, footer.disclaimer, footer.source, lang.name
```

Three locale files: `en.json`, `ja.json` (primary), `zh.json`. Enum-key labels
(`state.*`, `level.*`, `reason.*`, `pool.*`) live in each locale so the backend
stays language-neutral.

## 6. Cloud Design (optional)

The component set above (KpiGauge, GpuBar, PartitionRow, ReasonDonut, Sparkline,
ContainerPanel, etc.) is structured as a small design system and **can be pushed
to claude.ai/design via the DesignSync / `/design-sync` flow** as preview cards —
offered as a follow-up once the working dashboard is validated, since it requires
a design-system project + login.

## 7. As built — deltas from this design

- **Collection is compact, not `--json`.** `sources.py` runs `scontrol -o show
  nodes` + `squeue -h -a -o '<fmt>'` (+ singularity) in **one SSH round trip**
  over a reused `ControlMaster` connection, and parses the text into the same
  `{nodes:[…]}` / `{jobs:[…]}` shapes this design assumed — so `normalize.py` is
  unchanged. Payload ~210 KB vs ~17 MB. Rationale: keep the login node light.
- **Real-time via SSE + SQLite TSDB.** The rolling `trend.jsonl` of the original
  sketch became `store.py` (SQLite raw + hourly rollup). A background sampler
  pushes to SSE subscribers and records history in one step.
- **Added endpoints:** `GET /api/stream` (SSE), `GET /api/history`,
  `GET /api/usage` (peak/trough), alongside `/api/snapshot`, `/api/meta`,
  `/api/health`.
- **GPU board carries `down`/`maint`** so a type whose nodes are offline (e.g.
  H100-MIG) shows *maintenance*, never a misleading "free".

## 8. v2 — React frontend (shadcn/ui + Tremor)

The frontend was rebuilt as a React + TypeScript app (`web/`) — the backend API
is the stable contract, so nothing server-side changed except the new raw-data
endpoints.

- **Stack:** Vite · Tailwind v3 · **shadcn/ui** (owned, copy-in Radix primitives)
  · **Tremor** (KPI gauges, BarList, AreaCharts) · **Radix Colors** dark scales ·
  TanStack Table · react-router. One unified dark theme: shadcn HSL tokens and
  Tremor's `dark-tremor-*` tokens both map onto the Radix slate/blue palette
  (`web/src/index.css` + `tailwind.config.js`).
- **Subsystems (one folder each):** `layout/` (sidebar + topbar shell, language
  switcher, live indicator, resource filter), `dashboard/` (all the live widgets),
  `data/` (reusable TanStack `DataTable` + node/job column defs), `analytics/`
  (usage heatmap + Tremor trends), `common/` + `ui/` (shared + shadcn primitives).
- **Data flow:** a single SSE connection in a `LiveProvider` context feeds every
  widget (`useLive`); table/history/usage views fetch via `useApi`; a
  `ResourceFilterProvider` holds the All/CPU/GPU-type lens.
- **i18n:** `en.ts` is the source of truth for the key set; `ja.ts`/`zh.ts` are
  `Record<TranslationKey, string>` so a missing key fails the type-check.
- **Routing & bundle:** pages are `React.lazy`-split so the Tremor/Recharts
  vendor chunk loads around them.

## 9. v3 — pools-first model (correctness + user value)

User testing exposed that leading with Slurm **partitions** is wrong: Hakusan's
25 partitions are overlapping views of ~7 physical pools (16 CPU partitions = the
same 124 `lcpcc` nodes), so the UI showed "124 nodes / 1.5 TB / 0 free nodes"
sixteen times. Verified every aggregate against `sinfo` — the numbers were exact;
the **framing** was the bug.

- **Hardware pools are the primary entity.** `normalize.py` builds one pool per
  physical group (`cpu`, `vm-cpu`, `lm`, `a40`, `a100`, `h100-80`, `h100-20c`)
  with node-state breakdown, **free cores** (idle cores on mixed nodes — the real
  "can I run" number, not idle whole nodes), GPUs-by-type with `next_free`/`maint`,
  the partitions that submit to it, per-pool queue (R/PD/releasing), an `avail`
  summary, and **`occupants`** — the running jobs (user · GPU/CPU · node · time
  left) so you can see *who is using the H100/A100 right now*.
- **The resource filter transforms the view.** Picking a pool re-scopes the KPI
  cards (e.g. A100 → GPUs used/free, A100 nodes, A100 queue) and the pools/lists,
  instead of repeating cluster-wide CPU/GPU numbers.
- Load bars now reflect real per-pool utilization (VM-CPU 0%, A100 100%), so they
  no longer read as "all red".

## 10. v4 — refinements (raw/derived split, node view, full occupancy)

- **One pull feeds everything.** The SSE snapshot now carries the **raw** `nodes`,
  `jobs` and a `part_pool` map alongside the derived view. The Nodes/Jobs tables
  and the per-pool occupancy all *derive* from this single payload client-side
  (`lib/derive.ts`) — no more separate `/api/nodes` · `/api/jobs` polling. Raw
  (server-provided) and derived (computed here) are cleanly separated.
- **The "All" KPIs are node-centric**, not core-centric: total available nodes,
  **GPU nodes free** and **CPU nodes free** (each with a bar). Picking a pool still
  swaps the KPIs to that pool's own numbers.
- **"Who's using it" shows everyone** — every running job on the pool, in a
  scrollable list with a per-job **search filter** and a **share bar** per row.
- **The helper respects the filter** — choosing H100 recommends H100 (and says
  "will queue" if it's full) instead of redirecting you to a CPU pool.
- Free cores exclude down/drained nodes, so they equal `sinfo`'s idle value exactly.
- **Node-level occupancy**: each row of the Nodes table expands to show the jobs
  running *on that node* (user · job id · GPU/CPU · time left), via a Slurm
  hostlist expander (`expandHostlist`) over the raw jobs. Most-active-users now
  carry a share bar.
