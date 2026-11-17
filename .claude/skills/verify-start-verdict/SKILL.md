---
name: verify-start-verdict
description: "Generated-input verification (fast-check) of the start verdict: the queue play in web/src/lib/queue.ts, Slurm node selection in node-select.ts, and the starts-now / queues verdicts and slider limits in gpu-fit.ts, gpu-partition.ts and cpu-probes.ts. Use before committing any change to those files, to derive.ts node-state helpers, slurm.ts walltime/policy helpers, the snapshot shape (types/snapshot.ts, backend/normalize.py, backend/sources.py policy), or when a starts-now / queues / GPU-count / core- or --mem-slider verdict looks wrong."
---

# Verify the start verdict

The dashboard tells a user whether a request starts now or queues, how many GPUs start now, and where the core and --mem sliders stop starting now. Several modules share that job:
- **queue.ts** plays the Slurm queue once: which waiting jobs start first and what they take, called the **claims**.
- **node-select.ts** ports Slurm 25.05's node selection.
- **gpu-fit.ts, gpu-partition.ts and cpu-probes.ts** turn that into the verdicts on the Overview, the Partitions page and the request panel.

A wrong verdict sends people to submit into a queue, or away from free hardware. The fixture tests pin a few real snapshots. This check runs seven properties over hundreds of generated cluster states on every run.

**Tool: fast-check 4.10.2**, pinned in web/package.json and run under vitest. It runs the real TypeScript, with nothing re-implemented, on generated inputs and shrinks a failure to a small case. No verifier runs on TypeScript, so every claim is bounded by the generator (see Bounds). The question is "does this pure function hold for every input", not "can events interleave badly", so a model checker would only check a hand-written copy of the code.

## Does my change touch it?

Covered code (sync commit below):

| file | functions |
|---|---|
| web/src/lib/node-select.ts | selectNodes, nodeCounts, endsBeforeBooking, usableCpus, evalTopo, switchTable |
| web/src/lib/queue.ts | queueModel/buildModel (classify, the play, claims, bookings, slotsLeft, groupFull), partitionRooms, requestOf, shareOf, nodeOpenUntil, reasonKind |
| web/src/lib/gpu-fit.ts | gpuFitSnapshot, gpuFitFromNodes, gpuFitWithMemOverride, fitHasClearSlot, withinBackfillWindow |
| web/src/lib/gpu-partition.ts | gpuStatus, gpuStartCount, layoutFit |
| web/src/lib/cpu-probes.ts | liveCpuStart, cpuStartLimits, cpuStartMemMb (called directly), newRequest, placeNow |
| web/src/lib/gpu-availability.ts, gpu-layout.ts | gpuPerGpuNeed, gpuLayouts (inputs to the above) |
| web/src/lib/slurm.ts | requestEndsAt, defaultRequestSec, parseWalltimeSec, wallLabelSec, partitionCap, partitionPolicy, allowsMultiNode, capPerGpu |
| web/src/lib/derive.ts | partitionNodes, nodeIsSchedulable, nodeIsBackfillCandidate, nodeNeedsAttention, nodeIsSchedulerHeld, parseGpuCount, expandHostlist |
| web/src/types/snapshot.ts, backend/normalize.py is_schedulable, backend/sources.py build_policy_snapshot | the snapshot and policy shape the generator builds |

**Sync commit: 1147a34** (1147a3426529a9d5fd968a5f9bb1b50736420f7c). At this commit the properties, the generator and the findings record below were confirmed to describe the covered code. To see whether the verification may be out of date:

```sh
git diff --stat 1147a34 -- web/src/lib/{node-select,queue,gpu-fit,gpu-partition,cpu-probes,gpu-availability,gpu-layout,slurm,derive}.ts web/src/types/snapshot.ts backend/normalize.py backend/sources.py
```

Any output means: run the check and reread the properties against the diff. A change only to derive.ts gpuNodeParts or to other derive.ts functions not in the table does not affect it. Move the sync commit forward (edit it here) only after you have confirmed, at the new commit, that each property, the generator's assumptions and the findings record still describe the code. A passing run alone does not show that.

## Run it

```sh
cd web && npm run verify                          # ~5 s: 400 cases per property (P1 2000, P6 200)
cd web && VERIFY_RUNS=3000 npm run verify         # ~20 s: before a release or after a big change
cd web && VERIFY_SEED=<seed> npm run verify -- -t "P2"   # replay one failure (its seed is printed with it)
cd web && npm run verify:mutants                  # ~55 s: after editing the verification itself
```

