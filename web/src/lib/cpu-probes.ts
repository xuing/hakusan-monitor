import { expandHostlist, nodeIsBackfillCandidate, nodeIsSchedulable } from "@/lib/derive";
import { selectNodes, switchTable, type FreeNode, type NodeRequest, type Switch, type Take } from "@/lib/node-select";
import { nodeOpenUntil, queueModel } from "@/lib/queue";
import { allowsMultiNode, defaultRequestSec, partitionCap } from "@/lib/slurm";
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
 * The backend (sources.cpu_test_partitions) decides which partitions get
 * probed — no second copy of that list lives here. */
export function cpuProbeRows(pool: Pool, snap: Snapshot): CpuProbeRow[] {
  return (snap.cpu_submit_probes ?? [])
    .filter((probe) => pool.partitions.includes(probe.partition))
    .map((probe) => cpuProbeRow(probe.partition, probe, snap));
}

function cpuProbeRow(partition: string, probe: CpuSubmitProbe | null, snap: Snapshot): CpuProbeRow {
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
  if (probe.ok === null) return "unknown";   // no answer: timeout, controller unreachable
  if (!probe.ok) return "failed";
  if (!probe.start_epoch) return "queued";
  // Judge the scheduler prediction at the instant it was tested. A queued
  // result must never turn green merely because later snapshots advance time.
  return probe.start_epoch <= probedAt + 120 ? "now" : "queued";
}

/** Can a request start now, judged from the live snapshot. sbatch
 *  --test-only cannot answer this: it plans behind every queued job,
 *  including ones capped by QOS/association limits that the scheduler skips —
 *  DEF was predicted to start in 2 days behind 62 QOSMaxJobsPerUserLimit jobs
 *  while a real salloc started in 13 s (2026-10-05). The request gets what
 *  the queue leaves (queue.ts claims), on the nodes Slurm's own selection
 *  would give it (node-select.ts). null = not enough data. */
export interface CpuRequest {
  /** total CPUs (the -n / -c the quick request emits); 0 = plugin default */
  cores?: number;
  /** -N; 0 = Slurm decides */
  nodes?: number;
  /** --mem per node in MB; 0 = DefMemPerCPU per CPU */
  memMb?: number;
  /** how long it holds its nodes (s); absent = the partition's default */
  timeSec?: number;
}

const groupFull = (snap: Snapshot, partition: string) => queueModel(snap).groupFull(partition);

const tables = new WeakMap<object, Switch[]>();
function switchesOf(snap: Snapshot): Switch[] {
  const policy = snap.policy;
  if (!policy) return [];
  let table = tables.get(policy);
  if (!table) {
    table = switchTable(policy.topology ?? [], expandHostlist);
    tables.set(policy, table);
  }
  return table;
}

/** The partition's nodes a new job may use, in Slurm's node order, with
 *  what the queue leaves once it has started what it can (queue.ts claims).
 *  SINGLE's 51 Priority jobs all want a whole 256-core node and never
 *  touched a 16-core request on a part-used node (measured 2026-10-05). A
 *  PLANNED node carries its booked start: only a job ending by then may use
 *  it — a 16-core TINY job started in 19 s on PLANNED lcpcc-003 (2026-10-06). */
function openNodes(snap: Snapshot, partition: string): FreeNode[] {
  const q = queueModel(snap);
  return snap.nodes
    .filter((n) => n.partitions.includes(partition) && (nodeIsSchedulable(n) || nodeIsBackfillCandidate(n)))
    .map((n) => {
      const claim = q.claims.get(n.name);
      return {
        name: n.name, gpus: 0, gpuType: "",
        cores: Math.max(0, n.cpus - n.alloc_cpus - (claim?.cores ?? 0)),
        memMb: Math.max(0, n.real_memory - n.alloc_memory - (claim?.memMb ?? 0)),
        until: nodeOpenUntil(q, n),
      };
    });
}

/** The request as Slurm reads it. Flagless: the submit plugin's tasks and
 *  cores. With a core count: `-n N` where the partition lets a job span
 *  nodes, else `-n 1 -c N` (request-command.ts). Memory: --mem per node, or
 *  DefMemPerCPU per CPU. */
function newRequest(snap: Snapshot, partition: string, req: CpuRequest): NodeRequest | null {
  const d = snap.policy?.partition_defaults?.[partition];
  if (!d?.cores) return null;
  const cap = partitionCap(partition, snap.policy);
  const cores = req.cores || d.cores;
  let tasks: number;
  let cpt: number;
  if (!req.cores) {
    tasks = d.tasks || d.cores;
    cpt = Math.max(1, Math.floor(d.cores / tasks));
  } else if (allowsMultiNode(cap, maxNodeCores(snap, partition))) {
    tasks = cores;
    cpt = 1;
  } else {
    tasks = 1;
    cpt = cores;
  }
  const hold = req.timeSec ?? defaultRequestSec(partition, snap.policy);
  return {
    endsAt: Number.isFinite(hold) && hold > 0 ? snap.generated_at * 1000 + hold * 1000 : undefined,
    minNodes: req.nodes || 1,
    maxNodes: req.nodes || cap.maxNodes || 0,
    tasks, cpus: tasks * cpt, cpusPerTask: cpt, tasksPerNode: 0, minCpusNode: cpt,
    memPerCpuMb: req.memMb ? 0 : d.def_mem_per_cpu_mb ?? 0,
    memPerNodeMb: req.memMb ?? 0,
    gpusPerNode: 0, gpuType: "", required: [], excluded: [],
  };
}

