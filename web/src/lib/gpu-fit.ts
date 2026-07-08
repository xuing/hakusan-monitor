// GPU bin-packing feasibility: can the partition's DEFAULT request actually
// start right now, or are the free GPUs stranded on nodes whose leftover
// CPU/memory can't host it? Pure computation — no React, no i18n — so both the
// Overview pool cards and the Partitions page share one verdict.
import { expandHostlist } from "@/lib/derive";
import type { PartitionCap } from "@/lib/slurm";
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
}

export interface GpuFitTipData {
  mem: string;
  node: string;
}

export function schedulableGpuSlots(nodes: RawNode[], pool: Pool, cap: PartitionCap) {
  return gpuFitFromNodes(nodes, [], pool, cap, "").schedulable;
}

export function gpuFitSnapshot(snap: Snapshot, pool: Pool, cap: PartitionCap, partition: string): GpuFitInfo {
  return gpuFitFromNodes(snap.nodes, snap.jobs, pool, cap, partition);
}

export function gpuFitFromNodes(nodes: RawNode[], jobs: RawJob[], pool: Pool, cap: PartitionCap, partition: string): GpuFitInfo {
  const need = gpuFitNeed(nodes, pool, cap, partition);
  const byNode = jobs.length ? runningJobsByNode(jobs) : new Map<string, RawJob[]>();
  const stranded: GpuFitNode[] = [];
  const fitNodes: GpuFitNode[] = [];
  if (!pool.gpu) return { need, rawFree: 0, schedulable: 0, stranded, fitNodes };
  const perGpuCores = need.cores;
  const perGpuMemMb = need.memMb;
  let rawFree = 0;
  let slots = 0;
  for (const node of nodes) {
    if (node.pool !== pool.id || !nodeUp(node)) continue;
    const freeGpu = Math.max(0, parseGpuCount(node.gres, pool.gpu.type) - parseGpuCount(node.gres_used, pool.gpu.type));
    if (freeGpu <= 0) continue;
    rawFree += freeGpu;
    const freeCores = Math.max(0, node.cpus - node.alloc_cpus);
    const freeMem = Math.max(0, node.real_memory - node.alloc_memory);
    const nodeSlots = Math.min(
      freeGpu,
      Math.floor(freeCores / perGpuCores),
      perGpuMemMb ? Math.floor(freeMem / perGpuMemMb) : freeGpu,
    );
    slots += nodeSlots;
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
    if (nodeSlots > 0) fitNodes.push(row);
    else stranded.push(row);
  }
  stranded.sort((a, b) => shortageScore(a) - shortageScore(b) || a.node.name.localeCompare(b.node.name));
  fitNodes.sort((a, b) => b.freeGpu - a.freeGpu || b.freeCores - a.freeCores || b.freeMemMb - a.freeMemMb);
  return { need, rawFree, schedulable: slots, stranded, fitNodes };
}

export function gpuFitWithMemOverride(fit: GpuFitInfo, memMb: number): GpuFitInfo {
  if (memMb <= 0) return fit;
  const rows = [...fit.fitNodes, ...fit.stranded].map((row) => {
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
  });
  const fitNodes = rows.filter((row) => row.nodeSlots > 0).map(({ nodeSlots: _nodeSlots, ...row }) => row);
  const stranded = rows.filter((row) => row.nodeSlots <= 0).map(({ nodeSlots: _nodeSlots, ...row }) => row);
  stranded.sort((a, b) => shortageScore(a) - shortageScore(b) || a.node.name.localeCompare(b.node.name));
  fitNodes.sort((a, b) => b.freeGpu - a.freeGpu || b.freeCores - a.freeCores || b.freeMemMb - a.freeMemMb);
  return {
    ...fit,
    need: { ...fit.need, memMb },
    schedulable: rows.reduce((sum, row) => sum + Math.max(0, row.nodeSlots), 0),
    fitNodes,
    stranded,
  };
}

function gpuFitNeed(nodes: RawNode[], pool: Pool, cap: PartitionCap, partition: string): GpuFitNeed {
  const maxGpus = Math.max(1, cap.maxGpus ?? 1);
  const cores = Math.max(1, Math.ceil((cap.maxCores ?? 1) / maxGpus));
  const capMemMb = cap.maxMemGb ? Math.ceil((cap.maxMemGb * 1000) / maxGpus) : 0;
  const observedMem = pool.gpu
    ? Math.max(0, ...nodes
        .filter((node) => node.pool === pool.id)
        .map((node) => {
          const usedGpu = parseGpuCount(node.gres_used, pool.gpu!.type);
          if (usedGpu <= 0) return 0;
          const mem = parseTresMemoryMb(node.alloc_tres) || node.alloc_memory;
          return mem > 0 ? Math.ceil(mem / usedGpu) : 0;
        }))
    : 0;
  return {
    partition,
    gpus: 1,
    cores,
    memMb: Math.max(capMemMb, observedMem),
  };
}

