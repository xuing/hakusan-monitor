// GPU bin-packing feasibility: can the partition's DEFAULT request actually
// start right now, or are the free GPUs stranded on nodes whose leftover
// CPU/memory can't host it? Pure computation — no React, no i18n — so both the
// Overview pool cards and the Partitions page share one verdict.
import { expandHostlist, nodeIsBackfillCandidate, nodeIsSchedulerHeld, nodeNeedsAttention, parseGpuCount } from "@/lib/derive";
import {
  gpuAvailability,
  gpuPerGpuNeed,
  type GpuAvailability,
  type GpuDefaultRequest,
  type GpuNodeFacts,
} from "@/lib/gpu-availability";
import { BACKFILL_MARGIN_MS, mayUseNode, queueModel, shareOf, type Claim, type QueueModel, type Waiter } from "@/lib/queue";
import { capPerGpu, minutesToSlurmTime, partitionCap, partitionDefaultRequest, type PartitionCap } from "@/lib/slurm";
import type { Pool, RawJob, RawNode, Snapshot } from "@/types/snapshot";

export interface GpuFitNeed {
  partition: string;
  gpus: number;
  cores: number;
  memMb: number;
}

export interface GpuFitNode {
  node: RawNode;
  freeGpu: number;
  usedGpu: number;
  freeCores: number;
  freeMemMb: number;
  missingGpu: number;
  missingCores: number;
  missingMemMb: number;
  occupants: RawJob[];
}

export interface GpuFitInfo {
  need: GpuFitNeed;
  rawFree: number;
  schedulable: number;
  stranded: GpuFitNode[];
  fitNodes: GpuFitNode[];
  /** Physically idle GPUs on PLANNED nodes. They are not ordinary free
   * capacity, but may accept a short job before the future reservation. */
  reservedNodes: GpuFitNode[];
}

export interface GpuFitTipData {
  mem: string;
  node: string;
}

export function gpuFitSnapshot(snap: Snapshot, pool: Pool, cap: PartitionCap, partition: string): GpuFitInfo {
  return gpuFitFromNodes(snap.nodes, snap.jobs, pool, cap, partition,
                         partitionDefaultRequest(partition, snap.policy),
                         cap.maxGpus);
}

/** `jobGpus`: GPUs one job really holds (the QoS gres cap), which divides
 *  the QoS cap into a per-GPU share; defaults to the QoS gres cap. */
export function gpuFitFromNodes(nodes: RawNode[], jobs: RawJob[], pool: Pool, cap: PartitionCap,
                                partition: string, request: GpuDefaultRequest,
                                jobGpus: number | undefined = cap.maxGpus): GpuFitInfo {
  const need = gpuFitNeed(nodes, pool, cap, partition, request, jobGpus);
  const byNode = jobs.length ? runningJobsByNode(jobs) : new Map<string, RawJob[]>();
  const stranded: GpuFitNode[] = [];
  const fitNodes: GpuFitNode[] = [];
  const reservedNodes: GpuFitNode[] = [];
  if (!pool.gpu) return { need, rawFree: 0, schedulable: 0, stranded, fitNodes, reservedNodes };
  const perGpuCores = need.cores;
  const perGpuMemMb = need.memMb;
  let rawFree = 0;
  let slots = 0;
  for (const node of nodes) {
    if (node.pool !== pool.id) continue;
    // In service = not taken out by an operator and not held by the
    // scheduler. That includes a CPU-full ALLOCATED node with an idle GPU:
    // it lands in `stranded` (short on cores), so rawFree equals the pool
    // card's "N 张 GPU 空闲" (gpu-availability `free`) instead of a second,
    // smaller "physically idle" number.
    const normallySchedulable = !nodeNeedsAttention(node) && !nodeIsSchedulerHeld(node);
    const backfillCandidate = nodeIsBackfillCandidate(node);
    if (!normallySchedulable && !backfillCandidate) continue;
    const freeGpu = Math.max(0, parseGpuCount(node.gres, pool.gpu.type) - parseGpuCount(node.gres_used, pool.gpu.type));
    if (freeGpu <= 0) continue;
    const freeCores = Math.max(0, node.cpus - node.alloc_cpus);
    const freeMem = Math.max(0, node.real_memory - node.alloc_memory);
    const nodeSlots = Math.min(
      freeGpu,
      Math.floor(freeCores / perGpuCores),
      perGpuMemMb ? Math.floor(freeMem / perGpuMemMb) : freeGpu,
    );
    const row: GpuFitNode = {
      node,
      freeGpu,
      usedGpu: parseGpuCount(node.gres_used, pool.gpu.type),
      freeCores,
      freeMemMb: freeMem,
      missingGpu: Math.max(0, need.gpus - freeGpu),
      missingCores: Math.max(0, perGpuCores - freeCores),
      missingMemMb: perGpuMemMb ? Math.max(0, perGpuMemMb - freeMem) : 0,
      occupants: byNode.get(node.name) ?? [],
    };
    if (backfillCandidate && !normallySchedulable) {
      reservedNodes.push(row);
    } else {
      rawFree += freeGpu;
      slots += nodeSlots;
      if (nodeSlots > 0) fitNodes.push(row);
      else stranded.push(row);
    }
  }
  stranded.sort((a, b) => shortageScore(a) - shortageScore(b) || a.node.name.localeCompare(b.node.name));
  fitNodes.sort((a, b) => b.freeGpu - a.freeGpu || b.freeCores - a.freeCores || b.freeMemMb - a.freeMemMb);
  reservedNodes.sort((a, b) => b.freeGpu - a.freeGpu || b.freeCores - a.freeCores || b.freeMemMb - a.freeMemMb);
  return { need, rawFree, schedulable: slots, stranded, fitNodes, reservedNodes };
}

