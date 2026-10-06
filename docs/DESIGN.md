# Design

How the dashboard turns Slurm's output into the verdicts it shows, and the
rules that keep two screens from disagreeing. The README covers what the pages
show, configuration and the API; [`DEPLOY.md`](DEPLOY.md) covers running it.

## 1. Data flow

```
scontrol -o show nodes ─────────────┐
squeue -h -a -o <fmt> ──────────────┤
squeue -O tres/SchedNodes/Container ┼─▶ sources.py ─▶ normalize.py ─▶ Engine.latest ─▶ /api/snapshot
sacct --state=PENDING ReqTRES ──────┘                                      │           └─▶ /api/stream (SSE)
sbatch --test-only CPU probes ─▶ probe cache ──┐                           │
sacctmgr / scontrol partition / job_submit.lua ┴─▶ policy cache ───────────┤
                                                                           └─▶ store.py: pool_hourly ─▶ /api/analytics
sacct -aX (job history) ─▶ job_history.py ─▶ store.py: jobs ─▶ analytics.py ─▶ /api/analytics
login-node /proc, df, iostat, ps ─▶ login_nodes.py ─▶ store.py: login_samples ─▶ /api/login-nodes
```

- One sampler thread collects for every viewer; HTTP requests never trigger
  collection. A failed sample keeps serving the last snapshot marked `stale`.
  A database error does not: the fresh snapshot is served, and
  `/api/health` reports the error as `store_error`.
- The snapshot carries the raw `nodes` and `jobs` next to the derived pools
  and partitions. Every page derives from that one payload (`lib/derive.ts`):
  the Nodes and Jobs tables, the occupancy maps and every verdict below.
- `web/src/types/snapshot.ts` is the snapshot contract. The backend sends
  data and stable keys (`state_bucket`, Slurm reason names), never prose.

## 2. Normalization

