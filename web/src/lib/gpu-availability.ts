/**
 * GPU availability — the one place that decides what every GPU number, colour
 * and status label on the dashboard means.
 *
 * Deliberately dependency-free: plain numbers in, verdicts out. No React, no
 * i18n, no snapshot types. Callers adapt their data into `GpuNodeFacts`
 * (see `gpuNodeFacts` in gpu-fit.ts) so the rules stay testable against real
 * cluster records — gpu-availability.fixtures.ts holds those records and
 * gpu-availability.test.ts pins one to every display mode.
 *
 * ---------------------------------------------------------------------------
 * The model, and why the obvious shortcuts are wrong
 * ---------------------------------------------------------------------------
 * A GPU is classified by the state of the NODE that hosts it, against the
 * footprint one GPU's share of the partition's DEFAULT request needs.
 *
 * 1. The default request is not the QoS cap. `salloc -p VM-GPU-L` asks for
 *    32 cores x DefMemPerCPU(14900 MB) = 476800 MB — the QoS ceiling is
 *    mem=480G, a different and larger number. Feeding the cap into the fit
 *    check is what made three completely empty H100 nodes report "memory
 *    insufficient" (measured 2026-07-29).
 *
 * 2. The per-GPU need is capped by the node's own per-GPU hardware share.
 *    A gl0x node holds 469070 MB and one H100, so one GPU's share is at most
 *    469070 MB even though the default request asks 476800 MB. Slurm resolves
 *    that by spreading the job over two nodes (observed: `salloc -p VM-GPU-L`
 *    landed on gl[02-03] and took 2 GPUs) — it does not refuse to start.
 *    Capping the need is what makes the invariant below hold.
 *
 * INVARIANT: a fully idle, schedulable node's GPUs are always `ready`.
 *    freeCores == totalCores >= need.cores and freeMem == totalMem >=
 *    need.memMb hold by construction, so no rule can label empty hardware
 *    "short on CPU/memory". This is asserted directly in the test suite.
 *
 * 3. Shortage means "the default request would queue here", not "this GPU is
 *    unusable". A node with a free GPU and 12 spare cores still runs a
 *    `-n 12` job; the label says the default request queues, and the card's
 *    tip offers the flag that fits.
 */

export type GpuAvailabilityKind =
  | "ready"
  | "contested"
  | "memory"
  | "cpu"
  | "cpu-memory"
  | "reserved"
  | "down"
  | "full";

/** Display order: what you can take, then why you can't, then what is broken. */
const KIND_ORDER: GpuAvailabilityKind[] = [
  "ready",
  "contested",
  "memory",
  "cpu",
  "cpu-memory",
  "reserved",
  "down",
];

export interface GpuAvailabilitySegment {
  kind: GpuAvailabilityKind;
  count: number;
}

/** One node's contribution, as plain numbers. */
export interface GpuNodeFacts {
  name: string;
  gpusTotal: number;
  gpusUsed: number;
  coresTotal: number;
  coresFree: number;
  memTotalMb: number;
  memFreeMb: number;
  /** Node needs operator attention (DOWN / DRAIN / MAINT / rebooting). */
  offline: boolean;
  /** Scheduler holds the node for a future job (PLANNED / RESERVED). Idle,
   *  but only reachable through a backfill window short enough to fit. */
  held: boolean;
  /** A queued job that could start right now would claim this node's GPUs. */
  contested: boolean;
}

/** What a request with no resource flags asks Slurm for, per partition.
 *  Sourced from the snapshot's `policy.partition_defaults` (backend measures
 *  the submit plugin's core count and reads DefMemPerCPU live). */
export interface GpuDefaultRequest {
  partition: string;
  cores: number;
  memPerCoreMb: number;
  gpusPerNode: number;
}

/** One GPU's share of the default request on a given node shape. */
export interface GpuPerGpuNeed {
  partition: string;
  gpus: number;
  cores: number;
  memMb: number;
}

export interface GpuNodeVerdict extends GpuNodeFacts {
  idleGpu: number;
  kind: GpuAvailabilityKind;
  missingCores: number;
  missingMemMb: number;
}

export interface GpuAvailability {
  need: GpuPerGpuNeed;
  segments: GpuAvailabilitySegment[];
  nodes: GpuNodeVerdict[];
  /** GPUs the default request can take right now, on nobody else's terms. */
  ready: number;
  /** Every physically idle GPU, whatever is blocking it. */
  physicalIdle: number;
}

/** The hardware shape of one node in the pool, used to cap the per-GPU need. */
export interface GpuNodeShape {
  gpus: number;
  cores: number;
  memMb: number;
}

/**
 * One GPU's share of `request` on `shape`, never larger than the hardware can
 * give a single GPU. `cap` (QoS MaxTRES, already divided per GPU) narrows it
 * further when the policy is stricter than the default.
 */
