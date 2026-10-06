// Client-side derivations from the raw data shipped in the snapshot.
// Keeps "raw" (server) and "derived" (here) cleanly separated — one pull feeds all.
// The backend tags each raw node with its `pool` (see site_config.Site.assign_pools), so the
// client never re-derives the name→pool mapping.
import type { Occupant, RawJob, RawNode, Snapshot } from "@/types/snapshot";

/** A running job, shaped for the occupancy lists. */
function toOccupant(j: RawJob): Occupant {
  return {
    job_id: j.job_id,
    user: j.user_name,
    partition: j.partition,
    gpus: j.gpus,
    cpus: j.cpus,
    mem_mb: j.min_memory_mb ?? 0,
    nodes: j.node_count,
    nodelist: j.nodelist,
    time_left: j.time_left,
    time_limit: j.time_limit,
    end_time: j.end_time,
  };
}

/** Cores on one node of a pool — pools are homogeneous, so the pool total
 *  divided by its node count is the per-node figure Slurm sees. */
export function coresPerNode(pool: { nodes: number; cores: { total: number } }): number {
  return pool.nodes > 0 ? Math.floor(pool.cores.total / pool.nodes) : 0;
}

/** All raw nodes belonging to a pool. */
export function nodesForPool(snap: Snapshot, poolId: string): RawNode[] {
  return snap.nodes.filter((n) => n.pool === poolId);
}

const BLOCKING_STATES = new Set([
  "DOWN", "NOT_RESPONDING", "DRAIN", "DRAINING", "FAIL", "FAILING",
  "RESERVED", "PLANNED", "MAINT", "FUTURE", "UNKNOWN", "POWER_DOWN",
  "POWERING_DOWN", "POWERED_DOWN", "POWERING_UP", "REBOOT_ISSUED", "REBOOT_REQUESTED",
]);

// Kept in sync with backend/normalize.py needs_attention(): these states mean
// "operator problem", every other non-schedulable state is a scheduler hold.
const ATTENTION_STATES = new Set([
  "DOWN", "NOT_RESPONDING", "DRAIN", "DRAINING", "FAIL", "FAILING",
  "MAINT", "POWER_DOWN", "POWERING_DOWN", "POWERED_DOWN", "REBOOT_ISSUED", "REBOOT_REQUESTED",
]);

/** Node is out of service and needs an operator (down, drained, rebooting). */
export function nodeNeedsAttention(n: RawNode): boolean {
  return n.state.some((s) => ATTENTION_STATES.has(String(s).toUpperCase()));
}

/** In service, but its idle resources are held back by the scheduler (a
 *  future reservation, a powering-up node…). A plain ALLOCATED/COMPLETING
 *  node is NOT held: whatever it has left is simply too small, and saying
 *  "reserved" there would send users looking for a reservation that does
 *  not exist (keep in sync with backend/normalize.py idle_gpu_bucket). */
export function nodeIsSchedulerHeld(n: RawNode): boolean {
  if (nodeNeedsAttention(n) || nodeIsSchedulable(n)) return false;
  return n.state.some((s) => BLOCKING_STATES.has(String(s).toUpperCase()));
}

/** Unallocated cores the pool's free count leaves out, split by why: on
 *  nodes an operator took out (down/drain) vs nodes the scheduler is holding
 *  for queued jobs (PLANNED…). Painting both as "down" called 366 healthy
 *  cores broken; the held ones can turn free at the next scheduling pass. */
export function unschedulableCores(nodes: RawNode[], poolId: string) {
  let reserved = 0;
  let down = 0;
  for (const n of nodes) {
    if (n.pool !== poolId || nodeIsSchedulable(n)) continue;
    const idle = Math.max(0, n.cpus - n.alloc_cpus);
    if (nodeNeedsAttention(n)) down += idle;
    else if (nodeIsSchedulerHeld(n)) reserved += idle;
  }
  return { reserved, down };
}

/** Backend-owned scheduling verdict, with a strict fallback for older snapshots. */
export function nodeIsSchedulable(n: RawNode): boolean {
  if (typeof n.schedulable === "boolean") return n.schedulable;
  const states = new Set(n.state.map((s) => s.toUpperCase()));
  return [...states].some((s) => s === "IDLE" || s === "MIXED")
    && ![...states].some((s) => BLOCKING_STATES.has(s));
}

export interface PoolCapacity {
  freeCores: number; // idle, runnable cores across up nodes
  emptiestNodeFree: number; // most free cores on a single up node (bounds 1-node jobs)
  idleNodes: number; // fully-idle up nodes (bounds whole-node multi-node jobs)
}

/** Live, fragmentation-aware free capacity of a pool — what a job can realistically grab now. */
export function poolCapacity(snap: Snapshot, poolId: string): PoolCapacity {
  let freeCores = 0;
  let emptiestNodeFree = 0;
  let idleNodes = 0;
  for (const n of nodesForPool(snap, poolId)) {
    if (!nodeIsSchedulable(n)) continue;
    const free = Math.max(0, n.cpus - n.alloc_cpus);
    freeCores += free;
    if (free > emptiestNodeFree) emptiestNodeFree = free;
    if (n.cpus > 0 && free === n.cpus) idleNodes += 1;
  }
  return { freeCores, emptiestNodeFree, idleNodes };
}

