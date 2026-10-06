/**
 * Who holds how much of each hardware pool — the derivation behind the
 * Overview "top users" card.
 *
 * A user's weight in a pool is the share of that pool's TOTAL capacity they
 * hold in their dominant resource (GPUs, cores or memory), the way
 * dominant-resource fairness ranks tenants: 7 of 40 A40 GPUs is 17.5% of the
 * pool whether the jobs took 112 or 364 cores with them, and a 1-core job
 * that pins a whole node's memory is ranked by that memory. Shares are per
 * pool and never summed across pools — 1 H100 (25% of 4) and 6,913 CPU cores
 * (22% of 31,744) are different kinds of claim and sit in different panels.
 *
 * Everything is derived from the raw jobs and nodes the snapshot already
 * ships, so the card and the Jobs table never disagree; user names arrive
 * masked whenever the backend masks them (server.py applies mask_user to
 * snap.jobs), so nothing here can reveal a name the backend hides.
 */
import type { Pool, RawJob, RawNode, Snapshot } from "@/types/snapshot";

type Resource = "gpus" | "cores" | "mem";

/** Tie order: a GPU is the scarcer unit, memory the least visible one. */
const RESOURCE_ORDER: Resource[] = ["gpus", "cores", "mem"];

export interface PoolTotals {
  cores: number;
  gpus: number;
  memMb: number;
}

interface Amounts {
  cores: number;
  gpus: number;
  memMb: number;
}

export interface UserUsage {
  user: string;
  /** running jobs in this pool */
  running: number;
  held: Amounts;
  /** GPUs held per pool id (a group spans several GPU models) */
  gpusByPool: Record<string, number>;
  /** pending jobs in this pool and what they ask for */
  pending: number;
  queued: Amounts;
  /** held / pool total, per resource (0..1) */
  shares: Record<Resource, number>;
  /** the resource with the largest share: what this user really takes from the pool */
  dominant: Resource;
}

export interface PoolUsage {
  /** a pool id, or "gpu" / "cpu" for a group of pools */
  id: string;
  /** the one pool, or the group's pools */
  pools: Pool[];
  totals: PoolTotals;
  /** the unit users compete for here: GPUs on a GPU pool, cores otherwise */
  unit: "gpus" | "cores";
  /** every user with a running job in the pool, heaviest first */
  users: UserUsage[];
  /** pending jobs in the pool, whoever submitted them */
  pendingJobs: number;
}

export interface UsageTail {
  users: number;
  running: number;
  /** summed pool units (GPUs or cores) and their share of the pool */
  units: number;
  share: number;
}

const zero = (): Amounts => ({ cores: 0, gpus: 0, memMb: 0 });

function add(into: Amounts, job: RawJob) {
  into.cores += job.cpus || 0;
  into.gpus += job.gpus || 0;
  into.memMb += job.min_memory_mb ?? 0;
}

/** Amount of one resource out of an Amounts record. */
const amountOf = (a: Amounts, r: Resource): number => (r === "mem" ? a.memMb : a[r]);

/** Share of the pool's total capacity for one resource; 0 when the pool has none. */
function shareOf(totals: PoolTotals, r: Resource, amount: number): number {
  const total = r === "mem" ? totals.memMb : totals[r];
  return total > 0 ? amount / total : 0;
}

/** Total capacity of a pool, down nodes included: the stable denominator
 *  every other card uses. Cores and GPUs come from the backend's pool
 *  summary; memory is summed from the pool's nodes (the summary only
 *  carries a per-node figure), with that figure × nodes as the fallback for
 *  a snapshot without node rows. */
export function poolTotals(pool: Pool, nodes: RawNode[]): PoolTotals {
  let memMb = 0;
  let seen = 0;
  for (const n of nodes) {
    if (n.pool !== pool.id) continue;
    seen += 1;
    memMb += n.real_memory || 0;
  }
  if (seen === 0) memMb = (pool.mem_per_node || 0) * (pool.nodes || 0);
  return { cores: pool.cores?.total ?? 0, gpus: pool.gpu?.total ?? 0, memMb };
}

/** A running job runs in one partition; a pending job may list several, and
 *  counts in a pool when any of them maps there (same rule as pendingForPool). */
const partitions = (job: RawJob) => String(job.partition || "").split(",").filter(Boolean);

function runsInPool(job: RawJob, partPool: Record<string, string>, poolId: string): boolean {
  const first = partitions(job)[0];
  return first !== undefined && partPool[first] === poolId;
}

function pendsInPool(job: RawJob, partPool: Record<string, string>, poolId: string): boolean {
  return partitions(job).some((p) => partPool[p] === poolId);
}

