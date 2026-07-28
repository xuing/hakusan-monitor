/**
 * Does a partition's flagless request actually fit one node?
 *
 * Hakusan's submit plugin puts a fixed task count on every request, and the
 * partition's `DefMemPerCPU` turns that into a memory total. On three
 * partitions the product exceeds what a single node holds, so Slurm either
 * spreads the job over two nodes or refuses it outright (measured 2026-07-29):
 *
 *   VM-CPU     32 x 14900 = 476800 MB  > 469070 MB   -> lands on 2 nodes
 *   VM-GPU-L   32 x 14900 = 476800 MB  > 469070 MB   -> 2 nodes AND 2 GPUs
 *   VM-LM      96 x 39300 = 3772800 MB > 3754178 MB  -> submission refused
 *                ("Requested topology configuration is not available")
 *
 * This is a cluster-configuration defect, not something the dashboard can fix.
 * What the dashboard must do is never print a starter command that silently
 * books twice the hardware — so the check is generic and data-driven: when a
 * future config change breaks another partition the same way, the card says so
 * on its own.
 */
import type { GpuDefaultRequest } from "@/lib/gpu-availability";

export interface NodeShape {
  cores: number;
  memMb: number;
}

export interface DefaultRequestFit {
  /** tasks the plugin puts on a flagless request */
  cores: number;
  /** DefMemPerCPU */
  memPerCoreMb: number;
  /** cores x memPerCoreMb — what the request really asks for */
  memMb: number;
  node: NodeShape;
  /** true when one node can hold the whole default request */
  fitsOneNode: boolean;
  /** MB by which the default request overshoots one node (0 when it fits) */
  shortfallMb: number;
  /** most tasks one node can host at this per-core rate */
  maxCoresOnOneNode: number;
  /** nodes Slurm needs to place the default request */
  nodesNeeded: number;
}

export function defaultRequestFit(request: GpuDefaultRequest, node: NodeShape): DefaultRequestFit | null {
  const cores = Math.max(0, Math.floor(request.cores));
  const memPerCoreMb = Math.max(0, Math.floor(request.memPerCoreMb));
  // Without both measured values there is nothing to check — say so with null
  // rather than inventing a verdict from a partial snapshot.
  if (cores <= 0 || memPerCoreMb <= 0 || node.memMb <= 0 || node.cores <= 0) return null;
  const memMb = cores * memPerCoreMb;
  const byMemory = Math.floor(node.memMb / memPerCoreMb);
  const maxCoresOnOneNode = Math.max(0, Math.min(node.cores, byMemory));
  return {
    cores,
    memPerCoreMb,
    memMb,
    node,
    fitsOneNode: memMb <= node.memMb && cores <= node.cores,
    shortfallMb: Math.max(0, memMb - node.memMb),
    maxCoresOnOneNode,
    nodesNeeded: maxCoresOnOneNode > 0 ? Math.ceil(cores / maxCoresOnOneNode) : 0,
  };
}

/** The `-n` that pins the default request to a single node, or "" when the
 *  default already fits (nothing to add) or no node can host even one task. */
export function singleNodeCoreFlag(fit: DefaultRequestFit | null): string {
  if (!fit || fit.fitsOneNode || fit.maxCoresOnOneNode <= 0) return "";
  return `-n ${fit.maxCoresOnOneNode}`;
}
