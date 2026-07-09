// GPU bin-packing feasibility: can the partition's DEFAULT request actually
// start right now, or are the free GPUs stranded on nodes whose leftover
// CPU/memory can't host it? Pure computation — no React, no i18n — so both the
// Overview pool cards and the Partitions page share one verdict.
import { expandHostlist } from "@/lib/derive";
import { partitionPolicy, type PartitionCap } from "@/lib/slurm";
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
  /** active waiters that can take this slot RIGHT NOW — they fit its free
   *  resources and, when the node is reserved, their own time limit fits the
   *  idle gap (a 24h waiter cannot "own" an 11h gap) */
  contenders: number;
  planned: boolean;
  /** idle seconds until the node's earliest known reservation, if any */
  windowSec: number | null;
}

export function slotContention(row: GpuFitNode, pendingActive: RawJob[], nowMs = 0): SlotContention {
  const planned = row.node.state.some((s) => String(s).toUpperCase() === "PLANNED");
  const win = planned && nowMs ? backfillWindow(row, pendingActive, nowMs) : null;
  const windowSec = win ? Math.max(0, Math.floor((win.untilMs - nowMs) / 1000)) : null;
  let contenders = 0;
  for (const job of pendingActive) {
    // min_memory_mb / cpus / gpus are job totals; a multi-node job claims this
    // node with its per-node share. A waiter in a GPU pool with no parsed GPU
    // count still wants one — counting it keeps us on the "says queue" side.
    const nodes = Math.max(1, job.node_count || 1);
    const gpus = Math.ceil((job.gpus || 0) / nodes) || 1;
    const cpus = Math.ceil((job.cpus || 0) / nodes);
    const memMb = Math.ceil((job.min_memory_mb || 0) / nodes);
    if (gpus > row.freeGpu || cpus > row.freeCores || memMb > row.freeMemMb) continue;
    if (windowSec !== null) {
      // reservation fences the gap: only waiters whose walltime ends inside
      // it can start here now (verified live: a 24h waiter sat pending while
      // a 5-minute job started instantly on the "reserved" node)
      const tl = parseWalltimeSec(job.time_limit || "");
      if (tl <= 0 || tl > windowSec) continue;
    }
    contenders += 1;
  }
  return { contenders, planned, windowSec };
}

/** Would a NEW request needing `requiredSec` of walltime fail to take this
 *  slot right now? Blocked by a now-startable waiter, or by a reservation
 *  whose idle gap is unknown or too short for the request. */
export function slotBlocked(c: SlotContention | null | undefined, requiredSec: number): boolean {
  if (!c) return false;
  if (c.contenders > 0) return true;
  if (!c.planned) return false;
  if (c.windowSec === null) return true;
  return requiredSec > c.windowSec;
}

export function fitHasClearSlot(fit: GpuFitInfo, pendingActive: RawJob[], nowMs: number, requiredSec: number): boolean {
  return fit.fitNodes.some((row) => !slotBlocked(slotContention(row, pendingActive, nowMs), requiredSec));
}

export function hasUncontestedGpuSlot(nodes: RawNode[], pendingActive: RawJob[], pool: Pool, cap: PartitionCap, nowMs: number, requiredSec: number): boolean {
  const fit = gpuFitFromNodes(nodes, [], pool, cap, "");
  return fit.schedulable > 0 && fitHasClearSlot(fit, pendingActive, nowMs, requiredSec);
}

/** Physically-free GPUs in this pool that THIS partition's request can't
 *  reach — the gap behind "3 GPU free at the top, 0 GPU on every policy
 *  below" that a bare hero number leaves unexplained. */