export function gpuFitWithMemOverride(fit: GpuFitInfo, memMb: number): GpuFitInfo {
  if (memMb <= 0) return fit;
  const withSlots = (row: GpuFitNode) => {
    const nodeSlots = Math.min(
      row.freeGpu,
      Math.floor(row.freeCores / fit.need.cores),
      Math.floor(row.freeMemMb / memMb),
    );
    return {
      ...row,
      missingMemMb: Math.max(0, memMb - row.freeMemMb),
      missingCores: Math.max(0, fit.need.cores - row.freeCores),
      missingGpu: Math.max(0, fit.need.gpus - row.freeGpu),
      nodeSlots,
    };
  };
  const rows = [...fit.fitNodes, ...fit.stranded].map(withSlots);
  const reservedRows = fit.reservedNodes.map(withSlots);
  const fitNodes = rows.filter((row) => row.nodeSlots > 0).map(({ nodeSlots: _nodeSlots, ...row }) => row);
  const stranded = rows.filter((row) => row.nodeSlots <= 0).map(({ nodeSlots: _nodeSlots, ...row }) => row);
  const reservedNodes = reservedRows.map(({ nodeSlots: _nodeSlots, ...row }) => row);
  stranded.sort((a, b) => shortageScore(a) - shortageScore(b) || a.node.name.localeCompare(b.node.name));
  fitNodes.sort((a, b) => b.freeGpu - a.freeGpu || b.freeCores - a.freeCores || b.freeMemMb - a.freeMemMb);
  return {
    ...fit,
    need: { ...fit.need, memMb },
    schedulable: rows.reduce((sum, row) => sum + Math.max(0, row.nodeSlots), 0),
    fitNodes,
    stranded,
    reservedNodes,
  };
}

/** Adapt a pool's raw nodes into the plain records gpu-availability
 *  classifies, each carrying what the queue takes from it first (`claims`
 *  from queue.ts). Every node of the pool is included — a drained node's idle
 *  GPUs are part of the picture ("down"), they are just not capacity. */
export function gpuNodeFacts(nodes: RawNode[], pool: Pool, claims: Map<string, Claim>): GpuNodeFacts[] {
  const type = pool.gpu?.type ?? "";
  return nodes.filter((node) => node.pool === pool.id).map((node) => ({
    name: node.name,
    gpusTotal: parseGpuCount(node.gres, type),
    gpusUsed: parseGpuCount(node.gres_used, type),
    coresTotal: node.cpus,
    coresFree: Math.max(0, node.cpus - node.alloc_cpus),
    memTotalMb: node.real_memory,
    memFreeMb: Math.max(0, node.real_memory - node.alloc_memory),
    offline: nodeNeedsAttention(node),
    held: nodeIsSchedulerHeld(node),
    claim: claims.get(node.name),
  }));
}

/** The pool's GPU verdict, judged against the most permissive of its sibling
 *  partitions (they share the hardware, so one policy able to default-request a
 *  GPU is enough to call it available). The ONE entry point for every GPU
 *  number, colour and "available" flag — pool cards, Partitions headers,
 *  filter chips, group headers and KPIs all read this, so a pool can never be
 *  green in one place and amber in the next. */
export function poolGpuAvailability(snap: Snapshot, pool: Pool): GpuAvailability {
  const facts = gpuNodeFacts(snap.nodes, pool, queueModel(snap).claims);
  const parts = snap.partitions.filter((p) => p.pool === pool.id).map((p) => p.name);
  const verdicts = (parts.length ? parts : [""]).map((name) => partitionVerdict(facts, snap, name));
  return verdicts.reduce((best, next) => (next.ready > best.ready ? next : best));
}

