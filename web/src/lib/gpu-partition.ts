/**
 * What one GPU partition's request gets right now — the one verdict the
 * Overview (pool row, partition table, request panel, slider zones) and the
 * Partitions page all read, with one precedence:
 *
 *   maintenance > group cap full > starts now > --mem bypass > backfill gap > queues
 *
 * The CPU counterpart is cpu-partition.ts. Who is ahead in the queue comes
 * from queue.ts; this module only applies it to one partition's request.
 */
import { nodeIsSchedulable, parseGpuCount } from "@/lib/derive";
import {
  fitHasClearSlot,
  gpuBackfillTipCommand,
  gpuFitSnapshot,
  gpuFitTipCommand,
  gpuFitWithMemOverride,
  slotContenders,
  withinBackfillWindow,
  type GpuBackfillTipData,
  type GpuFitInfo,
  type GpuFitTipData,
} from "@/lib/gpu-fit";
import { gpuLayouts, type GpuLayout, type GpuNodeShape } from "@/lib/gpu-layout";
import { poolContenders, queueModel } from "@/lib/queue";
import { allowsMultiNode, defaultRequestSec, partitionCap, partitionDefaults, partitionDown, partitionPolicy } from "@/lib/slurm";
import type { Partition, Pool, Snapshot } from "@/types/snapshot";

export interface GpuRequest {
  /** --mem per node (MB); 0 or absent = DefMemPerCPU x the default cores */
  memMb?: number;
  /** how long the request holds its slot (s): the plugin-pinned interactive
   *  walltime or -t; 0 = unbounded; absent = the default request's */
  timeSec?: number;
}

/** Why a request queues. */
export type GpuQueueReason =
  | { kind: "maint" }
  | { kind: "group"; running: number; cap: number }
  /** no in-service node has a free GPU */
  | { kind: "no-node" }
  | { kind: "no-gpu" }
  /** free GPUs whose leftovers hold no default request, and waiters that fit them */
  | { kind: "contested"; n: number }
  /** free GPUs whose node's leftover cores / memory hold no default request */
  | { kind: "short" }
  /** a slot fits, but the queue takes every one first */
  | { kind: "ahead"; n: number; free: number };

export interface GpuStatus {
  /** how it starts now: in a slot the queue leaves, or inside a booked node's gap */
  now: "clear" | "backfill" | null;
  reason: GpuQueueReason | null;
  /** the request's fit (with its --mem); explanations read it */
  fit: GpuFitInfo;
  /** --mem that starts the default request on a stranded GPU no waiter can take */
  memTip: GpuFitTipData | null;
  /** -t short enough to start in a booked node's gap */
  gapTip: GpuBackfillTipData | null;
}

/** The label a status earns, the same on every page. */
export type GpuVerdict = "now" | "bypass" | "gap" | "queue" | "maint";

export function gpuVerdict(s: GpuStatus): GpuVerdict {
  if (s.reason?.kind === "maint") return "maint";
  if (s.now) return "now";
  if (s.memTip) return "bypass";
  if (s.gapTip) return "gap";
  return "queue";
}