export function gpuStrandedCount(fit: GpuFitInfo): number {
  return Math.max(0, fit.rawFree - fit.schedulable);
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

/** activePendingForPool minus waiters whose every partition in this pool has
 *  its group cap full. Slurm's Reason string lags — a GPU-1 job still says
 *  "Priority" while GrpJobs 30/30 is what actually stops it (observed live:
 *  five such phantom contenders while a fresh job started instantly). */
export function contendersForPool(snap: Snapshot, poolId: string): RawJob[] {
  const running = new Map<string, number>();
  for (const job of snap.jobs) {
    if (String(job.job_state || "").toUpperCase() !== "RUNNING") continue;
    for (const p of String(job.partition || "").split(",")) {
      running.set(p, (running.get(p) ?? 0) + 1);
    }
  }
  const groupOpen = (p: string) => {
    const pol = partitionPolicy(p, snap.policy);
    return !(pol.grpJobs && (running.get(p) ?? 0) >= pol.grpJobs);
  };
  return activePendingForPool(snap.jobs, snap.part_pool, poolId).filter((j) =>
    String(j.partition || "").split(",").some((p) => snap.part_pool[p] === poolId && groupOpen(p)),
  );
}

// ---- backfill window ------------------------------------------------------
// A PLANNED node is reserved for a queued job at a *future* start time (the
// reservation waits for other resources to free). The gap until that start is
// backfillable: Slurm starts a lower-priority job in it iff the job's time
// limit guarantees it ends before the reservation. SchedNodes + StartTime of
// the reserving jobs give the window exactly; margin absorbs reservations
// drifting earlier when running jobs finish ahead of their limits.

const BF_MARGIN_MS = 10 * 60 * 1000;
const BF_STEP_SEC = 15 * 60;
const BF_MIN_SEC = 30 * 60;

export interface BackfillWindowInfo {
  untilMs: number;
  suggestSec: number;
}

export function backfillWindow(row: GpuFitNode, pendingActive: RawJob[], nowMs: number): BackfillWindowInfo | null {
  const starts = pendingActive
    .filter((j) => j.sched_nodes && expandHostlist(j.sched_nodes).includes(row.node.name))
    .map((j) => Date.parse(j.start_est || ""))
    .filter((t) => Number.isFinite(t) && t > nowMs);
  if (!starts.length) return null;
  const untilMs = Math.min(...starts);
  const suggestSec = Math.floor((untilMs - nowMs - BF_MARGIN_MS) / 1000 / BF_STEP_SEC) * BF_STEP_SEC;
  if (suggestSec < BF_MIN_SEC) return null;
  return { untilMs, suggestSec };
}

export interface GpuBackfillTipData {
  node: string;
  mem: string; // "" when the default request already fits the node
  t: string;
  untilMs: number;
}

export function gpuBackfillTipCommand(fit: GpuFitInfo, pool: Pool, pendingActive: RawJob[], nowMs: number, requiredSec: number): GpuBackfillTipData | null {
  if (!pool.gpu) return null;
  if (fit.schedulable > 0) {
    // Slots exist but every one is spoken for — a short job can still sneak in.
    if (fitHasClearSlot(fit, pendingActive, nowMs, requiredSec)) return null;
    for (const row of fit.fitNodes) {
      const win = backfillWindow(row, pendingActive, nowMs);
      if (win) return { node: row.node.name, mem: "", t: fmtWalltime(win.suggestSec), untilMs: win.untilMs };
    }
    return null;
  }
  // prefer the widest gap: a node with a 30-minute window must not hide a
  // sibling whose reservation is half a day out
  let bestTip: GpuBackfillTipData | null = null;
  let bestSec = 0;
  for (const row of strandedCandidates(fit)) {
    const memGb = conservativeMemGb(row.freeMemMb);
    if (memGb <= 0) continue;
    const win = backfillWindow(row, pendingActive, nowMs);
    if (!win || win.suggestSec <= bestSec) continue;
    bestSec = win.suggestSec;
    bestTip = { node: row.node.name, mem: `${memGb}G`, t: fmtWalltime(win.suggestSec), untilMs: win.untilMs };
  }
  return bestTip;
}

/** True when some fitting node's backfill window still holds a job of
 *  `userTimeSec` — the basis for flipping "will queue" back to "can start"
 *  once the user picks a short enough -t. */
export function withinBackfillWindow(fit: GpuFitInfo, pendingActive: RawJob[], nowMs: number, userTimeSec: number): boolean {
  if (userTimeSec <= 0) return false;
  return fit.fitNodes.some((row) => {
    const win = backfillWindow(row, pendingActive, nowMs);
    return win !== null && userTimeSec <= win.suggestSec;
  });
}

export function fmtWalltime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:00`;
}

/** Slurm -t forms: MM, MM:SS, HH:MM:SS, D-HH, D-HH:MM, D-HH:MM:SS. */
export function parseWalltimeSec(text: string): number {
  const s = String(text || "").trim();
  if (!s) return 0;
  const dash = s.match(/^(\d+)-(\d+)(?::(\d{1,2}))?(?::(\d{1,2}))?$/);
  if (dash) {
    return (Number(dash[1]) * 24 + Number(dash[2])) * 3600 + Number(dash[3] || 0) * 60 + Number(dash[4] || 0);
  }
  const parts = s.split(":");
  if (parts.some((p) => !/^\d+$/.test(p))) return 0;
  if (parts.length === 1) return Number(parts[0]) * 60;
  if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
  if (parts.length === 3) return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  return 0;
}

function strandedCandidates(fit: GpuFitInfo): GpuFitNode[] {
  return fit.stranded.filter((row) => row.freeGpu >= 1 && row.freeCores >= fit.need.cores && row.freeMemMb > 1024);
}

export function gpuFitTipCommand(fit: GpuFitInfo, pool: Pool, pendingActive: RawJob[], nowMs: number, requiredSec: number): GpuFitTipData | null {
  if (!pool.gpu || fit.schedulable > 0) return null;
  // The --mem trick only queue-jumps while no now-startable waiter fits the
  // slot and any reservation's idle gap holds the request's walltime; a
  // blocked node must not hide a clear sibling, so scan every candidate.
  for (const best of strandedCandidates(fit)) {
    if (slotBlocked(slotContention(best, pendingActive, nowMs), requiredSec)) continue;
    const memGb = conservativeMemGb(best.freeMemMb);
    if (memGb > 0) return { mem: `${memGb}G`, node: best.node.name };
  }
  return null;
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