export function runningJobsByNode(jobs: RawJob[]) {
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

export function parseTresMemoryMb(text: string) {
  if (!text) return 0;
  const m = text.match(/(?:^|,)mem=(\d+(?:\.\d+)?)([KMGTP]?)/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2].toUpperCase();
  const mult: Record<string, number> = { "": 1, K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024, P: 1024 * 1024 * 1024 };
  return Math.round(n * (mult[unit] ?? 1));
}

// ---- queue contention ---------------------------------------------------
// A free slot is only "yours to take" when nobody ahead of you in the queue
// can use it. Slurm serves pending jobs in priority order, so a new request
// starts immediately only if every active waiter's own request is too big for
// the leftover resources (then backfill lets the small job through). When the
// scheduler has already earmarked an idle node for a waiter it reports the
// node as PLANNED — treat that as "spoken for" even if we count no contenders.

export interface SlotContention {
  contenders: number;
  planned: boolean;
}

export function slotContention(row: GpuFitNode, pendingActive: RawJob[]): SlotContention {
  const planned = row.node.state.some((s) => String(s).toUpperCase() === "PLANNED");
  let contenders = 0;
  for (const job of pendingActive) {
    // min_memory_mb / cpus / gpus are job totals; a multi-node job claims this
    // node with its per-node share. A waiter in a GPU pool with no parsed GPU
    // count still wants one — counting it keeps us on the "says queue" side.
    const nodes = Math.max(1, job.node_count || 1);
    const gpus = Math.ceil((job.gpus || 0) / nodes) || 1;
    const cpus = Math.ceil((job.cpus || 0) / nodes);
    const memMb = Math.ceil((job.min_memory_mb || 0) / nodes);
    if (gpus <= row.freeGpu && cpus <= row.freeCores && memMb <= row.freeMemMb) contenders += 1;
  }
  return { contenders, planned };
}

export function contested(c: SlotContention | null | undefined): boolean {
  return Boolean(c && (c.contenders > 0 || c.planned));
}

export function fitHasClearSlot(fit: GpuFitInfo, pendingActive: RawJob[]): boolean {
  return fit.fitNodes.some((row) => !contested(slotContention(row, pendingActive)));
}

export function hasUncontestedGpuSlot(nodes: RawNode[], pendingActive: RawJob[], pool: Pool, cap: PartitionCap): boolean {
  const fit = gpuFitFromNodes(nodes, [], pool, cap, "");
  return fit.schedulable > 0 && fitHasClearSlot(fit, pendingActive);
}

export function pendingForPool(jobs: RawJob[], partPool: Record<string, string>, poolId: string) {
  return jobs
    .filter((j) => String(j.job_state).toUpperCase() === "PENDING")
    .filter((j) => String(j.partition || "").split(",").some((p) => partPool[p] === poolId));
}

export function isLimitBlocked(job: RawJob) {
  const reason = String(job.state_reason || "");
  // Anything QOS/association-capped cannot take a free slot right now, no
  // matter its priority — verified live: a fresh lowest-priority job started
  // instantly past 27 QOSGrpJobsLimit waiters whose requests fit the node.
  return (
    reason.startsWith("QOSMax") ||
    reason.startsWith("QOSGrp") ||
    reason.startsWith("AssocMax") ||
    reason.startsWith("AssocGrp") ||
    reason === "Dependency" ||
    reason === "JobArrayTaskLimit" ||
    reason === "BeginTime" ||
    reason.startsWith("JobHeld")
  );
}

/** Pending jobs that actually compete for capacity: limit-blocked waiters
 *  (QOSMax*, Dependency…) cannot claim a slot right now, so they don't gate
 *  the "can start immediately" verdict. */
export function activePendingForPool(jobs: RawJob[], partPool: Record<string, string>, poolId: string) {
  return pendingForPool(jobs, partPool, poolId).filter((j) => !isLimitBlocked(j));
}

export function gpuFitTipCommand(fit: GpuFitInfo, pool: Pool, pendingActive: RawJob[]): GpuFitTipData | null {
  if (!pool.gpu || fit.schedulable > 0) return null;
  const best = fit.stranded.find((row) => row.freeGpu >= 1 && row.freeCores >= fit.need.cores && row.freeMemMb > 1024);
  if (!best) return null;
  // The --mem trick only queue-jumps while no active waiter fits the slot;
  // otherwise the queue verdict (not this tip) is the truthful message.
  if (contested(slotContention(best, pendingActive))) return null;
  const memGb = conservativeMemGb(best.freeMemMb);
  if (memGb <= 0) return null;
  return { mem: `${memGb}G`, node: best.node.name };
}

export function conservativeMemGb(freeMemMb: number) {
  const freeGiB = freeMemMb / 1024;
  const rounded = Math.floor((freeGiB - 4) / 10) * 10;
  if (rounded >= 10) return rounded;
  return Math.max(1, Math.floor(freeGiB - 1));
}

export function parseGpuCount(text: string, type: string) {
  if (!text) return 0;
  const esc = type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const typed = new RegExp(`gpu:${esc}:?(\\d+)|gres/gpu:${esc}=(\\d+)`);
  const m = text.match(typed) ?? text.match(/gpu:[A-Za-z0-9_-]+:?(\d+)|gres\/gpu:[A-Za-z0-9_-]+=(\d+)|gpu:(\d+)/);
  if (!m) return 0;
  return Number(m[1] ?? m[2] ?? m[3] ?? 0);
}

export function nodeUp(node: RawNode) {
  return !node.state.some((s) => ["DOWN", "DRAIN", "NOT_RESPONDING"].includes(String(s).toUpperCase()));
}