/** One partition's view of the shared pool verdict — the per-row number on
 *  the Partitions page, queue claims included, so a row can never promise
 *  more GPUs than the header it sits under. */
export function partitionGpuAvailability(snap: Snapshot, pool: Pool, partition: string): GpuAvailability {
  return partitionVerdict(gpuNodeFacts(snap.nodes, pool, queueModel(snap).claims), snap, partition);
}

function partitionVerdict(facts: GpuNodeFacts[], snap: Snapshot, partition: string) {
  const cap = partitionCap(partition, snap.policy);
  return gpuAvailability(
    facts,
    partitionDefaultRequest(partition, snap.policy),
    capPerGpu(cap, cap.maxGpus),
  );
}


/**
 * One GPU's share of the partition's DEFAULT request.
 *
 * Delegates to gpu-availability so the pool cards, the partitions page and the
 * tips all judge against the same footprint. The two traps this replaced:
 *
 *  - the QoS cap is not the default. `salloc -p VM-GPU-L` asks 32 cores x
 *    DefMemPerCPU 14900 MB = 476800 MB; the cap says mem=480G.
 *  - the biggest memory any single GPU can ever get is the node's per-GPU
 *    hardware share (469070 MB on a gl0x node). Asking for more than that
 *    made every idle H100 node read "memory insufficient" instead of "free".
 */
function gpuFitNeed(nodes: RawNode[], pool: Pool, cap: PartitionCap, partition: string,
                    request: GpuDefaultRequest, jobGpus: number | undefined): GpuFitNeed {
  const poolNodes = nodes.filter((node) => node.pool === pool.id);
  const shape = {
    gpus: Math.max(0, ...poolNodes.map((node) => parseGpuCount(node.gres, pool.gpu?.type ?? ""))),
    cores: Math.max(0, ...poolNodes.map((node) => node.cpus)),
    memMb: Math.max(0, ...poolNodes.map((node) => node.real_memory)),
  };
  const need = gpuPerGpuNeed(request, shape, capPerGpu(cap, jobGpus));
  return { partition, gpus: need.gpus, cores: need.cores, memMb: need.memMb };
}

function runningJobsByNode(jobs: RawJob[]) {
  const byNode = new Map<string, RawJob[]>();
  for (const job of jobs) {
    if (String(job.job_state || "").toUpperCase() !== "RUNNING" || !job.nodelist) continue;
    for (const node of expandHostlist(job.nodelist)) {
      const list = byNode.get(node) ?? [];
      list.push(job);
      byNode.set(node, list);
    }
  }
  for (const list of byNode.values()) {
    list.sort((a, b) => (b.gpus || 0) - (a.gpus || 0) || (b.cpus || 0) - (a.cpus || 0));
  }
  return byNode;
}

function shortageScore(row: GpuFitNode) {
  return row.missingGpu * 1_000_000_000 + row.missingCores * 1_000_000 + row.missingMemMb;
}

// ---- queue contention ---------------------------------------------------
// queue.ts decides who is ahead (`claims`, `poolContenders`); these helpers
// apply it to one partition's fit rows.

/** Waiters that could take this node's free GPU slot right now: they may run
 *  on the node and their per-node share fits what is free there. */
export function slotContenders(row: GpuFitNode, contenders: Waiter[]): number {
  let n = 0;
  for (const w of contenders) {
    if (!w.open.some((p) => row.node.partitions.includes(p)) || !mayUseNode(w.job, row.node.name)) continue;
    const share = shareOf(w.job, true);
    if (share.gpus <= row.freeGpu && share.cores <= row.freeCores && share.memMb <= row.freeMemMb) n += 1;
  }
  return n;
}

/** What a node has free once the queue has taken its claim there. */
function freeAfterClaims(row: GpuFitNode, claims: Map<string, Claim>) {
  const claim = claims.get(row.node.name);
  return {
    gpus: row.freeGpu - (claim?.gpus ?? 0),
    cores: row.freeCores - (claim?.cores ?? 0),
    memMb: row.freeMemMb - (claim?.memMb ?? 0),
  };
}

const holdsNeed = (fit: GpuFitInfo, free: ReturnType<typeof freeAfterClaims>) =>
  free.gpus >= fit.need.gpus && free.cores >= fit.need.cores && free.memMb >= fit.need.memMb;

/** Is a default-request slot still open once the queue has taken its share?
 *  Two waiters in front of nine idle nodes leave seven open — not zero. */
export function fitHasClearSlot(fit: GpuFitInfo, claims: Map<string, Claim>): boolean {
  return fit.fitNodes.some((row) => holdsNeed(fit, freeAfterClaims(row, claims)));
}

