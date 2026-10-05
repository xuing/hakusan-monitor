import { nodeIsSchedulable } from "@/lib/derive";
import { partitionRunningJobs } from "@/lib/gpu-advice";
import { isLimitBlocked } from "@/lib/gpu-fit";
import type { CpuSubmitProbe, Pool, Snapshot } from "@/types/snapshot";

export type CpuProbeState = "now" | "queued" | "failed" | "unknown";

export interface CpuProbeRow {
  partition: string;
  probe: CpuSubmitProbe | null;
  cores: number;
  command: string;
  /** what the UI states: live judgement, or the probe's rejection */
  state: CpuProbeState;
}

/** Probe rows for the partitions of one pool, in the backend's test order.
 * The backend (sources.CPU_TEST_PARTITIONS) decides which partitions get
 * probed — no second copy of that list lives here. */
export function cpuProbeRows(pool: Pool, snap: Snapshot): CpuProbeRow[] {
  return (snap.cpu_submit_probes ?? [])
    .filter((probe) => pool.partitions.includes(probe.partition))
    .map((probe) => cpuProbeRow(probe.partition, probe, snap));
}

export function cpuProbeRow(partition: string, probe: CpuSubmitProbe | null, snap: Snapshot): CpuProbeRow {
  const base = { partition, probe, cores: probe?.processors || 0, command: `salloc -p ${partition}` };
  return { ...base, state: cpuStartState(base, snap) };
}

export function cpuProbeForPartition(snap: Snapshot, partition: string): CpuProbeRow | null {
  const probe = (snap.cpu_submit_probes ?? []).find((item) => item.partition === partition) ?? null;
  return probe ? cpuProbeRow(partition, probe, snap) : null;
}

export function cpuProbeState(
  probe: CpuSubmitProbe | null,
  probedAt: number,
  observedAt = probedAt,
  maxAge = 20 * 60,
): CpuProbeState {
  if (!probe) return "unknown";
  if (!probedAt || observedAt - probedAt > maxAge || observedAt < probedAt - 120) return "unknown";
  if (!probe.ok) return "failed";
  if (!probe.start_epoch) return "queued";
  // Judge the scheduler prediction at the instant it was tested. A queued
  // result must never turn green merely because later snapshots advance time.
  return probe.start_epoch <= probedAt + 120 ? "now" : "queued";
}

/** Can `salloc -p PARTITION` (no flags) start now, judged from the live
 *  snapshot. sbatch --test-only cannot answer this: it plans behind every
 *  queued job, including ones capped by QOS/association limits that the
 *  scheduler skips — DEF was predicted to start in 2 days behind 62
 *  QOSMaxJobsPerUserLimit jobs while a real salloc started in 13 s
 *  (2026-10-05). The request is the plugin's default cores with
 *  DefMemPerCPU each; it competes only with pending jobs the scheduler would
 *  actually place (Priority / Resources). null = not enough data. */
export interface CpuRequest {
  /** total CPUs (the -n / -c the quick request emits); 0 = plugin default */
  cores?: number;
  /** -N; 0 = Slurm decides */
  nodes?: number;
  /** --mem per node in MB; 0 = DefMemPerCPU x cores on that node */
  memMb?: number;
}

export function liveCpuStart(snap: Snapshot, partition: string, req: CpuRequest = {}): "now" | "queued" | null {
  const d = snap.policy?.partition_defaults?.[partition];
  if (!d?.cores) return null;
  const policy = snap.policy?.partition_policies?.[partition];
  if (policy?.grpJobs && partitionRunningJobs(snap.jobs, partition) >= policy.grpJobs) return "queued";
  const total = req.cores || d.cores;
  const needNodes = Math.max(1, req.nodes || 1);
  const cores = Math.ceil(total / needNodes);   // per node
  const memPerCore = d.def_mem_per_cpu_mb ?? 0;
  const memNeed = req.memMb || cores * memPerCore;
  const free = snap.nodes
    .filter((n) => n.partitions.includes(partition) && nodeIsSchedulable(n))
    .map((n) => ({ cores: Math.max(0, n.cpus - n.alloc_cpus), memMb: Math.max(0, n.real_memory - n.alloc_memory) }));
  // Waiters the scheduler would actually place claim the free nodes first,
  // each only on a node its per-node share fits: SINGLE's 51 Priority jobs
  // all want a whole 256-core node and never touched a 16-core request on a
  // part-used node (measured 2026-10-05, also with the 2-day walltime).
  const contenders = snap.jobs
    .filter((j) =>
      String(j.job_state).toUpperCase() === "PENDING"
      && String(j.partition || "").split(",").includes(partition)
      && !isLimitBlocked(j)
      && (j.state_reason === "Priority" || j.state_reason === "Resources"))
    .map((j) => Math.ceil((j.cpus || 1) / Math.max(1, j.node_count || 1)))
    .sort((a, b) => b - a);
  const open = [...free].sort((a, b) => a.cores - b.cores);
  for (const need of contenders) {
    const i = open.findIndex((f) => f.cores >= need);
    if (i >= 0) open.splice(i, 1);
  }
  if (open.filter((f) => f.cores >= cores && f.memMb >= memNeed).length >= needNodes) return "now";
  // multi-node partitions may spread the tasks over partly free nodes when
  // neither -N nor a per-node --mem pins the shape
  const multiNode = (snap.policy?.partition_caps?.[partition]?.maxNodes ?? 2) > 1;
  if (multiNode && !req.nodes && !req.memMb) {
    const spread = open.reduce((sum, f) => sum + Math.min(f.cores, memPerCore ? Math.floor(f.memMb / memPerCore) : f.cores), 0);
    if (spread >= cores) return "now";
  }
  return "queued";
}

/** The verdict shown for a CPU partition: the live judgement, except that a
 *  probe the scheduler rejected outright stays "failed". */
export function cpuStartState(row: Pick<CpuProbeRow, "partition" | "probe">, snap: Snapshot): CpuProbeState {
  const probed = cpuProbeState(row.probe, snap.cpu_submit_probes_generated_at || snap.generated_at,
                               snap.generated_at, cpuProbeMaxAge(snap));
  if (probed === "failed") return probed;
  return liveCpuStart(snap, row.partition) ?? probed;
}

export function cpuProbeMaxAge(snap: Snapshot) {
  return (snap.cpu_submit_probe_interval ?? 900) + 300;
}

export function cleanCpuProbeRaw(raw: string) {
  return raw
    .replace(/\bsbatch:\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