const maxNodeCores = (snap: Snapshot, partition: string) =>
  Math.max(0, ...snap.nodes.filter((n) => n.partitions.includes(partition)).map((n) => n.cpus));

/** Where the request would land now, or null when it queues. */
function placeNow(snap: Snapshot, partition: string, req: CpuRequest): Take[] | null {
  const request = newRequest(snap, partition, req);
  return request ? selectNodes(openNodes(snap, partition), request, switchesOf(snap)) : null;
}

export function liveCpuStart(snap: Snapshot, partition: string, req: CpuRequest = {}): "now" | "queued" | null {
  if (!snap.policy?.partition_defaults?.[partition]?.cores) return null;
  if (groupFull(snap, partition)) return "queued";
  return placeNow(snap, partition, req) ? "now" : "queued";
}

export interface CpuStartLimits {
  /** most cores a request with the default memory per core starts with now
   *  (0 = none); a multi-node partition may spread it over nodes */
  maxCores: number;
  /** true when maxCores lands on several nodes */
  spread: boolean;
  /** the partition's group job cap is full: nothing starts, whatever the size */
  groupFull: boolean;
}

/** Largest n in [lo, hi] for which ok(n) holds, assuming ok holds up to some
 *  point and not beyond (a smaller request never fits worse); lo - 1 = none. */
function largest(lo: number, hi: number, ok: (n: number) => boolean): number {
  if (hi < lo || !ok(lo)) return lo - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ok(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The "no queue" end of the quick request's core slider: the most cores
 *  for which liveCpuStart says "now" with the same -N and --mem. The group
 *  cap is reported apart: it is not a property of the request's size. */
export function cpuStartLimits(snap: Snapshot, partition: string, req: Pick<CpuRequest, "nodes" | "memMb" | "timeSec"> = {}): CpuStartLimits | null {
  if (!snap.policy?.partition_defaults?.[partition]?.cores) return null;
  const cap = partitionCap(partition, snap.policy);
  const free = openNodes(snap, partition).reduce((sum, n) => sum + n.cores, 0);
  const lo = Math.max(1, cap.minCores ?? 1, req.nodes || 1);
  const best = largest(lo, Math.min(cap.maxCores ?? free, free), (cores) => placeNow(snap, partition, { ...req, cores }) !== null);
  const maxCores = best >= lo ? best : 0;
  const spread = maxCores > 0 && (placeNow(snap, partition, { ...req, cores: maxCores })?.length ?? 0) > 1;
  return { maxCores, spread, groupFull: groupFull(snap, partition) };
}

/** Most --mem (per node, MB) a request of `cores` cores on `nodes` nodes
 *  starts with now — the exact point where liveCpuStart flips; 0 = the
 *  cores do not start at any --mem. */
export function cpuStartMemMb(snap: Snapshot, partition: string, cores: number, nodes = 0, timeSec?: number): number {
  const most = Math.max(0, ...openNodes(snap, partition).map((n) => n.memMb));
  const mem = largest(1, most, (memMb) => placeNow(snap, partition, { cores: Math.max(1, cores), nodes, memMb, timeSec }) !== null);
  return Math.max(0, mem);
}

/** How many nodes the request lands on now (0 = it queues). */
export function cpuPlacedNodes(snap: Snapshot, partition: string, req: CpuRequest): number {
  return placeNow(snap, partition, req)?.length ?? 0;
}

/** True when the default-memory request for `cores` (no -N, no --mem) would
 *  land on more than one node: each node then gets DefMemPerCPU x the cores
 *  placed there, and no one per-node --mem value describes it. */
export function cpuDefaultSpreads(snap: Snapshot, partition: string, cores: number, timeSec?: number): boolean {
  return (placeNow(snap, partition, { cores: Math.max(1, cores), timeSec })?.length ?? 0) > 1;
}

/** The verdict shown for a CPU partition: the live judgement (the same one
 *  the quick request's panel shows), except that a probe the scheduler
 *  rejected outright stays "failed". Neither of the probe's start times is
 *  trusted: its "later" plans behind QOS-capped waiters (DEF "10-09" while a
 *  real DEF job started in 9 s, 2026-10-05), and its "now" ignores backfill
 *  bookings — it answered "now" for LONG-L's 2-day default while a real
 *  2-day LONG-L job stayed pending on the booked nodes (2026-10-07). */
export function cpuStartState(row: Pick<CpuProbeRow, "partition" | "probe">, snap: Snapshot): CpuProbeState {
  const probedAt = snap.cpu_submit_probes_generated_at || snap.generated_at;
  const probed = cpuProbeState(row.probe, probedAt, snap.generated_at, cpuProbeMaxAge(snap));
  if (probed === "failed") return probed;
  // a full group cap is live fact; the probe may predate it
  if (groupFull(snap, row.partition)) return "queued";
  return liveCpuStart(snap, row.partition) ?? probed;
}

function cpuProbeMaxAge(snap: Snapshot) {
  return (snap.cpu_submit_probe_interval ?? 900) + 300;
}

export function cleanCpuProbeRaw(raw: string) {
  return raw
    .replace(/\bsbatch:\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
