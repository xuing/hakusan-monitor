/**
 * Slurm's pending queue: which jobs start before a new one, and what they
 * take. Every "starts now / queues" verdict, every contention count and the
 * pending-job lists read this one model.
 *
 * Slurm reports ONE Reason per pending job, but its limits are per
 * partition. A job queued to GPU-1,GPU-1A,GPU-S said QOSGrpJobsLimit (GPU-S
 * was at 10/10) while Slurm had already booked it onto spcc-a40g20 through
 * GPU-1 — SchedNodes and StartTime matched the next A40 release (2026-10-06).
 * Reading the string as the truth had been patched one symptom at a time:
 * QOSGrp waiters, DependencyNeverSatisfied, "Priority" waiters behind a full
 * cap, months-old stuck waiters, the first-listed pool. The rules instead:
 *
 *  1. A reason that holds the whole job — a hold, a dependency, a begin
 *     time, an association, license or array limit — is believed.
 *  2. The QoS caps it can count, GrpJobs and MaxJobsPerUser, are counted per
 *     partition from the running jobs; their Reason string is not read.
 *  3. A job Slurm has booked nodes for (SchedNodes) is waiting for nodes,
 *     whatever QoS or partition reason it shows: that reason may come from
 *     any one partition of its list.
 *  4. A waiter older than the longest time limit on its nodes is stuck:
 *     every job running when it arrived has ended since, and it took no slot.
 *
 * queueModel() then plays the scheduler once over the whole cluster: waiters
 * in priority order, each into the first partition of its own list it may
 * start in, best fit, using up GrpJobs / MaxJobsPerUser slots as it goes.
 * What they take — the `claims` on each node and the group slots — every
 * "starts now" verdict subtracts.
 */
import { clusterMs, clusterTimeZone } from "@/lib/cluster-time";
import { expandHostlist, nodeIsSchedulable, parseGpuCount } from "@/lib/derive";
import { partitionPolicy, wallLabelSec } from "@/lib/slurm";
import type { RawJob, RawNode, Snapshot } from "@/types/snapshot";

export type WaitKind =
  /** starts as soon as resources fit: ahead of a new job */
  | "next"
  /** every partition it lists is at its QoS GrpJobs cap */
  | "group-cap"
  /** its owner already runs MaxJobsPerUser jobs where it could go */
  | "user-cap"
  | "dependency"
  /** held by a user or admin, or its begin time is ahead */
  | "held"
  /** a limit this model cannot count (association, QoS TRES, array throttle, license, partition state) */
  | "limit"
  /** never starts without someone acting: an unmet dependency, a bad account, a request over a per-job limit */
  | "never"
  /** pending longer than the longest time limit on its nodes */
  | "stuck";

export interface Waiter {
  job: RawJob;
  kind: WaitKind;
  /** partitions it may start in now, in its own order (kind "next") */
  open: string[];
  /** the partition it starts in now, when the queue's play placed it */
  placed?: string;
}

export interface Claim {
  gpus: number;
  cores: number;
  memMb: number;
}

export interface QueueModel {
  /** every pending job, in Slurm's scheduling order (priority, then age) */
  waiters: Waiter[];
  /** what the waiters that can start now take from each node first */
  claims: Map<string, Claim>;
  /** future starts Slurm has booked on each node for waiters that do not start now (ms, ascending) */
  bookings: Map<string, number[]>;
  /** jobs running in the partition's QoS */
  running(partition: string): number;
  /** no GrpJobs slot is left for a new job once the queue has started what it can */
  groupFull(partition: string): boolean;
  /** GrpJobs slots still open once the queue has started what it can (Infinity: no cap) */
  slotsLeft(partition: string): number;
}

/** The parts of a snapshot the model reads (tests pass just these). */
export type QueueInput = Pick<Snapshot, "jobs" | "nodes" | "pools" | "policy" | "part_pool" | "generated_at">;

const cache = new WeakMap<QueueInput, { zone: string | undefined; model: QueueModel }>();

/** The queue model of one snapshot, built once and shared by every caller
 *  (again once the cluster's time zone arrives: bookings are read in it). */
export function queueModel(snap: QueueInput): QueueModel {
  const zone = clusterTimeZone();
  let hit = cache.get(snap);
  if (!hit || hit.zone !== zone) {
    hit = { zone, model: buildModel(snap) };
    cache.set(snap, hit);
  }
  return hit.model;
}

/** Waiters ahead of a new job in this pool, in priority order: the ones that
 *  start here now, and the ones that may run here and wait for nodes. */
