// Slurm-domain helpers: load tones, chart color mapping, resource filtering.
import type { Partition, PolicySnapshot, Pool, Release } from "@/types/snapshot";

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

/** Utilization 0..1 -> a status tone. */
export const utilTone = (u: number): Tone => (u >= 0.85 ? "bad" : u >= 0.6 ? "warn" : "ok");

/** tone -> tailwind classes (defined via Radix scales in tailwind.config.js). */
export const toneClass: Record<Tone, { text: string; bg: string; dot: string }> = {
  ok: { text: "text-ok-fg", bg: "bg-ok-soft", dot: "bg-ok" },
  warn: { text: "text-warn-fg", bg: "bg-warn-soft", dot: "bg-warn" },
  bad: { text: "text-bad-fg", bg: "bg-bad-soft", dot: "bg-bad" },
  info: { text: "text-info-fg", bg: "bg-info-soft", dot: "bg-info" },
  neutral: { text: "text-muted-foreground", bg: "bg-muted", dot: "bg-muted-foreground" },
};

// ---- resource filter: "all" or a hardware-pool id (cpu / vm-cpu / a40 / …) ----
export type ResourceFilter = "all" | string;

export const matchPool = (p: Pool, f: ResourceFilter) => f === "all" || p.id === f;
export const matchPartition = (p: Partition, f: ResourceFilter) => f === "all" || p.pool === f;
export const matchRelease = (r: Release, f: ResourceFilter) => f === "all" || r.pool === f;

/** Smooth green->amber->red ramp for the usage heatmap (0..1 -> rgba string). */
export function heatColor(v: number): string {
  const stops: [number, number, number][] = [
    [63, 185, 80],
    [210, 153, 34],
    [248, 81, 73],
  ];
  const x = Math.max(0, Math.min(1, v));
  const [a, b] = x < 0.5 ? [stops[0], stops[1]] : [stops[1], stops[2]];
  const f = x < 0.5 ? x * 2 : (x - 0.5) * 2;
  const c = a.map((n, i) => Math.round(n + (b[i] - n) * f));
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${0.18 + 0.62 * x})`;
}

// ---- per-partition policy caps ------------------------------------------------
// The snapshot's policy block is the single source of truth: the backend merges
// its built-in tables (backend/cluster_policy.py) with the live sacctmgr QoS
// collection, so the frontend never hardcodes cluster limits.
export interface PartitionCap {
  minCores?: number;
  maxCores?: number;
  maxMemGb?: number;
  minGpus?: number;
  maxGpus?: number;
  maxNodes?: number;
  wall?: string;
}

export interface PartitionPolicy {
  grpJobs?: number;
  maxJobsPerUser?: number;
  maxSubmitPerUser?: number;
}

// QOS memory caps are nominal hardware sizes, not requestable values —
// measured live: GPU-S MaxTRES mem=512G vs node RealMemory 515306MB (~503G),
// and `sbatch --mem=512G` fails instantly with "Requested node configuration
// is not available" while 502G schedules. The requestable ceiling is always
// min(policy, hardware).

/** Largest --mem (per node) a single node can actually grant. */
export function effectiveMemPerNodeGb(cap: PartitionCap, nodeMemMb?: number): number | undefined {
  const hw = nodeMemMb ? Math.floor(nodeMemMb / 1024) : undefined;
  if (hw && cap.maxMemGb) return Math.min(hw, cap.maxMemGb);
  return hw ?? cap.maxMemGb;
}

/** Job-total memory ceiling for the policy-limit line (spans maxNodes). */
export function effectiveJobMemGb(cap: PartitionCap, nodeMemMb?: number): number | undefined {
  if (!cap.maxMemGb) return undefined;
  const hw = nodeMemMb ? Math.floor(nodeMemMb / 1024) * (cap.maxNodes ?? 1) : undefined;
  return hw ? Math.min(cap.maxMemGb, hw) : cap.maxMemGb;
}

export const PARTITION_DISPLAY_ORDER = [
  "GPU-1",
  "GPU-S",
  "GPU-L",
  "GPU-1A",
  "GPU-LA",
  "VM-GPU-L",
  "DEF",
  "TINY",
  "SINGLE",
  "LONG",
  "SMALL",
  "LARGE",
  "XLARGE",
  "X2LARGE",
  "LONG-L",
  "MS_Castep",
  "MS_Dmol3",
  "MS_Forcite",
  "MS_Compass",
  "MS_Dftbplus",
  "MS_Amorphous",
  "MatStudio",
  "VM-CPU",
  "VM-LM",
  "i112",
];

const PARTITION_DISPLAY_RANK = new Map(PARTITION_DISPLAY_ORDER.map((name, i) => [name, i]));

export function partitionDisplayRank(name: string | null | undefined) {
  const rank = PARTITION_DISPLAY_RANK.get(String(name || "").split(",")[0]);
  return rank ?? PARTITION_DISPLAY_ORDER.length;
}

export const MATERIALS_STUDIO_PARTITIONS = [
  "MS_Castep",
  "MS_Dmol3",
  "MS_Forcite",
  "MS_Compass",
  "MS_Dftbplus",
  "MS_Amorphous",
  "MatStudio",
];

export const isMaterialsStudioPartition = (name: string) => MATERIALS_STUDIO_PARTITIONS.includes(name);

export const partitionCap = (name: string, policy?: PolicySnapshot): PartitionCap =>
  policy?.partition_caps?.[name] ?? {};

export const partitionPolicy = (name: string, policy?: PolicySnapshot): PartitionPolicy =>
  policy?.partition_policies?.[name] ?? {};

/** Hakusan's job_submit.lua overrides -t on every interactive (salloc) job —
 *  set, not capped — to a per-partition-class constant (measured live
 *  2026-07): GPU partitions → 720 min, CPU/VM/LM → 2880 min, TINY alone
 *  honors -t. Batch (sbatch) keeps its -t everywhere. */
export function interactiveForcedSec(partition: string, isGpu: boolean): number | null {
  if (partition === "TINY") return null;
  return (isGpu ? 720 : 2880) * 60;
}

/** Compact label for the forced interactive walltime. */
export function interactiveForcedLabel(partition: string, isGpu: boolean): string | null {
  const sec = interactiveForcedSec(partition, isGpu);
  if (sec === null) return null;
  return sec === 720 * 60 ? "12h" : "2d";
}
