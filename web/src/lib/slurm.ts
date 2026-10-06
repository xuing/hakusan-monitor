// Slurm-domain helpers: partition policy (caps, defaults, walltimes), tones, resource filtering.
import type { GpuDefaultRequest } from "@/lib/gpu-availability";
import type { Partition, PartitionDefaults, PolicySnapshot, Pool, Release } from "@/types/snapshot";

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

// ---- per-partition policy caps ------------------------------------------------
// The snapshot's policy block is the single source of truth: caps and
// concurrency come from the live sacctmgr QoS, request defaults from the
// cluster's job_submit.lua (backend/lua_policy.py) and `scontrol show
// partition`. The frontend never hardcodes a cluster limit — a value the
// cluster doesn't state is absent here and shown as absent.
export interface PartitionCap {
  minCores?: number;
  maxCores?: number;
  maxMemGb?: number;
  minGpus?: number;
  maxGpus?: number;
  maxNodes?: number;
  wall?: string;
  /** Partition MaxMemPerCPU (MB). Slurm meets a --mem above cores x this by
   *  raising the CPU count, and the raised count is checked against maxCores
   *  only at scheduling time — the job then pends forever. */
  maxMemPerCpuMb?: number;
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
export function effectiveMemPerNodeGb(cap: PartitionCap, nodeMemMb?: number, nodeCores?: number): number | undefined {
  const limits = [hw(nodeMemMb), cap.maxMemGb, cpuBoundMemGb(cap), nodeCpuBoundMemGb(cap, nodeCores)]
    .filter((v): v is number => !!v);
  return limits.length ? Math.min(...limits) : undefined;
}

const hw = (nodeMemMb?: number) => (nodeMemMb ? Math.floor(nodeMemMb / 1024) : undefined);

/** Per-node memory one node's cores can carry: Slurm meets --mem above
 *  cores x MaxMemPerCPU by adding CPUs, and a node has only so many.
 *  Measured 2026-10-01: GPU-L --mem=503G -> 78 CPUs on a 52-core node (never
 *  starts); --mem=499G -> 52 CPUs. SMALL --mem=1507G spills onto a second
 *  256-core node; 1500G stays on one. */
function nodeCpuBoundMemGb(cap: PartitionCap, nodeCores?: number): number | undefined {
  if (!nodeCores || !cap.maxMemPerCpuMb) return undefined;
  return Math.floor((nodeCores * cap.maxMemPerCpuMb) / 1024);
}

/** Job-total memory ceiling for the policy-limit line (spans maxNodes).
 *  Without a node limit the job may span as many nodes as it likes, so only
 *  the QoS total binds. */
export function effectiveJobMemGb(cap: PartitionCap, nodeMemMb?: number, nodeCores?: number): number | undefined {
  if (!cap.maxMemGb) return undefined;
  const perNode = [hw(nodeMemMb), nodeCpuBoundMemGb(cap, nodeCores)].filter((v): v is number => !!v);
  const nodes = cap.maxNodes && perNode.length ? Math.min(...perNode) * cap.maxNodes : undefined;
  const limits = [cap.maxMemGb, nodes, cpuBoundMemGb(cap)].filter((v): v is number => !!v);
  return Math.min(...limits);
}

/** Can a job in this partition span nodes? An absent maxNodes means the QoS
 *  sets no node limit (SMALL: cpu=768,mem=4.50T — a 512-core job ran on 20
 *  nodes), NOT "one node". Without a node limit, a core cap that fits on one
 *  node (VM-CPU: 32 cores on 32-core nodes) still keeps jobs single-node. */
export function allowsMultiNode(cap: PartitionCap, coresPerNode?: number): boolean {
  if (cap.maxNodes) return cap.maxNodes > 1;
  if (!cap.maxCores || !coresPerNode) return true;
  return cap.maxCores > coresPerNode;
}

/** Every node of the partition is down or drained: it is in maintenance. */
export function partitionDown(p: Partition): boolean {
  const down = (p.nodes_state.down ?? 0) + (p.nodes_state.drain ?? 0);
  return p.nodes > 0 && down >= p.nodes;
}

/** Partitions that take only license jobs (`-L`): the submit plugin rejects a
 *  job without one, or fills in a default license. On Hakusan these are the
 *  Materials Studio partitions. */
export function isLicensePartition(name: string, policy?: PolicySnapshot | null): boolean {
  const d = policy?.partition_defaults?.[name];
  return Boolean(d?.requires_license || d?.default_license);
}

export const partitionCap = (name: string, policy?: PolicySnapshot): PartitionCap => {
  const cap = policy?.partition_caps?.[name] ?? {};
  const maxMemPerCpuMb = policy?.partition_defaults?.[name]?.max_mem_per_cpu_mb;
  return maxMemPerCpuMb ? { ...cap, maxMemPerCpuMb } : cap;
};

/** Memory (GiB) beyond which Slurm must add CPUs past the QoS core cap:
 *  maxCores x MaxMemPerCPU. Measured 2026-10-01: GPU-1 (26 x 9845 MB)
 *  --mem=249G -> 26 CPUs and runs; --mem=250G -> 52 CPUs, pends on
 *  QOSMaxCpuPerJobLimit forever. */
function cpuBoundMemGb(cap: PartitionCap): number | undefined {
  if (!cap.maxCores || !cap.maxMemPerCpuMb) return undefined;
  return Math.floor((cap.maxCores * cap.maxMemPerCpuMb) / 1024);
}

/** QoS ceiling expressed per GPU, for narrowing the per-GPU need. Slurm quotes
 *  MaxTRES memory in binary GB (mem=256G = 256 GiB), so scale by 1024.
 *  `gpus` is how many GPUs one job can really hold; it
 *  defaults to the QoS gres cap, and to 1 when neither is known — then the
 *  cap is not divided, i.e. it never pretends to be stricter than stated. */
export function capPerGpu(cap: PartitionCap, gpus: number | undefined = cap.maxGpus): { cores?: number; memMb?: number } {
  const maxGpus = Math.max(1, gpus ?? 1);
  return {
    cores: cap.maxCores ? Math.ceil(cap.maxCores / maxGpus) : undefined,
    memMb: cap.maxMemGb ? Math.ceil((cap.maxMemGb * 1024) / maxGpus) : undefined,
  };
}

/**
 * What `salloc -p NAME` (no resource flags) actually asks Slurm for.
 *
 * Distinct from `partitionCap`, which is the QoS ceiling — the two differ by
 * enough to invert a verdict: VM-GPU-L defaults to 32 x 14900 MB = 476800 MB
 * while its cap reads mem=480G. Values come from the snapshot's measured
 * `partition_defaults`; the fallbacks only keep an old snapshot from producing
 * a zero-memory request.
 */
export function partitionDefaultRequest(name: string, policy?: PolicySnapshot): GpuDefaultRequest {
  const d = policy?.partition_defaults?.[name] ?? {};
  // Zeroes mean "unknown" — gpuPerGpuNeed then falls back to the node's own
  // per-GPU hardware share (and to one GPU) instead of inventing a request.
  return {
    partition: name,
    cores: d.cores ?? 0,
    memPerCoreMb: d.def_mem_per_cpu_mb ?? 0,
    gpusPerNode: d.gpus_per_node ?? 0,
  };
}

export const partitionDefaults = (name: string, policy?: PolicySnapshot): PartitionDefaults =>
  policy?.partition_defaults?.[name] ?? {};

export const partitionPolicy = (name: string, policy?: PolicySnapshot): PartitionPolicy =>
  policy?.partition_policies?.[name] ?? {};

/** Hakusan's job_submit.lua overrides -t on every interactive (salloc/srun)
 *  job — set, not capped — to a per-partition constant read from the Lua
 *  (`partition_defaults[p].interactive_time_min`). A partition without that
 *  rule (absent field) honours -t. Batch (sbatch) keeps its -t everywhere.
 *  Unknown policy (mock mode, cold cache) reads as "not forced" rather than
 *  falling back to a remembered number. */
export function interactiveForcedSec(partition: string, policy?: PolicySnapshot): number | null {
  const min = policy?.partition_defaults?.[partition]?.interactive_time_min;
  return min && min > 0 ? min * 60 : null;
}

/** Compact label for the forced interactive walltime ("12h", "2d"). */
export function interactiveForcedLabel(partition: string, policy?: PolicySnapshot): string | null {
  const sec = interactiveForcedSec(partition, policy);
  return sec === null ? null : fmtWallMinutes(sec / 60);
}

/** Minutes -> the compact walltime label used across the UI: whole days as
 *  "2d", whole hours as "12h", otherwise "1h30m" / "45m". */
export function fmtWallMinutes(min: number): string {
  if (min <= 0) return "0m";
  if (min % 1440 === 0) return `${min / 1440}d`;
  if (min % 60 === 0) return `${min / 60}h`;
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h${min % 60}m`;
}

/** Minutes -> a Slurm -t value ("12:00:00", "2-00:00:00"). */
export function minutesToSlurmTime(min: number): string {
  const days = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  const hm = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
  return days > 0 ? `${days}-${hm}` : hm;
}

/** QoS MaxWall label ("7d", "30m") -> seconds; 0 when absent/unparseable. */
export function wallLabelSec(wall: string | undefined): number {
  if (!wall) return 0;
  const m = wall.match(/^(\d+)([mhd])$/);
  if (!m) return 0;
  const n = Number(m[1]);
  return n * (m[2] === "d" ? 86400 : m[2] === "h" ? 3600 : 60);
}

/** How long a flagless request in this partition will hold its slot: the
 *  plugin-forced interactive walltime where there is one, else the QoS wall
 *  (a job without -t runs up to it), else unbounded. Used to judge whether a
 *  free GPU slot / backfill gap is long enough for the default request. */
export function defaultRequestSec(partition: string, policy?: PolicySnapshot): number {
  return interactiveForcedSec(partition, policy)
    ?? (wallLabelSec(policy?.partition_caps?.[partition]?.wall) || Number.POSITIVE_INFINITY);
}