export interface PoolNodeStates {
  idle: number;     // in service, every core free
  partial: number;  // in service, some cores free
  held: number;     // idle cores held by the scheduler for a queued job (PLANNED…)
  full: number;     // no free core
  down: number;     // taken out by an operator (down, drain, reboot)
}

/** Each node of a pool by what it offers now — the one rule both the pool
 *  card's bar and the Partitions bar draw, one cell per node: green idle,
 *  amber partly free or held, red full, gray down. */
export function poolNodeStates(snap: Snapshot, poolId: string): PoolNodeStates {
  const s: PoolNodeStates = { idle: 0, partial: 0, held: 0, full: 0, down: 0 };
  for (const n of nodesForPool(snap, poolId)) {
    if (nodeNeedsAttention(n)) s.down += 1;
    else if (nodeIsSchedulable(n)) {
      const free = Math.max(0, n.cpus - n.alloc_cpus);
      if (free <= 0) s.full += 1;
      else if (free === n.cpus) s.idle += 1;
      else s.partial += 1;
    } else if (nodeIsSchedulerHeld(n)) s.held += 1;
    else s.full += 1;
  }
  return s;
}

/** Running jobs occupying a pool, from raw jobs + the partition→pool map. */
export function occupantsForPool(snap: Snapshot, poolId: string): Occupant[] {
  const pp = snap.part_pool;
  const out: Occupant[] = [];
  for (const j of snap.jobs) {
    if (j.job_state !== "RUNNING") continue;
    const part = String(j.partition).split(",")[0];
    if (pp[part] !== poolId) continue;
    out.push(toOccupant(j));
  }
  return out.sort((a, b) => b.gpus - a.gpus || b.cpus - a.cpus || b.nodes - a.nodes);
}

/** Expand a Slurm hostlist: "lcpcc-[001-003,005]" -> [lcpcc-001, lcpcc-002, lcpcc-003, lcpcc-005]. */
export function expandHostlist(s: string): string[] {
  if (!s) return [];
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) parts.push(cur);

  const out: string[] = [];
  for (const part of parts) {
    const m = part.match(/^(.*?)\[([^\]]+)\](.*)$/);
    if (!m) {
      out.push(part);
      continue;
    }
    const [, pre, ranges, post] = m;
    for (const r of ranges.split(",")) {
      const rm = r.match(/^(\d+)-(\d+)$/);
      if (rm) {
        const width = rm[1].length;
        for (let i = Number(rm[1]); i <= Number(rm[2]); i++) {
          out.push(pre + String(i).padStart(width, "0") + post);
        }
      } else out.push(pre + r + post);
    }
  }
  return out;
}

/** Running jobs on a specific node (who's using that node). */
export function jobsOnNode(snap: Snapshot, node: string): Occupant[] {
  const out: Occupant[] = [];
  for (const j of snap.jobs) {
    if (j.job_state !== "RUNNING" || !j.nodelist) continue;
    if (expandHostlist(j.nodelist).includes(node)) out.push(toOccupant(j));
  }
  return out.sort((a, b) => b.cpus - a.cpus);
}

/** GPUs of `type` in a gres string ("gpu:nvidia_a40:2(S:0-1)"); any GPU type
 *  when that one is absent. */
export function parseGpuCount(text: string, type: string) {
  if (!text) return 0;
  const esc = type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const typed = new RegExp(`gpu:${esc}:?(\\d+)|gres/gpu:${esc}=(\\d+)`);
  const m = text.match(typed) ?? text.match(/gpu:[A-Za-z0-9_.-]+:?(\d+)|gres\/gpu:[A-Za-z0-9_.-]+=(\d+)|gpu:(\d+)/);
  if (!m) return 0;
  return Number(m[1] ?? m[2] ?? m[3] ?? 0);
}

/** PLANNED is a future scheduler reservation, not an outage. Such a node must
 * stay out of ordinary free totals, but Slurm may backfill its idle resources
 * when the request is guaranteed to finish before the reservation starts:
 * backfill reserves whole nodes for a planned job (node_space avail_bitmap,
 * backfill.c:168) and marks them PLANNED (backfill.c:3905). */
export function nodeIsBackfillCandidate(node: RawNode) {
  const states = new Set(node.state.map((state) => String(state).toUpperCase()));
  if (!states.has("PLANNED")) return false;
  return !["DOWN", "NOT_RESPONDING", "DRAIN", "DRAINING", "FAIL", "FAILING", "MAINT",
    "POWER_DOWN", "POWERING_DOWN", "POWERED_DOWN", "REBOOT_ISSUED", "REBOOT_REQUESTED"]
    .some((state) => states.has(state));
}
