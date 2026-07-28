// GPU bin-packing feasibility: can the partition's DEFAULT request actually
// start right now, or are the free GPUs stranded on nodes whose leftover
// CPU/memory can't host it? Pure computation — no React, no i18n — so both the
// Overview pool cards and the Partitions page share one verdict.
import { expandHostlist, nodeIsSchedulable } from "@/lib/derive";
import { gpuPerGpuNeed, type GpuDefaultRequest, type GpuNodeFacts } from "@/lib/gpu-availability";
import { capPerGpu, partitionDefaultRequest, partitionPolicy, type PartitionCap } from "@/lib/slurm";
import type { PolicySnapshot, Pool, RawJob, RawNode, Snapshot } from "@/types/snapshot";

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

export function schedulableGpuSlots(nodes: RawNode[], pool: Pool, cap: PartitionCap,
                                    partition: string, policy?: PolicySnapshot) {
  return gpuFitFromNodes(nodes, [], pool, cap, partition,
                         partitionDefaultRequest(partition, policy)).schedulable;
}

export function gpuFitSnapshot(snap: Snapshot, pool: Pool, cap: PartitionCap, partition: string): GpuFitInfo {
  return gpuFitFromNodes(snap.nodes, snap.jobs, pool, cap, partition,
                         partitionDefaultRequest(partition, snap.policy));
}

