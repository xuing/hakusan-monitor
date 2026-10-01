/**
 * The bounds of every quick-request field, in one place.
 *
 * The quick-request UI offers values only inside these bounds, and the daily
 * verification (scripts/check_cluster_policy.py, via boundaryCommands) submits
 * the largest of each as a held job to prove Slurm can actually run it. Both
 * read this module, so the check tests exactly what users are offered.
 *
 * Each bound is the tightest of the QoS cap and what one node / the pool can
 * physically hold — the looser bounds were measured to produce jobs Slurm
 * accepts and then never starts (2026-10-01).
 */
import { buildRequestCommand } from "@/lib/request-command";
import { gpuLayouts, type GpuNodeShape } from "@/lib/gpu-layout";
import { allowsMultiNode, effectiveMemPerNodeGb, partitionCap, partitionDefaults, type PartitionCap } from "@/lib/slurm";
import type { PolicySnapshot, Snapshot } from "@/types/snapshot";

export interface PoolShape {
  /** nodes in the partition */
  nodes: number;
  coresPerNode: number;
  memPerNodeMb: number;
  /** physical GPUs per node (0 for CPU pools) */
  gpusPerNode: number;
}

export interface RequestLimits {
  cap: PartitionCap;
  multiNode: boolean;
  minCores?: number;
  maxCores?: number;
  /** largest --mem per node (GiB) that fits one node's memory AND cores */
  maxMemGb?: number;
  /** largest -N; 0 = the node field is not offered (single-node partitions,
   *  GPU pools — they pick nodes through the GPU layout) */
  maxNodes: number;
  wall?: string;
}

/** `coreCount`: the -n the user already chose (tasks must cover the nodes). */
export function requestLimits(partition: string, policy: PolicySnapshot | undefined, shape: PoolShape,
                              isGpu: boolean, coreCount = 0): RequestLimits {
  const cap = partitionCap(partition, policy);
  const multiNode = allowsMultiNode(cap, shape.coresPerNode || undefined);
  const tasks = coreCount || partitionDefaults(partition, policy).tasks || Number.POSITIVE_INFINITY;
  // measured: `-p GPU-L -N 27` is accepted on a 20-node pool and never starts
  const nodes = isGpu || !multiNode ? 0 : Math.min(
    cap.maxNodes ?? Number.POSITIVE_INFINITY,
    shape.nodes || Number.POSITIVE_INFINITY,
    cap.maxCores ?? Number.POSITIVE_INFINITY,
    tasks,
  );
  return {
    cap,
    multiNode,
    minCores: cap.minCores,
    maxCores: cap.maxCores,
    maxMemGb: effectiveMemPerNodeGb(cap, shape.memPerNodeMb, shape.coresPerNode || undefined),
    maxNodes: Number.isFinite(nodes) ? nodes : 0,
    wall: cap.wall,
  };
}

export interface BoundaryCommand {
  partition: string;
  /** "cores" | "mem" | "nodes" | "time" | "gpu:<layout key>" */
  field: string;
  value: string;
  /** sbatch arguments, exactly as the UI builds them (without the script) */
  args: string;
  /** what the check compares Slurm's answer against */
  expect: {
    maxCores?: number;
    maxGpus?: number;
    partitionNodes: number;
    coresPerNode: number;
    memPerNodeMb: number;
    gpusPerNode: number;
    /** GPUs the layout promises (GPU layouts only) */
    gpus?: number;
    /** whole nodes via --exclusive: CPUs are counted at allocation */
    exclusive?: boolean;
  };
}

/** Slurm -t spelling for a QoS wall like "7d" / "12h" / "30m". */
function wallToSlurm(wall: string): string {
  const m = wall.match(/^(\d+)([dhm])$/);
  if (!m) return wall;
  const n = Number(m[1]);
  return m[2] === "d" ? `${n}-00:00:00` : m[2] === "h" ? `${n}:00:00` : `${n}:00`;
}

/** The largest value of every field the quick request offers, for every
 *  partition the UI shows, as the exact sbatch arguments it would emit. */
export function boundaryCommands(snap: Snapshot): BoundaryCommand[] {
  const out: BoundaryCommand[] = [];
  for (const pool of snap.pools) {
    if (pool.gpu?.maint) continue;
    const isGpu = pool.kind === "gpu";
    const coresPerNode = pool.nodes ? Math.floor(pool.cores.total / pool.nodes) : 0;
    for (const p of pool.partitions) {
      const part = snap.partitions.find((x) => x.name === p);
      if (!part) continue;
      const defaults = partitionDefaults(p, snap.policy);
      if (defaults.requires_license) continue; // sbatch refuses without -L
      const shape: PoolShape = { nodes: part.nodes, coresPerNode, memPerNodeMb: pool.mem_per_node, gpusPerNode: part.spec.gpu_per_node };
      const lim = requestLimits(p, snap.policy, shape, isGpu);
      const expect = {
        maxCores: lim.cap.maxCores, maxGpus: lim.cap.maxGpus, partitionNodes: part.nodes,
        coresPerNode, memPerNodeMb: pool.mem_per_node, gpusPerNode: part.spec.gpu_per_node,
      };
      const base = { partition: p, forcedInteractiveSeconds: null, mode: "script" as const, pty: false,
                     ptyTime: "", scriptFile: "job.sh", multiNode: lim.multiNode };
      const add = (field: string, value: string, extra: Partial<Parameters<typeof buildRequestCommand>[0]>) => out.push({
        partition: p, field, value, expect,
        args: buildRequestCommand({ ...base, ...extra }).replace(/^sbatch /, "").replace(/ job\.sh$/, ""),
      });
      if (lim.maxCores) add("cores", String(lim.maxCores), { coreCount: lim.maxCores });
      if (lim.maxMemGb) add("mem", `${lim.maxMemGb}G`, { memValue: `${lim.maxMemGb}G` });
      if (lim.maxNodes > 1) add("nodes", String(lim.maxNodes), { nodeCount: lim.maxNodes });
      if (lim.wall) add("time", lim.wall, { timeValue: wallToSlurm(lim.wall) });
      if (isGpu && part.spec.gpu_per_node > 0) {
        const gshape: GpuNodeShape = { gpus: part.spec.gpu_per_node, cores: coresPerNode, memMb: pool.mem_per_node, count: part.nodes };
        const { layouts } = gpuLayouts(lim.cap, {
          gpusPerNode: defaults.gpus_per_node, gpuRequestRespected: defaults.gpu_request_respected, defaultCores: defaults.cores,
        }, gshape, lim.multiNode);
        for (const l of layouts.filter((x) => x.gpus > 1)) {
          out.push({
            partition: p, field: `gpu:${l.key}`, value: String(l.gpus), args: `-p ${p} ${l.flags.join(" ")}`,
            expect: { ...expect, gpus: l.gpus, exclusive: l.exclusive },
          });
        }
      }
    }
  }
  return out;
}