Files:
- web/src/verify/start-verdict.verify.ts: the properties.
- web/src/verify/start-verdict.scenario.ts: the generator (Scenario, settle, buildSnapshot, tell).
- web/vitest.verify.config.ts: keeps the check out of `npm test`.
- web/scripts/verify-mutants.mjs: the mutation self-test.

`npm run verify` writes only what any vitest run writes: Vite/Vitest caches under web/node_modules (.vite, .vite-temp, .vitest-cache). `npm run verify:mutants` works in a fresh system temp dir that it deletes at the end. The copy has its own node_modules directory of symlinks to web/node_modules/<package> with the caches left out, so it writes nothing under web/. That was checked by fingerprinting those three cache dirs before and after a run.

A green run is **7 passed**. Every property is a plain check: any failing case is a finding, with nothing excused.

## The properties

| id | property (one sentence) | harm when broken | caught F… |
|---|---|---|---|
| P1 placement-fits | Every placement selectNodes returns stays within each chosen node's free cores, GPUs (right type), memory and MinCPUsNode, and respects the request's limits:<br>• distinct, non-excluded candidates<br>• every --nodelist host included<br>• between -N and the smaller of the job's own -N maximum and the partition / QoS node limit, and no more nodes than tasks without --ntasks-per-node<br>• at least the job's CPUs in total<br>• no booked node unless the job ends by the booking | The queue play books a waiter onto room that does not exist, so the claims are wrong and every verdict uses the wrong free room. | F4 |
| P2 claims-fit | Each node's claim stays within what it has free and only on in-service or PLANNED nodes, and is covered by the placed waiters that may run there: their partition holds the node, it isn't --exclude'd, and it is a --nodelist host or one Slurm would add "as needed". It is no more than those waiters' per-node shares. Each waiter is placed in one of its own open partitions. | A free node looks taken (users see "queues" while the job would start), or a waiter's claim lands where it cannot run. | F2 |
| P3 caps-hold | The queue play starts no more waiters per QoS than GrpJobs minus the running jobs leaves, and no more per user than MaxJobsPerUser leaves; slotsLeft = cap − running − started. | The queue starts jobs Slurm holds on a cap, eating slots and nodes a new job could use, and group-full banners come out wrong. | none |
| P4 lone-waiter-starts | A waiter alone in the queue that is not held, booked or stuck, and fits one in-service node of an open partition, is started by the queue play. | Its claim goes missing, so the next user is told "starts now" for the node that waiter will take first. | F2 |
| P5 shorter-never-worse | For the same request, a shorter -t never makes any of these worse: gpuStatus' starts-now, gpuStartCount, liveCpuStart "now". timeSec 0 (no limit) counts as the longest. | The walltime slider shows a long job starting now and a shorter one queueing, so users pick a worse -t. | F1 |
| P6 smaller-never-worse | In a CPU partition, fewer cores (same -N, --mem) or less --mem (same cores, -N) never turns liveCpuStart "now" into "queued". cpuStartLimits().maxCores and cpuStartMemMb() sit exactly where liveCpuStart flips: their value starts and the next one up does not, unless it is over the QoS core cap or the group cap is full. | The core / --mem slider's "starts now" zone contains values that queue, or stops short of values that start. | F2 |
| P7 own-nodes-only | When gpuStatus says a GPU partition starts now (clear), some in-service, unbooked node *of that partition* has room, after the queue's claims, for the default request's per-GPU need. The need is computed in the test from the partition's defaults and the documented rule (gpu-availability.ts points 1–2, slurm.ts capPerGpu), not read from the fit. | A partition is called free because of a node only a sibling partition can use. | F3 |

## Findings (all fixed)

The first run (at c17d99f) found F1–F3; the fix's own deep run found F4. All four were dormant on Hakusan's policy on 2026-11-17: they need a QoS node limit above 1, a GPU partition with no MaxWall, or a GPU partition covering only part of its pool, and none held. Each had the same root: one rule written out in several places that disagreed. The fix (1147a34) gave each rule one home that every caller goes through, and a mutant puts each bug back to prove a property still catches it.

**F1 (P5, guarded by M11): "no time limit" read as a job that ends now.** `timeSec: 0` meant "no limit" to gpuStatus and cpu-probes, while layoutFit computed `generated_at + 0`, so gpuStartCount fitted an unlimited job into every booked node's gap. Partition gB with no MaxWall and a 1-GPU job booked on idle g2 in 10 min: `gpuStartCount(gB, {timeSec: 0})` was 2 GPUs while `{timeSec: 1800}` gave 0.
- Now: slurm.ts `requestEndsAt` is the only reader of a request's walltime (absent = the partition's default, 0 or Infinity = no limit, as Slurm reads `-t 0`), and node-select.ts `endsBeforeBooking` is the only gap rule; usableCpus, layoutFit and withinBackfillWindow all call it. request-panel.tsx passes "no -t" as `undefined`, not 0.