- **Nodes are deduplicated by name** from `scontrol show nodes`. Partitions
  overlap (Hakusan's 16 CPU partitions share the same 124 nodes), so summing
  partition rows counts hardware several times.
- **Pools are the physical hardware.** A site file's regular expressions
  assign nodes to pools; without one, GPU nodes group by gres type and CPU
  nodes by core count and memory (`site_config.py`). Partitions are views
  onto pools.
- **State buckets** (`bucket_state`): outage flags, then drain/maintenance,
  then busy states, then scheduler holds. An idle node under
  `PLANNED`/`RESERVED` is held, not free. `is_schedulable` is the one test
  for "a new job may land here".
- **Idle is not free.** A GPU on a drained node or a scheduler-held node is
  unused but not available: the backend reports such GPUs as `down` or
  `reserved`, and only `free` is ever labelled free.
- **Times stay in the cluster's zone.** Slurm prints local times without an
  offset. The UI shows them as printed and computes with
  `lib/cluster-time.ts`, which reads them in `HM_CLUSTER_TZ` (sent with
  `/api/site`), so a viewer in another zone sees the cluster's clock and
  correct waits.

## 3. Cluster policy is read from the cluster

No limit or default is written into this repository. Every number the UI
states about a partition comes from one of three sources, read once a day
(`HM_POLICY_INTERVAL`) and cached in `data/cluster_policy.json`:

| source | read with | gives |
|---|---|---|
| QoS | `sacctmgr show qos` | caps (cores, memory, GPUs, nodes, wall), per-user and group concurrency |
| partitions | `scontrol show partition` | QoS wiring, DefMemPerCPU / MaxMemPerCPU |
| submit plugin | `cat job_submit.lua` (+ `stat` of its dated backups) | default tasks/CPUs/GPUs, forced interactive walltime, license requirement, whether a GPU request survives |

`backend/lua_policy.py` reads the Lua literally: comments are stripped first
(they contradict the code — `-- 12 hours` above `max_time = 2880`), then only
plain assignments inside each `job_desc.partition == "NAME"` branch count. A
value no source states is absent, and the UI shows it as absent.

Reading Lua is interpretation, so `scripts/check_cluster_policy.py` checks it
against Slurm daily (`deploy/hakusan-monitor-policy-check.timer`): one held job
per partition (`sbatch -H`, cancelled at once), plus the largest value of every
quick-request field from `web/src/lib/request-limits.ts`
(`boundaryCommands`, emitted by `boundary.emit.test.ts`). It compares the CPUs,
nodes, GPUs and memory Slurm grants with the reading and the hardware;
acceptance alone proves nothing (`-p GPU-1 --exclusive` is accepted and never
starts). Measured values win over the reading, and problems are named on the
project page with the raw sources (`GET /api/policy-source`).

Findings that shape the request builder (`lib/request-command.ts`):

- DefMemPerCPU is set before the plugin runs, so the Lua's `pn_min_memory`
  defaults are never applied.
- The plugin pins the task count unless `-n` is given, so `-c N` alone means
  N CPUs per task; a core count is spelled `-n 1 -c N` (or `-n N` across
  nodes).
- GPU partitions honour `--gres=gpu:N` and `--gpus-per-node=N`. `--gpus` and
  `--gpus-per-task` get the plugin's 1-GPU default added, so multi-GPU
  layouts run one task per GPU (`-n N -c share --gres=gpu:N`).

## 4. The pending queue: one model

`web/src/lib/queue.ts` decides which waiting jobs start before a new one and
what they take. Every "starts now / queues" verdict, contention count and
pending list reads it; nothing else interprets `state_reason`.

Slurm reports one Reason per pending job, but its limits are per partition.
A job queued to `GPU-1,GPU-1A,GPU-S` said `QOSGrpJobsLimit` (GPU-S was at
10/10) while Slurm had already booked it onto an A40 node through GPU-1. Reading
the string as the truth was patched one symptom at a time before this model
existed. The rules:

1. A reason that holds the whole job (hold, dependency, begin time, a limit
   the model cannot count) is believed.
2. GrpJobs and MaxJobsPerUser are counted per partition QoS from the running
   jobs; their reason strings are not read.
3. A job with booked nodes (`SchedNodes`) is next, whatever its reason says.
4. A waiter older than the longest time limit on its nodes is stuck and
   takes nothing.

`queueModel(snap)` then plays the scheduler once over the cluster: waiters in
priority order, each into the first partition of its own list it may start
in, best fit, using up group and per-user slots as it goes. The result —
`claims` per node, `bookings`, `groupFull(partition)` — is memoised per
snapshot. A claim is the share a waiter asks for, not the whole node.

## 5. Verdicts

Each question has one module, and every page reads it:

| question | module | read by |
|---|---|---|
| what is each GPU on a node (ready, contested, short of CPU/memory, reserved, down, full) | `lib/gpu-availability.ts` (pure), adapted by `gpuNodeFacts` in `lib/gpu-fit.ts` | pool cards, GPU status bars |
| does a GPU partition's request start now | `lib/gpu-partition.ts` (`gpuStatus`, `gpuVerdict`) | request panel, partition table, Partitions page |
| does a CPU partition's flagless request start now | `lib/cpu-partition.ts`, with `sbatch --test-only` rows from `lib/cpu-probes.ts` | the same three |
| what tone a pool shows | `lib/pool-status.ts` (`poolPick`, `poolTone`) | filter chip, group header, pool card, collapsed request row |

GPU precedence: maintenance > group cap full > starts now > `--mem` bypass of a
stranded GPU > backfill gap > queues. A pool's tone leads with the same pick
as its collapsed request row, so the chip and the row cannot disagree. Each
state has one label (`verdict.*` in the i18n files).

Rules learned from shipped bugs, each pinned by a test:

- **The default request is not the QoS cap.** `salloc -p VM-GPU-L` asks for
  32 cores × DefMemPerCPU = 476800 MB; the QoS ceiling is `mem=480G`. Fitting
  the cap made three empty H100 nodes read "memory insufficient".
- **One GPU's need never exceeds one GPU's hardware share.** Slurm spreads a
  request larger than a node over two nodes rather than refusing it, so the
  per-GPU need is capped at `node memory / GPUs per node`. Invariant: a fully
  idle, schedulable node's GPUs are always `ready`.
- **Short means the default request queues here,** not that the GPU is
  unusable. The card offers the `--mem` or `-n` that fits.
- **A waiter claims its share, not the node.** Marking every node a waiter
  could use as contested turned two never-startable jobs into "15 GPUs queue".

## 6. Frontend

- One SSE connection in `LiveProvider` feeds every widget (`useLive`), with a
  polling fallback (`lib/live.ts`). Pages are lazy routes.
- `lib/` holds the domain logic as plain functions (no React, no i18n except
  where a function returns a label); `components/` renders it. Components
  are grouped by what they own: `pools/`, `request/`, `partitions/`,
  `dashboard/`, `analytics/`, `data/`, `layout/`, `common/`, `ui/` (shadcn).
- `i18n/en.ts` defines the keys; `ja.ts` and `zh.ts` are typed against it, so
  a missing translation fails the type check. Site files may override strings.
- Colour never carries meaning alone: every tone has a text label.

## 7. Tests

- Display rules are tested against captured cluster records, one fixture
  per display mode, through the same adapter path the pages use:
  `gpu-availability.fixtures.ts` (2026-07-29, 2026-10-01) and
  `queue.fixtures.ts` (2026-10-06, captured and anonymised by
  `scripts/capture_queue_fixture.py`). A failing test means a rule changed.
- Backend: `python3 -m unittest discover -s tests`, including the generated
  collection script run against shell stubs and SQLite rollback/reopen.

## 8. Known gaps

- **Login sampling rides the cluster cycle.** It runs after every cluster
  sample (also a failed one), so `HM_LOGIN_INTERVAL` below
  `HM_SAMPLE_INTERVAL` cannot sample login nodes more often.
- **No HTTP request timeout.** SSE connections are capped (`HM_MAX_SSE`), but
  connection threads and socket writes have no application timeout.
