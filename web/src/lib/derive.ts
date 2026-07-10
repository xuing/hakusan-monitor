// Client-side derivations from the raw data shipped in the snapshot.
// Keeps "raw" (server) and "derived" (here) cleanly separated — one pull feeds all.
// The backend tags each raw node with its `pool` (see normalize.node_pool), so the
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

/** All raw nodes belonging to a pool. */
export function nodesForPool(snap: Snapshot, poolId: string): RawNode[] {
  return snap.nodes.filter((n) => n.pool === poolId);
}

const BLOCKING_STATES = new Set([
  "DOWN", "NOT_RESPONDING", "DRAIN", "DRAINING", "FAIL", "FAILING",
  "RESERVED", "PLANNED", "MAINT", "FUTURE", "UNKNOWN", "POWER_DOWN",
  "POWERING_DOWN", "POWERED_DOWN", "POWERING_UP", "REBOOT_ISSUED", "REBOOT_REQUESTED",
]);

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

export interface PoolUser {
  user: string;
  running: number;
  cpus: number;
  gpus: number;
}

/** Running users on a pool (for the filter-aware "most active users"). */
export function usersForPool(snap: Snapshot, poolId: string): PoolUser[] {
  const pp = snap.part_pool;
  const map = new Map<string, PoolUser>();
  for (const j of snap.jobs) {
    if (j.job_state !== "RUNNING") continue;
    if (pp[String(j.partition).split(",")[0]] !== poolId) continue;
    const u = map.get(j.user_name) ?? { user: j.user_name, running: 0, cpus: 0, gpus: 0 };
    u.running += 1;
    u.cpus += j.cpus;
    u.gpus += j.gpus;
    map.set(j.user_name, u);
  }
  return [...map.values()].sort((a, b) =>
    b.running - a.running || b.gpus - a.gpus || b.cpus - a.cpus,
  ).slice(0, 10);
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