**F2 (P2, P4, P6, guarded by M9): the QoS node limit was read as the job's own -N maximum.** queue.ts requestOf and cpu-probes newRequest folded `partitionCap(p).maxNodes` into `NodeRequest.maxNodes`, and evalTopo aimed for that many nodes. Slurm 25.05 get_node_cnts() (src/slurmctld/node_scheduler.c, read at tag slurm-25-05-5-1) aims for max_nodes only when the job gave it itself (`!limit_set.tres[NODE] && details->max_nodes`); a partition or accounting limit only lowers max_nodes. Accounting limits never write details->max_nodes, so squeue's MaxNodes is the job's own. Partition cB with QoS node limit 2 and one idle 4-core node: liveCpuStart said 2 cores start now and 1 core queues.
- Now: NodeRequest carries `maxNodes` (the job's own) and a required `nodeLimit` (partition / QoS), and node-select.ts `nodeCounts` is get_node_cnts, the only place min / aim / max are worked out.

**F3 (P7, guarded by M10): the GPU fit counted the pool's nodes, not the partition's.** gpuFitFromNodes (and partitionGpuAvailability) kept every node with `node.pool === pool.id`. Node g1 in gB only and PLANNED, node g2 in gA only and idle: gpuStatus(gB) said "clear" because of g2.
- Now: derive.ts `partitionNodes` is where every per-partition verdict gets its nodes, and queue.ts `partitionRooms` (the partition's open nodes after the queue's claims) feeds both CPU placement and GPU layouts. poolGpuAvailability is the best of its partitions, each judged on its own nodes.

**F4 (P1): a node ceiling under -N's minimum still placed the job.** With `-N 3`, one task and a node limit of 2, the "no more nodes than tasks" rule replaced the ceiling with max(tasks, -N) = 3 instead of lowering it, and selectNodes placed 3 nodes. get_node_cnts returns ESLURM_REQUESTED_PART_CONFIG_UNAVAILABLE when max_nodes < min_nodes. Now nodeCounts takes the smaller of the two caps, and selectNodes returns null below the minimum.

**Observation (no property):** queue.ts mayUseNode, used by gpu-fit slotContenders, lets a --nodelist job use other hosts only when -N exceeds the list. The queue play's selectNodes adds hosts whenever the listed ones cannot hold the job, which is what sbatch documents. The contender count can therefore miss such waiters.

## Reading a failure

fast-check prints a seed, the shrunk Scenario (JSON), and under "Caused by" a plain story from tell():
- QoS (GrpJobs, MaxJobsPerUser, wall, MaxTRES);
- partitions with their defaults;
- nodes as `cores used/total mem used/total gpus used/total`, where "used" is exactly what the listed running jobs hold;
- jobs with -p, -N, cpus, gpus, -t, booking, -w/-x, and the hosts of running jobs.

Generated names are synthetic: partitions gA/gB (GPU pool, GPU type tA) and cA/cB (CPU pool), QoS qG/qC when shared, nodes g1…/c1…, users u1–u3. Snapshot time is GEN = 1800000000, and bookings are minutes after it.

1. Replay with `VERIFY_SEED=<seed> npm run verify -- -t "<id>"`.
2. Ask what Slurm would do with that exact cluster and request. Use the Slurm 25.05 source the module comments cite: node_scheduler.c get_node_cnts, topology/tree eval_nodes_tree.c, topology/common common_topo.c, backfill.c. sbatch's documented semantics count too (--nodelist adds hosts "as needed"), and node-select.fixtures.ts holds measured `sbatch --test-only` results. If Slurm would also do what the code did, the property's oracle is wrong: a **modeling error**. One such error, an owner rule narrower than --nodelist, was found and fixed this way.
3. Check the generator's assumptions (Bounds below). A case the backend could never produce, or one Slurm would reject at submit, is a modeling error in the generator, not a bug.
4. Fix a modeling error in start-verdict.scenario.ts or in the property's oracle, say why in a comment, and run `npm run verify:mutants` to show the property can still fail. Never narrow a property so that a real bug passes.
5. A real bug goes into the Findings section with its counterexample in the code's words. Fix it at its root when you can, and add a mutant that puts it back. If it must stay open, say so there and in the hand-off; do not weaken the property to let it pass.

## When a change is intended

- **New Slurm semantics** (for example a different reqNodes rule): update the property's oracle, cite the Slurm source or a measurement, and rerun.
- **A covered function renamed or moved:** update the imports in start-verdict.verify.ts and the anchors in web/scripts/verify-mutants.mjs.
  - verify:mutants reports `ANCHOR MISSING` when a mutant's exact text is gone. Rewrite that mutant as the same kind of break in the new code. Never delete it without a replacement for its property.
- **A new snapshot or policy field** the verdict reads: add it to the Scenario and buildSnapshot, filled the way backend/normalize.py and backend/sources.py fill it.
- **Afterwards:** run `npm run verify` and `npm run verify:mutants`, then move the sync commit.

Mutants (each must stay "caught"):

| id | break | must fail |
|---|---|---|
| M1 | usableCpus stops checking a node's free GPU count | P1 |
| M2 | the queue play stops using up a node's GPUs | P2 |
| M3 | the queue play ignores GrpJobs | P3 |
| M4 | the queue play only looks at nodes with a free GPU | P4 |
| M5 | withinBackfillWindow's gap test is negated | P5 |
| M6 | newRequest picks -n vs -c by request size | P6 |
| M7 | fitHasClearSlot ignores bookings | P7 |
| M8 | cpuStartMemMb searches only up to half the largest free memory | P6 |
| M9 | F2 back: nodeCounts aims for the partition / QoS node limit | P6 (also P2, P4) |
| M10 | F3 back: gpuFitFromNodes walks every node of the pool | P7 |
| M11 | F1 back: requestEndsAt reads timeSec 0 as a job that ends now | P5 |

## Bounds and assumptions

**Per run:** 400 generated cluster states per property (P1: 2,000 placement requests; P6: 200). Each state has:
- 1–4 GPU nodes (1–4 GPUs, 4/8/16 cores, 16–64 GB) and 1–4 CPU nodes.
- Two GPU and two CPU partitions over subsets of them. Each partition sits on its own QoS or on a QoS shared with its pool sibling.
- Per QoS: GrpJobs and MaxJobsPerUser 0–3, MaxWall none/1h/4h/24h, MaxTRES node none/1/2, cpu none/8/16/32, mem none/32G, gpu none/1/2/4. As in backend/sources.py, every partition on a QoS gets the same caps.
- Up to 12 jobs:
  - reasons Priority/Resources/None/QOS caps/Dependency/JobHeldUser/ReqNodeNotAvail;
  - 1–2 nodes, request shapes none/-n/-c, bookings, -w/-x, time limits.
- Running jobs placed on nodes of their partition with room (settle()). Each node's allocation is exactly the sum of their per-node shares, and its state (IDLE/MIXED/ALLOCATED, plus PLANNED or DRAIN) follows from it. A running job that fits nowhere is dropped.
- Optionally a two-leaf switch tree.

A pass covers these sizes and value sets, not every cluster. At 1147a34 the deep run passed at 3,000 and at 5,000 per property, and the seed that found F4 (-1597548017) passes.

**Assumptions:**
- `schedulable` follows backend/normalize.py is_schedulable.
- No generated waiter gives its own -N range or mem-per-cpu, so the queue play's "aim for the job's own -N maximum" path is exercised only by P1's direct requests (maxNodes 0/1/2/4 with nodeLimit 0/1/2/4) and by node-select.test.ts.
- P1 requests are normalised the way Slurm normalises accepted jobs; Slurm would reject the rest at submit:
  - -N ≥ the --nodelist count, -N max ≥ -N;
  - CPUs ≥ tasks × cpus-per-task;
  - MinCPUsNode = cpus-per-task, or tasks-per-node × cpus-per-task;
  - one of --mem-per-cpu / --mem.
- Times: start_est is written as UTC ISO, so the cluster time-zone path (clusterMs with a zone) is not exercised. The clock is pinned to the snapshot time (gpuStartCount and gpuStatus default to Date.now()); P5 passes NOW_MS explicitly.
- P4's oracle is a sufficient condition (single node, no booking/-w/-x, not stuck by queue.ts rule 4), so it never asks for more than Slurm would do. P2's "as needed" rule for extra hosts beside --nodelist is conservative: any other placed waiter that may share a listed host allows them.

## Not covered

- Whether every node choice equals real Slurm's. The properties check internal consistency and Slurm invariants; the measured node-select.fixtures.ts / queue.fixtures.ts tests compare with Slurm for a few cases.
- Multi-node GPU waiters' per-node split, GRES per job (--gpus), licenses, reservations, preemption, and the GPU-availability segment counts in gpu-availability.ts beyond the per-GPU need.
- The React components that call these functions (request-panel.tsx).
- Backend concurrency in backend/server.py (sampler, refresh throttle, SSE fan-out) and gpu-grid.ts packing.

To bring this verification back in line after changes that skipped it, use the `/maintain-formal-verification-skill` skill.