export function poolContenders(snap: QueueInput, poolId: string): Waiter[] {
  const partPool = snap.part_pool ?? {};
  return queueModel(snap).waiters.filter((w) => w.kind === "next"
    && (w.placed ? partPool[w.placed] === poolId : w.open.some((p) => partPool[p] === poolId)));
}

/** Every pending job listing a partition of this pool. */
export function poolWaiters(snap: QueueInput, poolId: string): Waiter[] {
  return queueModel(snap).waiters.filter((w) => partitionsOf(w.job).some((p) => snap.part_pool[p] === poolId));
}

export const partitionsOf = (job: RawJob) => String(job.partition || "").split(",").filter(Boolean);

const stateOf = (job: RawJob) => String(job.job_state || "").toUpperCase();

/** Pending jobs in the order they get their turn: the ones Slurm will start
 *  next by their booked start, then priority; jobs held by a cap, a limit or
 *  a dependency after them; jobs that never start on their own last. */
export function turnOrder(waiters: Waiter[]): Waiter[] {
  const group = (w: Waiter) =>
    w.kind === "next" ? 0 : w.kind === "never" || /^JobHeld/.test(w.job.state_reason || "") ? 2 : 1;
  const booked = (w: Waiter) => {
    const ms = clusterMs(w.job.start_est);
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
  };
  return [...waiters].sort((a, b) => group(a) - group(b) || booked(a) - booked(b) || (b.job.priority ?? 0) - (a.job.priority ?? 0));
}

// ---- reasons ------------------------------------------------------------

/** QoS caps this model counts itself (rule 2): their Reason is not read. */
const COUNTED = new Set(["QOSGrpJobsLimit", "QOSMaxJobsPerUserLimit", "QOSJobLimit"]);
const HELD = new Set(["JobHeldUser", "JobHeldAdmin", "BeginTime", "Reservation"]);
const NEVER = new Set(["DependencyNeverSatisfied", "BadConstraints", "InvalidAccount", "InvalidQOS", "AccountNotAllowed"]);

/** The kind a Reason alone decides, or null when the job waits for
 *  resources (Priority, Resources, None, unavailable nodes) or for a cap this
 *  model counts. */
export function reasonKind(reason: string): WaitKind | null {
  if (reason === "Dependency") return "dependency";
  if (HELD.has(reason)) return "held";
  // a request over a per-job QoS limit (QOSMaxCpuPerJobLimit: 17 cores in a
  // 16-core TINY) never fits, however long it waits
  if (NEVER.has(reason) || /^QOS(Max\w*PerJob|Min)/.test(reason)) return "never";
  if (COUNTED.has(reason)) return null;
  if (/^(QOS|Assoc|Partition|BurstBuffer)/.test(reason) || reason === "JobArrayTaskLimit" || reason === "Licenses") {
    return "limit";
  }
  return null;
}

// ---- the model ------------------------------------------------------------

interface Room {
  name: string;
  partitions: Set<string>;
  gpuType: string;
  gpus: number;
  cores: number;
  memMb: number;
}