// ---- backfill window ------------------------------------------------------
// A node Slurm has booked for a queued job at a *future* start (squeue
// SchedNodes + StartTime) is backfillable until then: Slurm starts a
// lower-priority job in the gap iff its time limit guarantees it ends before
// the booking. The margin absorbs bookings drifting earlier when running jobs
// finish ahead of their limits.

const BF_STEP_SEC = 15 * 60;
const BF_MIN_SEC = 30 * 60;

interface BackfillWindowInfo {
  untilMs: number;
  suggestSec: number;
}

function backfillWindow(row: GpuFitNode, bookings: Map<string, number[]>, nowMs: number): BackfillWindowInfo | null {
  const untilMs = (bookings.get(row.node.name) ?? []).find((at) => at > nowMs);
  if (untilMs === undefined) return null;
  const suggestSec = Math.floor((untilMs - nowMs - BACKFILL_MARGIN_MS) / 1000 / BF_STEP_SEC) * BF_STEP_SEC;
  if (suggestSec < BF_MIN_SEC) return null;
  return { untilMs, suggestSec };
}

export interface GpuBackfillTipData {
  node: string;
  mem: string; // "" when the default request already fits the node
  t: string;
  untilMs: number;
}

export function gpuBackfillTipCommand(fit: GpuFitInfo, pool: Pool, q: QueueModel, nowMs: number): GpuBackfillTipData | null {
  if (!pool.gpu) return null;
  // Slots exist but every one is spoken for — a short job can still sneak in.
  if (fit.schedulable > 0 && fitHasClearSlot(fit, q.claims)) return null;
  // Prefer the widest real scheduler window. PLANNED rows live in
  // reservedNodes (and remain excluded from ordinary free/schedulable totals).
  let bestTip: GpuBackfillTipData | null = null;
  let bestSec = 0;
  for (const row of [...fit.reservedNodes, ...fit.fitNodes, ...strandedCandidates(fit)]) {
    // a gap the queue fills now is no gap
    const free = freeAfterClaims(row, q.claims);
    if (free.gpus < fit.need.gpus || free.cores < fit.need.cores) continue;
    let mem = "";
    if (fit.need.memMb > 0 && free.memMb < fit.need.memMb) {
      const memGb = conservativeMemGb(free.memMb);
      if (memGb <= 0) continue;
      mem = `${memGb}G`;
    }
    const win = backfillWindow(row, q.bookings, nowMs);
    if (!win || win.suggestSec <= bestSec) continue;
    bestSec = win.suggestSec;
    bestTip = { node: row.node.name, mem, t: minutesToSlurmTime(win.suggestSec / 60), untilMs: win.untilMs };
  }
  return bestTip;
}

/** True when a node the request fits once the queue has taken its share has
 *  a backfill window that still holds a job of `userTimeSec` — PLANNED nodes
 *  included — the basis for flipping "will queue" back to "can start" once
 *  the user picks a short enough -t. */
export function withinBackfillWindow(fit: GpuFitInfo, q: Pick<QueueModel, "claims" | "bookings">, nowMs: number, userTimeSec: number): boolean {
  if (userTimeSec <= 0) return false;
  return [...fit.fitNodes, ...fit.reservedNodes].some((row) => {
    if (!holdsNeed(fit, freeAfterClaims(row, q.claims))) return false;
    const win = backfillWindow(row, q.bookings, nowMs);
    return win !== null && userTimeSec <= win.suggestSec;
  });
}

function strandedCandidates(fit: GpuFitInfo): GpuFitNode[] {
  return fit.stranded.filter((row) => row.freeGpu >= 1 && row.freeCores >= fit.need.cores && row.freeMemMb > 1024);
}

/** The --mem that lets the default request start on a stranded GPU now —
 *  only while no waiter can take that slot first; a blocked node must not
 *  hide a clear sibling, so every candidate is scanned. */
export function gpuFitTipCommand(fit: GpuFitInfo, pool: Pool, contenders: Waiter[]): GpuFitTipData | null {
  if (!pool.gpu || fit.schedulable > 0) return null;
  for (const best of strandedCandidates(fit)) {
    if (slotContenders(best, contenders) > 0) continue;
    const memGb = conservativeMemGb(best.freeMemMb);
    if (memGb > 0) return { mem: `${memGb}G`, node: best.node.name };
  }
  return null;
}

function conservativeMemGb(freeMemMb: number) {
  const freeGiB = freeMemMb / 1024;
  const rounded = Math.floor((freeGiB - 4) / 10) * 10;
  if (rounded >= 10) return rounded;
  return Math.max(1, Math.floor(freeGiB - 1));
}