function dominantOf(shares: Record<Resource, number>, unit: "gpus" | "cores"): Resource {
  let best: Resource = RESOURCE_ORDER[0];
  for (const r of RESOURCE_ORDER) if (shares[r] > shares[best]) best = r;
  return shares[best] > 0 ? best : unit;
}

function compareUsers(a: UserUsage, b: UserUsage): number {
  return (
    b.shares[b.dominant] - a.shares[a.dominant] ||
    b.held.gpus - a.held.gpus ||
    b.held.cores - a.held.cores ||
    b.held.memMb - a.held.memMb ||
    b.running - a.running ||
    a.user.localeCompare(b.user)
  );
}

/** Usage of one pool by user; null when the pool is not in the snapshot. */
export function poolUsage(snap: Snapshot, poolId: string): PoolUsage | null {
  const pool = snap.pools.find((p) => p.id === poolId);
  return pool ? usageOf(snap, [pool], poolId) : null;
}

/** Usage of every GPU pool, or every CPU pool, as one ranking: amounts and
 *  capacities summed over the pools; a pool that is wholly in maintenance
 *  adds no capacity. null when nobody runs there. */
export function groupUsage(snap: Snapshot, kind: "gpu" | "cpu"): PoolUsage | null {
  const pools = snap.pools.filter((p) => p.kind === kind && !p.gpu?.maint);
  if (pools.length === 0) return null;
  const usage = usageOf(snap, pools, kind);
  return usage.users.length > 0 ? usage : null;
}

function usageOf(snap: Snapshot, pools: Pool[], id: string): PoolUsage {
  const totals = pools
    .map((pool) => poolTotals(pool, snap.nodes))
    .reduce((a, b) => ({ cores: a.cores + b.cores, gpus: a.gpus + b.gpus, memMb: a.memMb + b.memMb }), { cores: 0, gpus: 0, memMb: 0 });
  const unit: "gpus" | "cores" = totals.gpus > 0 ? "gpus" : "cores";
  const ids = pools.map((p) => p.id);

  interface Acc {
    user: string;
    running: number;
    held: Amounts;
    gpusByPool: Record<string, number>;
    pending: number;
    queued: Amounts;
  }
  const byUser = new Map<string, Acc>();
  const acc = (user: string): Acc => {
    let a = byUser.get(user);
    if (!a) {
      a = { user, running: 0, held: zero(), gpusByPool: {}, pending: 0, queued: zero() };
      byUser.set(user, a);
    }
    return a;
  };

  let pendingJobs = 0;
  for (const job of snap.jobs) {
    const state = String(job.job_state || "").toUpperCase();
    if (state === "RUNNING") {
      const poolId = ids.find((p) => runsInPool(job, snap.part_pool, p));
      if (!poolId) continue;
      const a = acc(job.user_name);
      a.running += 1;
      add(a.held, job);
      if (job.gpus) a.gpusByPool[poolId] = (a.gpusByPool[poolId] ?? 0) + job.gpus;
    } else if (state === "PENDING") {
      if (!ids.some((p) => pendsInPool(job, snap.part_pool, p))) continue;
      pendingJobs += 1;
      const a = acc(job.user_name);
      a.pending += 1;
      add(a.queued, job);
    }
  }

  const users: UserUsage[] = [];
  for (const a of byUser.values()) {
    if (a.running === 0) continue; // queued-only users hold nothing yet
    const shares: Record<Resource, number> = {
      gpus: shareOf(totals, "gpus", a.held.gpus),
      cores: shareOf(totals, "cores", a.held.cores),
      mem: shareOf(totals, "mem", a.held.memMb),
    };
    users.push({ ...a, shares, dominant: dominantOf(shares, unit) });
  }
  users.sort(compareUsers);
  return { id, pools, totals, unit, users, pendingJobs };
}

/** The first `limit` users plus one aggregate for everyone after them, so
 *  the panel still says how concentrated the pool is. */
export function topUsers(usage: PoolUsage, limit: number): { shown: UserUsage[]; rest: UsageTail | null } {
  const shown = usage.users.slice(0, limit);
  const tail = usage.users.slice(limit);
  if (tail.length === 0) return { shown, rest: null };
  let running = 0;
  let units = 0;
  for (const u of tail) {
    running += u.running;
    units += amountOf(u.held, usage.unit);
  }
  return { shown, rest: { users: tail.length, running, units, share: shareOf(usage.totals, usage.unit, units) } };
}

/** 0..1 -> "18%", "6.5%", "<0.1%": whole percents from 10% up, one decimal
 *  below, so a 2-core job on a 31,744-core pool never rounds to "0%". */
export function fmtShare(x: number): string {
  if (!(x > 0)) return "0%";
  if (x < 0.001) return "<0.1%";
  const p = x * 100;
  return p < 9.95 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}