export function gpuPerGpuNeed(
  request: GpuDefaultRequest,
  shape: GpuNodeShape,
  cap?: { cores?: number; memMb?: number },
): GpuPerGpuNeed {
  const gpusPerNode = Math.max(1, request.gpusPerNode || 1);
  const gpuSlots = Math.max(1, shape.gpus || gpusPerNode);
  // Cores one GPU commands: the request's own per-GPU share (its core total
  // divided by the GPUs it asks for), but never more than the node has to
  // give per GPU, nor more than the policy allows. Measured 2026-07-29 both
  // land on 26 for the A40 pool (26 cores / 1 GPU asked, 52 cores / 2 GPUs
  // on the node) and on 32 vs 32 for the H100 pool.
  const hardwareCores = Math.max(1, Math.floor(shape.cores / gpuSlots));
  const hardwareMem = Math.floor(shape.memMb / gpuSlots);
  // A snapshot older than partition_defaults carries no measured request. Fall
  // back to the hardware share rather than to zero: it keeps the invariant and
  // stays on the strict side instead of calling every idle GPU takeable.
  const requestCores = request.cores > 0 ? Math.ceil(request.cores / gpusPerNode) : hardwareCores;
  const cores = Math.max(1, Math.min(requestCores, hardwareCores, cap?.cores || Infinity));
  const requestMem = request.memPerCoreMb > 0 ? cores * request.memPerCoreMb : hardwareMem;
  const memMb = Math.max(0, Math.min(requestMem, hardwareMem, cap?.memMb || Infinity));
  return { partition: request.partition, gpus: gpusPerNode, cores, memMb };
}

/** Why this node's idle GPUs are (or are not) takeable right now. */
export function classifyGpuNode(node: GpuNodeFacts, need: GpuPerGpuNeed): GpuNodeVerdict {
  const idleGpu = Math.max(0, (node.gpusTotal || 0) - (node.gpusUsed || 0));
  const missingCores = Math.max(0, need.cores - node.coresFree);
  const missingMemMb = Math.max(0, need.memMb - node.memFreeMb);
  return { ...node, idleGpu, missingCores, missingMemMb, kind: nodeKind(node, missingCores, missingMemMb) };
}

function nodeKind(node: GpuNodeFacts, missingCores: number, missingMemMb: number): GpuAvailabilityKind {
  // Ownership first: a broken or already-promised node is not "your request
  // doesn't fit", however much room is left on it.
  if (node.offline) return "down";
  if (node.held) return "reserved";
  if (missingCores > 0 && missingMemMb > 0) return "cpu-memory";
  if (missingCores > 0) return "cpu";
  if (missingMemMb > 0) return "memory";
  if (node.contested) return "contested";
  return "ready";
}

/**
 * Split a pool's physically idle GPUs into mutually exclusive states that add
 * back up to the headline total. Peers, not a headline plus a contradictory
 * breakdown.
 */
export function gpuAvailability(
  nodes: GpuNodeFacts[],
  request: GpuDefaultRequest,
  cap?: { cores?: number; memMb?: number },
): GpuAvailability {
  const need = gpuPerGpuNeed(request, poolShape(nodes, request), cap);
  const verdicts = nodes.map((node) => classifyGpuNode(node, need));
  const idle = verdicts.filter((v) => v.idleGpu > 0);
  const counts = new Map<GpuAvailabilityKind, number>();
  for (const v of idle) counts.set(v.kind, (counts.get(v.kind) ?? 0) + v.idleGpu);
  const segments = KIND_ORDER
    .filter((kind) => (counts.get(kind) ?? 0) > 0)
    .map((kind) => ({ kind, count: counts.get(kind) as number }));
  if (segments.length === 0) segments.push({ kind: "full", count: 0 });
  return {
    need,
    segments,
    nodes: verdicts,
    ready: counts.get("ready") ?? 0,
    physicalIdle: idle.reduce((sum, v) => sum + v.idleGpu, 0),
  };
}

/** The pool's node shape. Pools are homogeneous, but a drained or partly
 *  reported node must not shrink the shape below its peers, so take the
 *  largest node of each dimension. */
function poolShape(nodes: GpuNodeFacts[], request: GpuDefaultRequest): GpuNodeShape {
  const shape: GpuNodeShape = { gpus: 0, cores: 0, memMb: 0 };
  for (const node of nodes) {
    shape.gpus = Math.max(shape.gpus, node.gpusTotal);
    shape.cores = Math.max(shape.cores, node.coresTotal);
    shape.memMb = Math.max(shape.memMb, node.memTotalMb);
  }
  if (shape.gpus <= 0) shape.gpus = Math.max(1, request.gpusPerNode || 1);
  return shape;
}