function buildModel(snap: QueueInput): QueueModel {
  const policy = snap.policy;
  const qosOf = (partition: string) =>
    policy?.partitions?.[partition]?.qos || partition;

  // ---- running jobs per QoS, and per user and QoS ----
  const running = new Map<string, number>();
  const userRunning = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const job of snap.jobs) {
    if (stateOf(job) !== "RUNNING") continue;
    const qos = qosOf(partitionsOf(job)[0] ?? "");
    bump(running, qos);
    bump(userRunning, `${job.user_name}\0${qos}`);
  }
  const groupCap = (p: string) => partitionPolicy(p, policy).grpJobs ?? 0;
  const userCap = (p: string) => partitionPolicy(p, policy).maxJobsPerUser ?? 0;
  const capFull = (p: string) => groupCap(p) > 0 && (running.get(qosOf(p)) ?? 0) >= groupCap(p);
  const userFull = (user: string, p: string) =>
    userCap(p) > 0 && (userRunning.get(`${user}\0${qosOf(p)}`) ?? 0) >= userCap(p);

  // ---- rule 4: the longest time limit on each pool's nodes ----
  const partPool = snap.part_pool ?? {};
  const longestWall = new Map<string, number>();
  for (const [p, pool] of Object.entries(partPool)) {
    longestWall.set(pool, Math.max(longestWall.get(pool) ?? 0, wallLabelSec(policy?.partition_caps?.[p]?.wall)));
  }
  const stuck = (job: RawJob) => {
    if (!job.submit_time) return false;
    const longest = Math.max(0, ...partitionsOf(job).map((p) => longestWall.get(partPool[p]) ?? 0));
    return longest > 0 && snap.generated_at - job.submit_time > longest;
  };

  // ---- rule 3: Slurm's own bookings ----
  const bookedAt = (job: RawJob) => {
    const ms = clusterMs(job.start_est);
    return job.sched_nodes && Number.isFinite(ms) ? ms : null;
  };

  const classify = (job: RawJob): Waiter => {
    const parts = partitionsOf(job);
    const reason = String(job.state_reason || "");
    const byReason = reasonKind(reason);
    const booked = bookedAt(job) !== null;
    if (byReason && !(booked && /^(QOS|Partition)/.test(reason))) return { job, kind: byReason, open: [] };
    const open = parts.filter((p) => !capFull(p) && !userFull(job.user_name, p));
    if (!booked) {
      if (open.length === 0) return { job, kind: parts.every(capFull) ? "group-cap" : "user-cap", open };
      if (stuck(job)) return { job, kind: "stuck", open: [] };
    }
    return { job, kind: "next", open: open.length ? open : parts };
  };

  const waiters = snap.jobs
    .filter((job) => stateOf(job) === "PENDING")
    .map(classify)
    .sort((a, b) =>
      (b.job.priority ?? 0) - (a.job.priority ?? 0)
      || (a.job.submit_time ?? 0) - (b.job.submit_time ?? 0)
      || String(a.job.job_id).localeCompare(String(b.job.job_id)));

  // ---- play the scheduler once: who starts now, and on what ----
  const pools = snap.pools ?? [];
  const gpuType = new Map(pools.map((p) => [p.id, p.gpu?.type ?? ""]));
  const gpuPool = new Set(pools.filter((p) => p.kind === "gpu").map((p) => p.id));
  const rooms: Room[] = snap.nodes
    .filter((node) => nodeIsSchedulable(node))
    .map((node) => freeRoom(node, gpuType.get(node.pool) ?? ""))
    .filter((room) => room.cores > 0);
  const groupLeft = new Map<string, number>();
  const userLeft = new Map<string, number>();
  const left = (map: Map<string, number>, key: string, cap: number, used: number) =>
    map.get(key) ?? (cap > 0 ? cap - used : Number.POSITIVE_INFINITY);
  const claims = new Map<string, Claim>();
  for (const w of waiters) {
    if (w.kind !== "next") continue;
    for (const p of w.open) {
      const qos = qosOf(p);
      const userKey = `${w.job.user_name}\0${qos}`;
      const g = left(groupLeft, qos, groupCap(p), running.get(qos) ?? 0);
      const u = left(userLeft, userKey, userCap(p), userRunning.get(userKey) ?? 0);
      if (g <= 0 || u <= 0) continue;
      const share = shareOf(w.job, gpuPool.has(partPool[p]));
      const placed = place(rooms.filter((r) => r.partitions.has(p)), w.job, share);
      if (!placed) continue;
      for (const { room, take } of placed) {
        room.gpus -= take.gpus;
        room.cores -= take.cores;
        room.memMb -= take.memMb;
        const prev = claims.get(room.name) ?? { gpus: 0, cores: 0, memMb: 0 };
        claims.set(room.name, { gpus: prev.gpus + take.gpus, cores: prev.cores + take.cores, memMb: prev.memMb + take.memMb });
      }
      groupLeft.set(qos, g - 1);
      userLeft.set(userKey, u - 1);
      w.placed = p;
      break;
    }
  }

  // ---- bookings: Slurm's future starts for the waiters that do not start now ----
  // (one that starts now leaves its booking moot)
  const bookings = new Map<string, number[]>();
  for (const w of waiters) {
    const at = bookedAt(w.job);
    if (at === null || w.placed) continue;
    for (const node of expandHostlist(w.job.sched_nodes || "")) {
      const list = bookings.get(node) ?? [];
      list.push(at);
      bookings.set(node, list);
    }
  }
  for (const list of bookings.values()) list.sort((a, b) => a - b);

  const slotsLeft = (p: string) => left(groupLeft, qosOf(p), groupCap(p), running.get(qosOf(p)) ?? 0);
  return {
    waiters,
    claims,
    bookings,
    running: (p) => running.get(qosOf(p)) ?? 0,
    groupFull: (p) => slotsLeft(p) <= 0,
    slotsLeft,
  };
}

function freeRoom(node: RawNode, gpuType: string): Room {
  return {
    name: node.name,
    partitions: new Set(node.partitions),
    gpuType,
    gpus: Math.max(0, parseGpuCount(node.gres, gpuType) - parseGpuCount(node.gres_used, gpuType)),
    cores: Math.max(0, node.cpus - node.alloc_cpus),
    memMb: Math.max(0, node.real_memory - node.alloc_memory),
  };
}

