import { partitionCap } from "@/lib/slurm";
import type { Pool, Snapshot } from "@/types/snapshot";

/** CPU pools of at most this many cores draw one cell per core. */
export const GRID_MAX_CORES = 128;

/** How a pool's occupancy map is drawn, from the pool's own shape: one cell
 *  per GPU, or per core on a pool this small (the 96-core large-memory
 *  node); one row per node where no partition lets a job outgrow a node
 *  (VM-CPU's 32-core VMs); otherwise a treemap. */
export function occupancyMode(pool: Pool, snap: Snapshot): { grid: boolean; dashed: boolean; perRow?: number } {
  if (pool.kind === "gpu") return { grid: true, dashed: false };
  if (pool.cores.total <= GRID_MAX_CORES) return { grid: true, dashed: true };
  const perNode = pool.nodes > 0 ? Math.floor(pool.cores.total / pool.nodes) : 0;
  const wholeNodes = perNode > 0 && pool.partitions.length > 0 && pool.partitions.every((p) => {
    const max = partitionCap(p, snap.policy).maxCores;
    return max !== undefined && max <= perNode;
  });
  return { grid: false, dashed: false, perRow: wholeNodes ? perNode : undefined };
}
