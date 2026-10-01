/**
 * Which multi-GPU requests a partition can actually grant, and the flags for
 * each — derived from the cluster's own policy, never from constants.
 *
 * Inputs are the QoS cap (sacctmgr), the submit plugin's per-partition facts
 * (job_submit.lua via policy.partition_defaults) and the node shape (scontrol).
 * Every layout returned here passes the checks Slurm would apply: total cores,
 * memory and GPUs within the QoS, node count within the pool. A layout Slurm
 * would refuse — or accept and then leave pending forever — is not offered.
 *
 * Two facts shape the options today (verified 2026-10-01):
 *  - the plugin overwrites any GPU count with 1 per node
 *    (gpu_request_respected === false), so the only way to both GPUs of a node
 *    is `--exclusive` — which also books the node's cores and memory, so the
 *    QoS must allow a whole node;
 *  - a node's GPUs have no NVLink; inside a node they talk over PCIe, across
 *    nodes over 25 Gb/s Ethernet. Packed layouts (fewer nodes) come first.
 * When the plugin is fixed, `gpu_request_respected` flips and the same code
 * emits `--gres=gpu:N` instead of `--exclusive`, with no tip about it.
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

export interface GpuLayoutFacts {
  /** GPUs the plugin sets per node when it decides none were requested */
  gpusPerNode?: number;
  /** false: the plugin overwrites every GPU request with gpusPerNode */
  gpuRequestRespected?: boolean;
  /** CPUs a request without -n/-c gets (the plugin's default) */
  defaultCores?: number;
}

export interface GpuLayout {
  key: string;
  gpus: number;
  nodes: number;
  gpusPerNode: number;
  /** all of a node's GPUs on each node used — intra-node traffic stays on PCIe */
  packed: boolean;
  /** whole nodes via --exclusive (the plugin workaround) */
  exclusive: boolean;
  flags: string[];
}

export interface GpuLayoutResult {
  layouts: GpuLayout[];
  /** Why a full node's GPUs can't be had in this partition, if they can't. */
  fullNodeBlocked?: "cores" | "memory" | "gpus";
}

const MAX_NODES_LISTED = 8;

export function gpuLayouts(cap: PartitionCap, facts: GpuLayoutFacts, shape: GpuNodeShape,
                           multiNode: boolean): GpuLayoutResult {
  const one: GpuLayout = { key: "1", gpus: 1, nodes: 1, gpusPerNode: 1, packed: shape.gpus <= 1, exclusive: false, flags: [] };
  const layouts: GpuLayout[] = [one];
  if (shape.gpus < 1 || shape.cores < 1) return { layouts };
  const respected = facts.gpuRequestRespected !== false;
  const forcedPerNode = Math.max(1, facts.gpusPerNode ?? 1);
  const coresPerGpu = Math.max(1, Math.floor(shape.cores / shape.gpus));
  const capCores = cap.maxCores ?? Number.POSITIVE_INFINITY;
  const capGpus = cap.maxGpus ?? Number.POSITIVE_INFINITY;
  const capMemMb = cap.maxMemGb ? cap.maxMemGb * 1024 : Number.POSITIVE_INFINITY;
  const maxNodes = Math.min(shape.count, cap.maxNodes ?? Number.POSITIVE_INFINITY, multiNode ? MAX_NODES_LISTED : 1);

  // Packed: every GPU of each node. Without a working GPU request that means
  // --exclusive, which books the whole node's cores and memory.
  // A single node with a working --gres keeps the default CPU count; across
  // nodes we pin one task per GPU with a per-GPU share of cores.
  const packedCost = (n: number) => !respected
    ? { cores: n * shape.cores, memMb: n * shape.memMb }
    : n === 1
      ? { cores: facts.defaultCores ?? coresPerGpu, memMb: 0 }
      : { cores: n * coresPerGpu * shape.gpus, memMb: 0 };
  let fullNodeBlocked: GpuLayoutResult["fullNodeBlocked"];
  if (shape.gpus > 1) {
    for (let n = 1; n <= maxNodes; n++) {
      const cost = packedCost(n);
      const gpus = n * shape.gpus;
      const blocked = cost.cores > capCores ? "cores" : cost.memMb > capMemMb ? "memory" : gpus > capGpus ? "gpus" : undefined;
      if (blocked) {
        if (n === 1) fullNodeBlocked = blocked;
        break;
      }
      const flags = respected
        ? [...(n > 1 ? [`-N ${n}`, `--ntasks-per-node=${shape.gpus}`, `-c ${coresPerGpu}`] : []), `--gres=gpu:${shape.gpus}`]
        : [...(n > 1 ? [`-N ${n}`] : []), "--exclusive"];
      layouts.push({ key: `p${n}`, gpus, nodes: n, gpusPerNode: shape.gpus, packed: true, exclusive: !respected, flags });
    }
  }

  // Spread: one GPU (the plugin's per-node count) on each of n nodes, half a
  // node of cores each. Slower interconnect; listed after the packed options.
  const spreadPer = respected ? 1 : forcedPerNode;
  for (let n = 2; n <= maxNodes; n++) {
    const gpus = n * spreadPer;
    if (n * coresPerGpu > capCores || gpus > capGpus) break;
    layouts.push({
      key: `s${n}`, gpus, nodes: n, gpusPerNode: spreadPer, packed: spreadPer === shape.gpus, exclusive: false,
      flags: [`-N ${n}`, "--ntasks-per-node=1", `-c ${coresPerGpu}`],
    });
  }
  layouts.sort((a, b) => a.gpus - b.gpus || a.nodes - b.nodes);
  return { layouts, fullNodeBlocked };
}

/** Most GPUs one job in this partition can actually get — the largest layout
 *  gpuLayouts() offers (so with the plugin pinning 1/node, GPU-S is 2 via
 *  --exclusive, GPU-1 is 1). The policy-limit line states this number, which
 *  keeps it equal to the biggest choice under 高级参数. */
export function maxJobGpus(cap: PartitionCap, facts: GpuLayoutFacts, shape: GpuNodeShape,
                           multiNode: boolean): number {
  return Math.max(0, ...gpuLayouts(cap, facts, shape, multiNode).layouts.map((l) => l.gpus));
}