export interface Share {
  nodes: number;
  gpus: number;
  cores: number;
  memMb: number;
}

/** What a waiter needs on each node it lands on: cpus / gpus /
 *  min_memory_mb are job totals, split over its nodes. A GPU waiter with no
 *  parsed GPU count still wants one — that keeps the verdict on the
 *  "queues" side. */
export function shareOf(job: RawJob, gpuPartition: boolean): Share {
  const nodes = Math.max(1, job.node_count || 1);
  return {
    nodes,
    gpus: Math.ceil((job.gpus || 0) / nodes) || (gpuPartition ? 1 : 0),
    cores: Math.ceil((job.cpus || 0) / nodes),
    memMb: Math.ceil((job.min_memory_mb || 0) / nodes),
  };
}

/** May a waiter use this node? --exclude rules it out; --nodelist hosts are
 *  mandatory, but Slurm adds other hosts when the job needs more nodes than
 *  the list names. SchedNodes is a movable plan, not a constraint. */
export function mayUseNode(job: RawJob, nodeName: string): boolean {
  if (expandHostlist(job.exc_nodes || "").includes(nodeName)) return false;
  const required = expandHostlist(job.req_nodes || "");
  if (required.length === 0 || required.includes(nodeName)) return true;
  return Math.max(1, job.node_count || 1) > required.length;
}

interface Placement {
  room: Room;
  take: Claim;
}

/** Where a waiter would start now, and what it takes on each node — or null
 *  when it cannot start in full now. Required hosts come first; a GPU type
 *  named in the request (--gres=gpu:nvidia_a40:1) holds on every partition
 *  of its list. */
function place(rooms: Room[], job: RawJob, share: Share): Placement[] | null {
  const typeOk = (r: Room) => !share.gpus || !job.gpu_type || job.gpu_type === r.gpuType;
  const required = new Set(expandHostlist(job.req_nodes || ""));
  const usable = rooms.filter((r) => mayUseNode(job, r.name) && typeOk(r));
  const pinned = usable.filter((r) => required.has(r.name));
  if (pinned.length < Math.min(required.size, share.nodes)) return null;
  return !share.gpus && share.nodes > 1
    ? spread(usable, pinned, required, job, share.nodes)
    : packEven(usable, pinned, required, share);
}

/** The same share on every node, best fit: fewest spare GPUs, then cores,
 *  keeping the widest gaps open as Slurm's packing does. GPU jobs land this
 *  way: their --gres is per node. */
function packEven(usable: Room[], pinned: Room[], required: Set<string>, share: Share): Placement[] | null {
  const fits = (r: Room) => share.gpus <= r.gpus && share.cores <= r.cores && share.memMb <= r.memMb;
  if (!pinned.every(fits)) return null;
  const extra = usable
    .filter((r) => !required.has(r.name) && fits(r))
    .sort((a, b) => a.gpus - b.gpus || a.cores - b.cores || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, share.nodes - pinned.length));
  const chosen = [...pinned.slice(0, share.nodes), ...extra];
  const take = { gpus: share.gpus, cores: share.cores, memMb: share.memMb };
  return chosen.length >= share.nodes ? chosen.map((room) => ({ room, take })) : null;
}

/** A CPU job over N nodes: Slurm spreads its tasks over the cores the nodes
 *  have, at least one per node, not an equal share each — a running SMALL
 *  job held 256 CPUs on 18 nodes (2026-10-07). Its memory follows the cores
 *  (the job's memory per CPU). It takes the roomiest nodes, filled in order. */
function spread(usable: Room[], pinned: Room[], required: Set<string>, job: RawJob, nodes: number): Placement[] | null {
  const total = Math.max(nodes, job.cpus || 0);
  const memPerCore = (job.min_memory_mb || 0) / total;
  const roomOf = (r: Room) => Math.min(r.cores, memPerCore ? Math.floor(r.memMb / memPerCore) : r.cores);
  if (pinned.some((r) => roomOf(r) < 1)) return null;
  const extra = usable
    .filter((r) => !required.has(r.name) && roomOf(r) >= 1)
    .sort((a, b) => roomOf(b) - roomOf(a) || a.name.localeCompare(b.name));
  const chosen = [...pinned, ...extra].slice(0, nodes);
  if (chosen.length < nodes || chosen.reduce((sum, r) => sum + roomOf(r), 0) < total) return null;
  let left = total;
  return chosen.map((r, i) => {
    const cores = Math.min(roomOf(r), left - (nodes - i - 1));
    left -= cores;
    return { room: r, take: { gpus: 0, cores, memMb: Math.ceil(cores * memPerCore) } };
  });
}