export function gpuFitFromNodes(nodes: RawNode[], jobs: RawJob[], pool: Pool, cap: PartitionCap,
                                partition: string, request: GpuDefaultRequest): GpuFitInfo {
  const need = gpuFitNeed(nodes, pool, cap, partition, request);
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
    const normallySchedulable = nodeIsSchedulable(node);
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

// Kept in sync with backend/normalize.py needs_attention(): these states mean
// "operator problem", every other non-schedulable state is a scheduler hold.
const ATTENTION_STATES = ["DOWN", "NOT_RESPONDING", "DRAIN", "DRAINING", "FAIL", "FAILING",
  "MAINT", "POWER_DOWN", "POWERING_DOWN", "POWERED_DOWN", "REBOOT_ISSUED", "REBOOT_REQUESTED"];

/** Adapt a pool's raw nodes into the plain records gpu-availability classifies.
 *  Every node of the pool is included — a drained node's idle GPUs are part of
 *  the picture ("down"), they are just not capacity. */
export function gpuNodeFacts(nodes: RawNode[], pool: Pool, pendingActive: RawJob[], nowMs: number): GpuNodeFacts[] {
  const type = pool.gpu?.type ?? "";
  return nodes
    .filter((node) => node.pool === pool.id)
    .map((node) => {
      const states = new Set(node.state.map((state) => String(state).toUpperCase()));
      const offline = ATTENTION_STATES.some((state) => states.has(state));
      const held = !offline && !nodeIsSchedulable(node);
      const freeGpu = Math.max(0, parseGpuCount(node.gres, type) - parseGpuCount(node.gres_used, type));
      const freeCores = Math.max(0, node.cpus - node.alloc_cpus);
      const freeMemMb = Math.max(0, node.real_memory - node.alloc_memory);
      // Contention only decides the verdict for nodes that are otherwise
      // takeable; an offline or held node is already spoken for.
      const contested = !offline && !held && freeGpu > 0
        && slotContention({ node, freeGpu, freeCores, freeMemMb } as GpuFitNode, pendingActive, nowMs).contenders > 0;
      return {
        name: node.name,
        gpusTotal: parseGpuCount(node.gres, type),
        gpusUsed: parseGpuCount(node.gres_used, type),
        coresTotal: node.cpus,
        coresFree: freeCores,
        memTotalMb: node.real_memory,
        memFreeMb: freeMemMb,
        offline,
        held,
        contested,
      };
    });
}

/** PLANNED is a future scheduler reservation, not an outage. Such a node must
 * stay out of ordinary free totals, but Slurm may backfill its idle resources
 * when the request is guaranteed to finish before the reservation starts. */
function nodeIsBackfillCandidate(node: RawNode) {
  const states = new Set(node.state.map((state) => String(state).toUpperCase()));
  if (!states.has("PLANNED")) return false;
  return !["DOWN", "NOT_RESPONDING", "DRAIN", "DRAINING", "FAIL", "FAILING", "MAINT",
    "POWER_DOWN", "POWERING_DOWN", "POWERED_DOWN", "REBOOT_ISSUED", "REBOOT_REQUESTED"]
    .some((state) => states.has(state));
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
                    request: GpuDefaultRequest): GpuFitNeed {
  const poolNodes = nodes.filter((node) => node.pool === pool.id);
  const shape = {
    gpus: Math.max(0, ...poolNodes.map((node) => parseGpuCount(node.gres, pool.gpu?.type ?? ""))),
    cores: Math.max(0, ...poolNodes.map((node) => node.cpus)),
    memMb: Math.max(0, ...poolNodes.map((node) => node.real_memory)),
  };
  const need = gpuPerGpuNeed(request, shape, capPerGpu(cap));
  return { partition, gpus: need.gpus, cores: need.cores, memMb: need.memMb };
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
    if (!pendingJobMayUseNode(job, row.node.name)) continue;
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

/** Apply Slurm's explicit host constraints before calling a queued job a
 * contender for a particular node. ReqNodeList entries are mandatory, but
 * Slurm may add other hosts when the requested node count is larger than that
 * list. SchedNodes deliberately does not participate: it is a movable plan,
 * not a user constraint. */
export function pendingJobMayUseNode(job: RawJob, nodeName: string): boolean {
  const excluded = expandHostlist(job.exc_nodes || "");
  if (excluded.includes(nodeName)) return false;

  const required = expandHostlist(job.req_nodes || "");
  if (required.length === 0 || required.includes(nodeName)) return true;
  return Math.max(1, job.node_count || 1) > required.length;
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

/** Physically-idle GPUs in this pool that THIS partition's default request
 *  can't have right now: nodes short on leftover CPU/mem, plus cards the
 *  scheduler holds for a future reservation. Both kinds stay reachable via
 *  tweaks or the timed backfill gap, so the UI shows their count in amber
 *  instead of a bare "0". */
export function gpuStrandedCount(fit: GpuFitInfo): number {
  const reserved = fit.reservedNodes.reduce((sum, row) => sum + row.freeGpu, 0);
  return Math.max(0, fit.rawFree - fit.schedulable) + reserved;
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
  }
  // Prefer the widest real scheduler window. PLANNED rows live in
  // reservedNodes (and remain excluded from ordinary free/schedulable totals).
  let bestTip: GpuBackfillTipData | null = null;
  let bestSec = 0;
  for (const row of [...fit.reservedNodes, ...fit.fitNodes, ...strandedCandidates(fit)]) {
    if (row.freeGpu < fit.need.gpus || row.freeCores < fit.need.cores) continue;
    let mem = "";
    if (fit.need.memMb > 0 && row.freeMemMb < fit.need.memMb) {
      const memGb = conservativeMemGb(row.freeMemMb);
      if (memGb <= 0) continue;
      mem = `${memGb}G`;
    }
    const win = backfillWindow(row, pendingActive, nowMs);
    if (!win || win.suggestSec <= bestSec) continue;
    bestSec = win.suggestSec;
    bestTip = { node: row.node.name, mem, t: fmtWalltime(win.suggestSec), untilMs: win.untilMs };
  }
  return bestTip;
}

/** True when some fitting node's backfill window still holds a job of
 *  `userTimeSec` — the basis for flipping "will queue" back to "can start"
 *  once the user picks a short enough -t. */
export function withinBackfillWindow(fit: GpuFitInfo, pendingActive: RawJob[], nowMs: number, userTimeSec: number): boolean {
  if (userTimeSec <= 0) return false;
  return [...fit.fitNodes, ...fit.reservedNodes].some((row) => {
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
