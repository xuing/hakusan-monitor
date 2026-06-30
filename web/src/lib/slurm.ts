// Slurm-domain helpers: load tones, chart color mapping, resource filtering.
import type { Partition, PolicySnapshot, Pool, PressureLevel, Release } from "@/types/snapshot";

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

/** Utilization 0..1 -> a status tone. */
export const utilTone = (u: number): Tone => (u >= 0.85 ? "bad" : u >= 0.6 ? "warn" : "ok");

export const levelTone: Record<PressureLevel, Tone> = {
  low: "ok",
  moderate: "warn",
  high: "bad",
  critical: "bad",
};

/** tone -> Tremor chart color name. */
export const toneTremor: Record<Tone, string> = {
  ok: "emerald",
  warn: "amber",
  bad: "rose",
  info: "blue",
  neutral: "slate",
};

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

// ---- per-partition policy caps (single source of truth) ----------------------
// Published Hakusan partition limits. Used by the Partitions page and the
// per-pool "quick request" builder so a generated command never exceeds policy.
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

export const PARTITION_CAPS: Record<string, PartitionCap> = {
  DEF: { maxCores: 64, maxMemGb: 384, maxNodes: 1, wall: "7d" },
  TINY: { maxCores: 16, maxMemGb: 96, maxNodes: 1, wall: "30m" },
  SINGLE: { maxCores: 256, maxMemGb: 1536, maxNodes: 1, wall: "7d" },
  LONG: { maxCores: 256, maxMemGb: 1536, maxNodes: 1, wall: "21d" },
  SMALL: { maxCores: 768, maxMemGb: 4608, maxNodes: 3, wall: "7d" },
  LARGE: { minCores: 256, maxCores: 2048, maxMemGb: 12288, maxNodes: 8, wall: "7d" },
  XLARGE: { minCores: 256, maxCores: 4096, maxMemGb: 24576, maxNodes: 16, wall: "5d" },
  X2LARGE: { minCores: 256, maxCores: 8192, maxMemGb: 49152, maxNodes: 32, wall: "5d" },
  "LONG-L": { minCores: 256, maxCores: 768, maxMemGb: 4608, maxNodes: 3, wall: "14d" },
  MS_Castep: { maxCores: 32, maxMemGb: 192, maxNodes: 1, wall: "7d" },
  MS_Dmol3: { maxCores: 128, maxMemGb: 768, maxNodes: 1, wall: "7d" },
  MS_Forcite: { maxCores: 64, maxMemGb: 384, maxNodes: 1, wall: "7d" },
  MS_Compass: { maxCores: 64, maxMemGb: 384, maxNodes: 1, wall: "7d" },
  MS_Dftbplus: { maxCores: 32, maxMemGb: 192, maxNodes: 1, wall: "7d" },
  MS_Amorphous: { maxCores: 32, maxMemGb: 192, maxNodes: 1, wall: "7d" },
  MatStudio: { maxCores: 32, maxMemGb: 192, maxNodes: 1, wall: "7d" },
  "GPU-1": { maxGpus: 1, maxCores: 26, maxMemGb: 256, maxNodes: 1, wall: "7d" },
  "GPU-S": { maxGpus: 2, maxCores: 52, maxMemGb: 512, maxNodes: 1, wall: "5d" },
  "GPU-L": { maxGpus: 8, maxCores: 208, maxMemGb: 2048, maxNodes: 4, wall: "3d" },
  "GPU-1A": { maxGpus: 1, maxCores: 26, maxMemGb: 256, maxNodes: 1, wall: "7d" },
  "GPU-LA": { maxGpus: 8, maxCores: 208, maxMemGb: 2048, maxNodes: 4, wall: "3d" },
  "VM-CPU": { maxCores: 32, maxMemGb: 480, maxNodes: 1, wall: "7d" },
  "VM-GPU-L": { maxGpus: 1, maxCores: 32, maxMemGb: 480, maxNodes: 1, wall: "2d" },
  "VM-LM": { maxCores: 96, maxMemGb: 3840, maxNodes: 1, wall: "7d" },
};

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

export const partitionCap = (name: string, policy?: PolicySnapshot): PartitionCap => ({
  ...(PARTITION_CAPS[name] ?? {}),
  ...(policy?.partition_caps?.[name] ?? {}),
});

export const PARTITION_POLICIES: Record<string, PartitionPolicy> = {
  DEF: { maxJobsPerUser: 300, maxSubmitPerUser: 40 },
  TINY: { maxJobsPerUser: 5 },
  SINGLE: { grpJobs: 100, maxJobsPerUser: 10, maxSubmitPerUser: 40 },
  SMALL: { grpJobs: 30, maxJobsPerUser: 4, maxSubmitPerUser: 30 },
  LARGE: { grpJobs: 10, maxJobsPerUser: 2, maxSubmitPerUser: 15 },
  XLARGE: { grpJobs: 4, maxJobsPerUser: 1, maxSubmitPerUser: 7 },
  X2LARGE: { grpJobs: 2, maxJobsPerUser: 1, maxSubmitPerUser: 7 },
  LONG: { grpJobs: 15, maxJobsPerUser: 1, maxSubmitPerUser: 15 },
  "LONG-L": { grpJobs: 5, maxJobsPerUser: 1, maxSubmitPerUser: 10 },
  "GPU-1": { grpJobs: 30, maxJobsPerUser: 4, maxSubmitPerUser: 30 },
  "GPU-S": { grpJobs: 10, maxJobsPerUser: 2, maxSubmitPerUser: 15 },
  "GPU-L": { grpJobs: 3, maxJobsPerUser: 1, maxSubmitPerUser: 5 },
  "GPU-1A": { grpJobs: 20, maxJobsPerUser: 2, maxSubmitPerUser: 20 },
  "GPU-LA": { grpJobs: 2, maxJobsPerUser: 1, maxSubmitPerUser: 5 },
  "VM-CPU": { maxJobsPerUser: 1, maxSubmitPerUser: 10 },
  "VM-GPU-L": { maxJobsPerUser: 1, maxSubmitPerUser: 3 },
  "VM-LM": { maxJobsPerUser: 1, maxSubmitPerUser: 60 },
  MS_Forcite: { grpJobs: 1 },
  MS_Compass: { grpJobs: 1 },
  MS_Dftbplus: { grpJobs: 1 },
  MS_Amorphous: { grpJobs: 1 },
};

export const partitionPolicy = (name: string, policy?: PolicySnapshot): PartitionPolicy => ({
  ...(PARTITION_POLICIES[name] ?? {}),
  ...(policy?.partition_policies?.[name] ?? {}),
});
