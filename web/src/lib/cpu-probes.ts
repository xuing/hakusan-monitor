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

interface CpuSlot { cores: number; memMb: number }

/** The free (cores, memory) slots of a partition's schedulable nodes left
 *  after the waiters the scheduler would actually place claim theirs: each
 *  Priority/Resources waiter takes the smallest node its per-node share fits.
 *  SINGLE's 51 Priority jobs all want a whole 256-core node and never touched
 *  a 16-core request on a part-used node (measured 2026-10-05, also with the
 *  2-day walltime). Limit-capped and dependency-held jobs take nothing. */
function cpuOpenSlots(snap: Snapshot, partition: string): CpuSlot[] {
  const free = snap.nodes
    .filter((n) => n.partitions.includes(partition) && nodeIsSchedulable(n))
    .map((n) => ({ cores: Math.max(0, n.cpus - n.alloc_cpus), memMb: Math.max(0, n.real_memory - n.alloc_memory) }));
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
  return open;
}

const isMultiNode = (snap: Snapshot, partition: string) =>
  (snap.policy?.partition_caps?.[partition]?.maxNodes ?? 2) > 1;

const groupFull = (snap: Snapshot, partition: string) => {
  const policy = snap.policy?.partition_policies?.[partition];
  return Boolean(policy?.grpJobs && partitionRunningJobs(snap.jobs, partition) >= policy.grpJobs);
};

/** Cores one slot can give a request that takes DefMemPerCPU per core. */
const slotCores = (f: CpuSlot, memPerCore: number) =>
  Math.min(f.cores, memPerCore ? Math.floor(f.memMb / memPerCore) : f.cores);

export function liveCpuStart(snap: Snapshot, partition: string, req: CpuRequest = {}): "now" | "queued" | null {
  const d = snap.policy?.partition_defaults?.[partition];
  if (!d?.cores) return null;
  if (groupFull(snap, partition)) return "queued";
  const total = req.cores || d.cores;
  const needNodes = Math.max(1, req.nodes || 1);
  const cores = Math.ceil(total / needNodes);   // per node
  const memPerCore = d.def_mem_per_cpu_mb ?? 0;
  const memNeed = req.memMb || cores * memPerCore;
  const open = cpuOpenSlots(snap, partition);
  if (open.filter((f) => f.cores >= cores && f.memMb >= memNeed).length >= needNodes) return "now";
  // multi-node partitions may spread the tasks over partly free nodes when
  // neither -N nor a per-node --mem pins the shape
  if (isMultiNode(snap, partition) && !req.nodes && !req.memMb) {
    if (open.reduce((sum, f) => sum + slotCores(f, memPerCore), 0) >= total) return "now";
  }
  return "queued";
}

export interface CpuStartLimits {
  /** most cores a request with the default memory per core starts with now
   *  (0 = none); a multi-node partition may spread it over nodes */
  maxCores: number;
  /** true when maxCores comes from spreading over several nodes */
  spread: boolean;
  /** the partition's group job cap is full: nothing starts, whatever the size */
  groupFull: boolean;
}

/** The "no queue" end of the quick request's core slider, from the same
 *  open slots liveCpuStart judges and for the same shape: -N fixes how many
 *  nodes share the cores, an explicit --mem replaces DefMemPerCPU x cores as
 *  the per-node memory. A value at or below it reads "can start", one above
 *  "will queue". The group cap is reported apart: it is not a property of
 *  the request's size. */
export function cpuStartLimits(snap: Snapshot, partition: string, req: Pick<CpuRequest, "nodes" | "memMb"> = {}): CpuStartLimits | null {
  const d = snap.policy?.partition_defaults?.[partition];
  if (!d?.cores) return null;
  const memPerCore = d.def_mem_per_cpu_mb ?? 0;
  const open = cpuOpenSlots(snap, partition);
  // cores one slot gives this request: all its free cores when an explicit
  // --mem fits it, else as many as DefMemPerCPU each lets it hold
  const give = (f: CpuSlot) => (req.memMb ? (f.memMb >= req.memMb ? f.cores : 0) : slotCores(f, memPerCore));
  let best: number;
  let spread = false;
  if (req.nodes && req.nodes > 0) {
    // N nodes with the same per-node share: N x the N-th best slot
    const per = open.map(give).sort((a, b) => b - a);
    best = per.length >= req.nodes ? per[req.nodes - 1] * req.nodes : 0;
  } else {
    const single = Math.max(0, ...open.map(give));
    const spreadSum = isMultiNode(snap, partition) && !req.memMb ? open.reduce((sum, f) => sum + give(f), 0) : 0;
    best = Math.max(single, spreadSum);
    spread = spreadSum > single;
  }
  const cap = snap.policy?.partition_caps?.[partition];
  best = Math.min(cap?.maxCores ?? Number.POSITIVE_INFINITY, best);
  const maxCores = best >= (cap?.minCores ?? 1) ? best : 0;
  return { maxCores, spread: spread && maxCores > 0, groupFull: groupFull(snap, partition) };
}

/** Most --mem (per node, MB) a request of `cores` cores on `nodes` nodes
 *  starts with now: the needNodes-th largest free memory among open slots
 *  that hold the per-node cores. 0 = no slot holds the cores at all. */
export function cpuStartMemMb(snap: Snapshot, partition: string, cores: number, nodes = 0): number {
  const needNodes = Math.max(1, nodes || 1);
  const per = Math.ceil(Math.max(1, cores) / needNodes);
  const mems = cpuOpenSlots(snap, partition).filter((f) => f.cores >= per).map((f) => f.memMb).sort((a, b) => b - a);
  return mems.length >= needNodes ? mems[needNodes - 1] : 0;
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
