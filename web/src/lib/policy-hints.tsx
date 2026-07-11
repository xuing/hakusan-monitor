// Shared partition-policy / CPU-probe presentation helpers.
// Single source for the Overview quick-request box AND the Partitions page —
// these two used to carry diverging copies (different limit formats, different
// user-limit chip layouts). Any policy hint shown to users must come from here.
import type { TFn } from "@/i18n";
import { cleanCpuProbeRaw, type CpuProbeRow, type CpuProbeState } from "@/lib/cpu-probes";
import { clockOf, nf } from "@/lib/format";
import { effectiveJobMemGb, interactiveForcedLabel, type PartitionCap, type PartitionPolicy, type Tone } from "@/lib/slurm";

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
  if (gb >= 1024) {
    const tb = gb / 1024;
    return `${Number.isInteger(tb) ? tb : tb.toFixed(1)}TB`;
  }
  return `${gb}GB`;
}

/** "8 GPU / 208c / 2TB / 4 nodes / 3d" — no label prefix, "" when the cap is empty.
 * Cores render as a range ("256–2,048c") where the QOS enforces a minimum
 * (submitting below it is rejected outright — measured on LARGE), and memory
 * is clamped to what the nodes can physically grant. */
export function fmtPolicyLimit(cap: PartitionCap, isGpu: boolean, t: TFn, partition?: string, nodeMemMb?: number) {
  const parts: string[] = [];
  if (isGpu && cap.maxGpus) parts.push(`${cap.maxGpus} GPU`);
  if (cap.maxCores) {
    parts.push(cap.minCores ? `${nf(cap.minCores)}–${nf(cap.maxCores)}c` : `${nf(cap.maxCores)}c`);
  }
  const memGb = effectiveJobMemGb(cap, nodeMemMb);
  if (memGb) parts.push(fmtCapMem(memGb));
  if (cap.maxNodes) parts.push(`${nf(cap.maxNodes)} ${t(cap.maxNodes === 1 ? "spec.nodeSingle" : "spec.nodes")}`);
  if (cap.wall) {
    // the QOS wall only binds sbatch; salloc gets a plugin-forced walltime —
    // showing "7d" alone reads as a promise interactive can't keep
    const forced = partition ? interactiveForcedLabel(partition, isGpu) : null;
    parts.push(forced && forced !== cap.wall
      ? t("pool.wallSplit", { wall: cap.wall, forced })
      : cap.wall);
  }
  return parts.join(" / ");
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
