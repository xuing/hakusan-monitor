// Shared partition-policy / CPU-probe presentation helpers.
// Single source for the Overview quick-request box AND the Partitions page —
// these two used to carry diverging copies (different limit formats, different
// user-limit chip layouts). Any policy hint shown to users must come from here.
import type { TFn } from "@/i18n";
import { cleanCpuProbeRaw, type CpuProbeRow, type CpuProbeState } from "@/lib/cpu-probes";
import { clockOf, nf } from "@/lib/format";
import { maxJobGpus, type GpuNodeShape } from "@/lib/gpu-layout";
import { allowsMultiNode, effectiveGpuLimit, effectiveJobMemGb, interactiveForcedLabel, type PartitionCap, type PartitionPolicy, type Tone } from "@/lib/slurm";
import type { PolicySnapshot } from "@/types/snapshot";

export interface PolicyLimitRow {
  key: string;
  label: string;
  reached: boolean;
  near: boolean;
}

export function limitLevel(current: number, max: number) {
  return {
    reached: current >= max,
    near: max > 1 && current >= Math.ceil(max * 0.8),
  };
}

export function policyLimitRows(policy: PartitionPolicy, groupRunning: number, t: TFn): PolicyLimitRow[] {
  const rows: PolicyLimitRow[] = [];
  if (policy.grpJobs) {
    rows.push({
      key: "grp",
      label: t("pool.limitGroup", { n: groupRunning, max: policy.grpJobs }),
      ...limitLevel(groupRunning, policy.grpJobs),
    });
  }
  if (policy.maxJobsPerUser && policy.maxSubmitPerUser) {
    rows.push({
      key: "user",
      label: t("pool.limitUserBoth", { running: policy.maxJobsPerUser, submitted: policy.maxSubmitPerUser }),
      reached: false,
      near: false,
    });
  } else if (policy.maxJobsPerUser) {
    rows.push({
      key: "userRun",
      label: t("pool.limitUserRunning", { max: policy.maxJobsPerUser }),
      reached: false,
      near: false,
    });
  } else if (policy.maxSubmitPerUser) {
    rows.push({
      key: "userSubmit",
      label: t("pool.limitUserSubmitted", { max: policy.maxSubmitPerUser }),
      reached: false,
      near: false,
    });
  }
  return rows;
}

export function fmtCapMem(gb?: number) {
  if (!gb) return "";
  // Exact, never rounded up: a limit of 1500 GiB once read "1.5TiB"
  // (= 1536 GiB, more than Slurm grants). Whole TiB stay compact.
  if (gb >= 1024 && gb % 1024 === 0) return `${gb / 1024}TiB`;
  // QoS MaxTRES mem=256G is binary (GiB), same unit as --mem=256G
  return `${nf(gb)}GiB`;
}

/** "8 GPU / 208c / 2TiB / 4 nodes / 3d" — no label prefix, "" when the cap is empty.
 * Cores render as a range ("256–2,048c") where the QOS enforces a minimum
 * (submitting below it is rejected outright — measured on LARGE), and memory
 * is clamped to what the nodes can physically grant. The GPU term is the
 * count a job really gets: where the submit plugin pins GPUs per node the
 * line says so, and a partition with neither a QoS GPU cap nor a plugin rule
 * gets no GPU term at all rather than an invented one. */
export function fmtPolicyLimit(cap: PartitionCap, isGpu: boolean, t: TFn, partition?: string, nodeMemMb?: number,
                               policy?: PolicySnapshot, shape?: GpuNodeShape, nodeCores?: number) {
  const parts: string[] = [];
  if (isGpu) {
    const gpu = fmtGpuLimit(cap, shape);
    if (gpu) parts.push(gpu);
  }
  if (cap.maxCores) {
    parts.push(cap.minCores ? `${nf(cap.minCores)}–${nf(cap.maxCores)}c` : `${nf(cap.maxCores)}c`);
  }
  const memGb = effectiveJobMemGb(cap, nodeMemMb, nodeCores ?? shape?.cores);
  if (memGb) parts.push(fmtCapMem(memGb));
  if (cap.maxNodes) parts.push(`${nf(cap.maxNodes)} ${t(cap.maxNodes === 1 ? "spec.nodeSingle" : "spec.nodes")}`);
  if (cap.wall) {
    // the QOS wall only binds sbatch; salloc gets a plugin-forced walltime —
    // showing "7d" alone reads as a promise interactive can't keep
    const forced = partition ? interactiveForcedLabel(partition, policy) : null;
    parts.push(forced && forced !== cap.wall
      ? t("pool.wallSplit", { wall: cap.wall, forced })
      : cap.wall);
  }
  return parts.join(" / ");
}

/** The GPU term of the policy line, "" when nothing can be stated. With the
 *  node shape known it is the most GPUs a job can really get (maxJobGpus);
 *  without it, the QoS gres cap. */
export function fmtGpuLimit(cap: PartitionCap, shape?: GpuNodeShape) {
  if (shape && shape.gpus > 0) {
    const n = maxJobGpus(cap, shape, allowsMultiNode(cap, shape.cores));
    return n > 0 ? `${n} GPU` : "";
  }
  const { total } = effectiveGpuLimit(cap);
  return total ? `${total} GPU` : "";
}

export function cpuProbeLabel(state: CpuProbeState, t: TFn) {
  if (state === "now") return t("pool.cpuProbeNow");
  if (state === "queued") return t("pool.cpuProbeQueued");
  if (state === "unknown") return t("pool.cpuProbeNoData");
  return t("pool.cpuProbeFailed");
}

export function cpuProbeTone(state: CpuProbeState): Tone {
  if (state === "now") return "ok";
  if (state === "queued") return "warn";
  if (state === "unknown") return "neutral";
  return "bad";
}

export function cpuProbeDetail(row: CpuProbeRow, state: CpuProbeState | null, t: TFn) {
  const probe = row.probe;
  if (!probe) return t("pool.cpuProbeNoData");
  if (state === "now") return probe.nodes ? t("pool.cpuProbeNodes", { nodes: probe.nodes }) : "";
  if (state === "queued" && probe.start_time) return t("pool.cpuProbeStart", { time: clockOf(probe.start_time) });
  return truncateProbeRaw(cleanCpuProbeRaw(probe.raw));
}

export function truncateProbeRaw(text: string) {
  if (!text) return "";
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
