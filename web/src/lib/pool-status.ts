/**
 * A pool's verdict — the one every pool-level display reads: the filter
 * chip's dot, the group header's count, the pool card's dot, border and free
 * count. It agrees with the pool's collapsed quick-request row by
 * construction: both lead with `poolPick`.
 *
 *   ok    some partition's default request starts now
 *   warn  capacity is idle, but no default request can take it now
 *   bad   nothing is free
 *   off   the pool is in maintenance
 */
import { cpuPartitionStatus, cpuPartitionTone, type CpuPartitionStatus } from "@/lib/cpu-partition";
import { unschedulableCores } from "@/lib/derive";
import { gpuStatus, gpuVerdict, type GpuStatus, type GpuVerdict } from "@/lib/gpu-partition";
import { isLicensePartition, type Tone } from "@/lib/slurm";
import { partitionOrderRank } from "@/lib/site";
import type { Pool, Snapshot } from "@/types/snapshot";

export type PoolTone = "ok" | "warn" | "bad" | "off";

export type PoolPick =
  | { kind: "gpu"; partition: string; status: GpuStatus }
  | { kind: "cpu"; partition: string; status: CpuPartitionStatus };

const GPU_RANK: Record<GpuVerdict, number> = { now: 0, bypass: 1, gap: 2, queue: 3, maint: 4 };
const CPU_RANK: Record<Tone, number> = { ok: 0, warn: 1, info: 2, neutral: 2, bad: 3 };

/** The pool's most startable general partition (license-only ones are no
 *  pick for an ordinary job). Between equals: the partition the quick
 *  request opens with, then the site's order. */
export function poolPick(snap: Snapshot, pool: Pool): PoolPick | null {
  const parts = pool.partitions
    .filter((p) => !isLicensePartition(p, snap.policy))
    .sort((a, b) => Number(b === pool.sample_partition) - Number(a === pool.sample_partition)
      || partitionOrderRank(a) - partitionOrderRank(b));
  if (parts.length === 0) return null;
  if (pool.kind === "gpu") {
    const picks = parts.map((partition) => ({ kind: "gpu" as const, partition, status: gpuStatus(snap, pool, partition) }));
    return picks.sort((a, b) => GPU_RANK[gpuVerdict(a.status)] - GPU_RANK[gpuVerdict(b.status)])[0];
  }
  const picks = parts.map((partition) => ({ kind: "cpu" as const, partition, status: cpuPartitionStatus(snap, partition) }));
  return picks.sort((a, b) => CPU_RANK[cpuPartitionTone(a.status)] - CPU_RANK[cpuPartitionTone(b.status)])[0];
}

export function poolTone(snap: Snapshot, pool: Pool): PoolTone {
  if (pool.kind === "gpu" ? pool.gpu?.maint : pool.nodes > 0 && pool.down_nodes >= pool.nodes) return "off";
  const pick = poolPick(snap, pool);
  const starts = pick?.kind === "gpu" ? gpuVerdict(pick.status) === "now" : pick ? cpuPartitionTone(pick.status) === "ok" : false;
  if (starts) return "ok";
  const idle = pool.kind === "gpu"
    ? (pool.gpu?.free ?? 0) + (pool.gpu?.reserved ?? 0)
    : pool.cores.free + unschedulableCores(snap.nodes, pool.id).reserved;
  return idle > 0 ? "warn" : "bad";
}