export function gpuStatus(snap: Snapshot, pool: Pool, partition: string, req: GpuRequest = {}, nowMs = Date.now()): GpuStatus {
  const q = queueModel(snap);
  const part = snap.partitions.find((p) => p.name === partition);
  const base = gpuFitSnapshot(snap, pool, partitionCap(partition, snap.policy), partition);
  const fit = req.memMb ? gpuFitWithMemOverride(base, req.memMb) : base;
  const hold = req.timeSec ?? defaultRequestSec(partition, snap.policy);
  const contenders = poolContenders(snap, pool.id);
  const out = (now: GpuStatus["now"], reason: GpuQueueReason | null, tips = true): GpuStatus => {
    // the tips name a --mem or -t for the DEFAULT request; a full group cap
    // or maintenance blocks every request, so no value is a way in
    const memTip = tips && base.schedulable <= 0 ? gpuFitTipCommand(base, pool, contenders) : null;
    const gapTip = tips && !memTip ? gpuBackfillTipCommand(base, pool, q, nowMs) : null;
    return { now, reason, fit, memTip, gapTip };
  };

  if (part && partitionDown(part)) return out(null, { kind: "maint" }, false);
  if (q.groupFull(partition)) {
    return out(null, { kind: "group", running: q.running(partition), cap: partitionPolicy(partition, snap.policy).grpJobs ?? 0 }, false);
  }
  if ((part?.available_nodes ?? 0) <= 0) return out(null, { kind: "no-node" });
  if ((part?.gpu?.free ?? 0) <= 0) return out(null, { kind: "no-gpu" });
  if (fit.rawFree > 0 && fit.schedulable <= 0) {
    const best = fit.stranded.find((row) => row.freeGpu >= 1) ?? fit.stranded[0];
    const n = best ? slotContenders(best, contenders) : 0;
    return out(null, n > 0 ? { kind: "contested", n } : { kind: "short" });
  }
  if (fit.schedulable > 0 && fitHasClearSlot(fit, q.claims)) return out("clear", null);
  if (fit.schedulable > 0 && withinBackfillWindow(fit, q.bookings, nowMs, Number.isFinite(hold) ? hold : 0)) {
    return out("backfill", null);
  }
  return out(null, { kind: "ahead", n: contenders.length, free: fit.schedulable });
}

// ---- multi-GPU layouts ----------------------------------------------------------

/** The node shape a partition's layouts are cut from. */
export function gpuShapeOf(part: Partition | undefined, pool: Pool): GpuNodeShape {
  return {
    gpus: part?.spec.gpu_per_node ?? 0,
    cores: part?.spec.cores_per_node || (pool.nodes > 0 ? Math.floor(pool.cores.total / pool.nodes) : 0),
    memMb: part?.spec.mem_per_node || pool.mem_per_node,
    count: part?.nodes ?? pool.nodes,
  };
}

/** The multi-GPU requests the partition can grant at all (QoS, node shape). */
export function partitionLayouts(snap: Snapshot, pool: Pool, partition: string): GpuLayout[] {
  const cap = partitionCap(partition, snap.policy);
  const shape = gpuShapeOf(snap.partitions.find((p) => p.name === partition), pool);
  return gpuLayouts(cap, shape, allowsMultiNode(cap, shape.cores)).layouts;
}

/** How many nodes hold a layout's per-node share now, once the queue has
 *  taken what it starts first: all of a node's GPUs and their cores
 *  (packed), or one GPU and its share (spread). */
export function layoutFit(snap: Snapshot, pool: Pool, partition: string, layout: GpuLayout): { fits: number; starts: boolean } {
  const claims = queueModel(snap).claims;
  const type = pool.gpu?.type ?? "";
  const memPerCpu = partitionDefaults(partition, snap.policy).def_mem_per_cpu_mb ?? 0;
  const gpus = layout.gpusPerNode;
  let fits = 0;
  for (const n of snap.nodes) {
    if (n.pool !== pool.id || !n.partitions.includes(partition) || !nodeIsSchedulable(n)) continue;
    const claim = claims.get(n.name);
    const freeGpu = parseGpuCount(n.gres, type) - parseGpuCount(n.gres_used, type) - (claim?.gpus ?? 0);
    const freeCores = n.cpus - n.alloc_cpus - (claim?.cores ?? 0);
    const freeMem = n.real_memory - n.alloc_memory - (claim?.memMb ?? 0);
    if (freeGpu >= gpus && freeCores >= layout.coresPerGpu * gpus && freeMem >= layout.coresPerGpu * gpus * memPerCpu) fits += 1;
  }
  return { fits, starts: fits >= layout.nodes };
}

/** Most GPUs one job in the partition starts with now: one when the
 *  single-GPU request (as given) starts, more when a multi-GPU layout finds
 *  its nodes; 0 behind a full group cap or in maintenance. */
export function gpuStartCount(snap: Snapshot, pool: Pool, partition: string, req: GpuRequest = {}): number {
  const status = gpuStatus(snap, pool, partition, req);
  if (status.reason?.kind === "maint" || status.reason?.kind === "group") return 0;
  const multi = partitionLayouts(snap, pool, partition)
    .filter((l) => l.gpus > 1 && layoutFit(snap, pool, partition, l).starts)
    .map((l) => l.gpus);
  return Math.max(status.now ? 1 : 0, ...multi);
}
