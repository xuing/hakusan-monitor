/**
 * Which multi-GPU requests a partition can actually grant, and the flags for
 * each — derived from the cluster's own policy, never from constants.
 *
 * Inputs are the QoS cap (sacctmgr) and the node shape (scontrol). Every
 * layout returned here passes the checks Slurm would apply: total cores,
 * memory and GPUs within the QoS, node count within the pool. A layout Slurm
 * would refuse — or accept and then leave pending forever — is not offered.
 *
 * Every layout runs one task per GPU with a per-GPU share of the node's cores
 * (memory follows from DefMemPerCPU), so a job holding all of a node's GPUs
 * also holds the cores that go with them. Measured 2026-10-05:
 *  - GPU-S `-n 2 -c 26 --gres=gpu:2` → cpu=52, mem≈500G, 2 GPUs; a bare
 *    `--gres=gpu:2` keeps the plugin's 26 cores / 256G;
 *  - GPU-1A `-n 2 -c 13 --gres=gpu:2` → cpu=26, 2 GPUs (QoS cpu=26), so the
 *    share shrinks to fit the QoS on a single node;
 *  - `-c 52` alone and `--ntasks-per-node=2` without -N are refused
 *    (QOSMaxCpuPerJobLimit) because the plugin then fills in its task count.
 * A node's GPUs have no NVLink; inside a node they talk over PCIe, across
 * nodes over 25 Gb/s Ethernet. Packed layouts (fewer nodes) come first.
 */
import type { PartitionCap } from "@/lib/slurm";

export interface GpuNodeShape {
  /** physical GPUs per node */
  gpus: number;
  cores: number;
  memMb: number;
  /** nodes in the pool */
  count: number;
}

export interface GpuLayout {
  key: string;
  gpus: number;
  nodes: number;
  gpusPerNode: number;
  /** all of a node's GPUs on each node used — intra-node traffic stays on PCIe */
  packed: boolean;
  /** cores each GPU's task gets */
  coresPerGpu: number;
  flags: string[];
}

export interface GpuLayoutResult {
  layouts: GpuLayout[];
  /** Why a full node's GPUs can't be had in this partition, if they can't. */
  fullNodeBlocked?: "cores" | "memory" | "gpus";
}

const MAX_NODES_LISTED = 8;

export function gpuLayouts(cap: PartitionCap, shape: GpuNodeShape, multiNode: boolean): GpuLayoutResult {
  const one: GpuLayout = { key: "1", gpus: 1, nodes: 1, gpusPerNode: 1, packed: shape.gpus <= 1, coresPerGpu: 0, flags: [] };
  const layouts: GpuLayout[] = [one];
  if (shape.gpus < 1 || shape.cores < 1) return { layouts };
  const nodeShare = Math.max(1, Math.floor(shape.cores / shape.gpus));
  const capCores = cap.maxCores ?? Number.POSITIVE_INFINITY;
  const capGpus = cap.maxGpus ?? Number.POSITIVE_INFINITY;
  const maxNodes = Math.min(shape.count, cap.maxNodes ?? Number.POSITIVE_INFINITY, multiNode ? MAX_NODES_LISTED : 1);

  // Packed: every GPU of each node. On one node the per-GPU share shrinks to
  // fit the QoS core cap; across nodes each GPU keeps the node's full share.
  let fullNodeBlocked: GpuLayoutResult["fullNodeBlocked"];
  if (shape.gpus > 1) {
    for (let n = 1; n <= maxNodes; n++) {
      const gpus = n * shape.gpus;
      const share = n === 1 ? Math.min(nodeShare, Math.floor(capCores / shape.gpus)) : nodeShare;
      const blocked = gpus > capGpus ? "gpus" : share < 1 || n * shape.gpus * share > capCores ? "cores" : undefined;
      if (blocked) {
        if (n === 1) fullNodeBlocked = blocked;
        break;
      }
      const flags = n === 1
        ? [`-n ${shape.gpus}`, `-c ${share}`, `--gres=gpu:${shape.gpus}`]
        : [`-N ${n}`, `--ntasks-per-node=${shape.gpus}`, `-c ${share}`, `--gres=gpu:${shape.gpus}`];
      layouts.push({ key: `p${n}`, gpus, nodes: n, gpusPerNode: shape.gpus, packed: true, coresPerGpu: share, flags });
    }
  }

  // Spread: one GPU on each of n nodes with a GPU's share of cores. Slower
  // interconnect; listed after the packed options.
  for (let n = 2; n <= maxNodes; n++) {
    if (n * nodeShare > capCores || n > capGpus) break;
    layouts.push({
      key: `s${n}`, gpus: n, nodes: n, gpusPerNode: 1, packed: shape.gpus === 1, coresPerGpu: nodeShare,
      flags: [`-N ${n}`, "--ntasks-per-node=1", `-c ${nodeShare}`, "--gres=gpu:1"],
    });
  }
  layouts.sort((a, b) => a.gpus - b.gpus || a.nodes - b.nodes);
  return { layouts, fullNodeBlocked };
}

/** Most GPUs one job in this partition can actually get — the largest layout
 *  gpuLayouts() offers. The policy-limit line states this number, which
 *  keeps it equal to the biggest choice under 高级参数. */
export function maxJobGpus(cap: PartitionCap, shape: GpuNodeShape, multiNode: boolean): number {
  return Math.max(0, ...gpuLayouts(cap, shape, multiNode).layouts.map((l) => l.gpus));
}
