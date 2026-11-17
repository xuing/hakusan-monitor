/**
 * Generated cluster states for the start-verdict verification
 * (start-verdict.verify.ts). A Scenario is a small, readable description of
 * one snapshot: a GPU pool and a CPU pool of up to four nodes each, two
 * partitions per pool, their QoS (caps shared by every partition on it), and
 * running and pending jobs. buildSnapshot() turns it into the Snapshot the
 * product code reads, filled in the way the backend fills it. fast-check
 * prints the Scenario of a failing case, so keep it short and in Slurm's words.
 *
 * Consistency the backend guarantees, and so does this generator:
 *  - caps, MaxWall and GrpJobs / MaxJobsPerUser belong to the QoS and are
 *    copied to every partition on it (backend/sources.py build_policy_snapshot);
 *  - a node's allocated cores, GPUs and memory are exactly what the running
 *    jobs on it hold (settle()), and its state follows from that.
 *
 * Partition, QoS and node names are synthetic on purpose: nothing here may
 * stand for a Hakusan value (sites/hakusan.json holds those).
 */
import fc from "fast-check";
import type { Partition, PolicySnapshot, Pool, RawJob, RawNode, Snapshot } from "@/types/snapshot";

/** Snapshot time (s); bookings and time limits are relative to it. */
export const GEN = 1_800_000_000;
export const GPU_TYPE = "tA";
export const GPU_PARTS = ["gA", "gB"];
export const CPU_PARTS = ["cA", "cB"];
const POOL_OF: Record<string, string> = { gA: "gpu", gB: "gpu", cA: "cpu", cB: "cpu" };
export const isGpuNode = (n: NodeSpec) => GPU_PARTS.includes(n.parts[0]);

export type Service = "up" | "planned" | "drain";

export interface NodeSpec {
  name: string;
  parts: string[];
  /** leaf switch (when the scenario has a topology) */
  leaf: 0 | 1;
  cores: number;
  memMb: number;
  gpus: number;
  service: Service;
  /** what the running jobs on it hold (settle()) */
  coresUsed: number;
  memUsedMb: number;
  gpusUsed: number;
}

/** A QoS: what sacctmgr states, shared by every partition on it. */
export interface QosSpec {
  grpJobs: number;
  maxJobsPerUser: number;
  /** MaxWall in hours, 0 = none */
  wallH: number;
  /** MaxTRES per job: nodes, cores, memory (GB), GPUs; 0 = none */
  maxNodes: number;
  maxCores: number;
  maxMemGb: number;
  maxGpus: number;
}

export interface PartSpec {
  name: string;
  /** QoS key: its own name, or the QoS shared by both partitions of the pool (qG / qC) */
  qos: string;
  /** submit-plugin default cores / tasks, DefMemPerCPU, interactive -t (min, 0 = none) */
  defCores: number;
  defTasks: number;
  defMemPerCpu: number;
  interactiveMin: number;
}

export interface JobSpec {
  id: number;
  user: string;
  parts: string[];
  running: boolean;
  reason: string;
  priority: number;
  submitAgoMin: number;
  nodes: number;
  cpus: number;
  gpus: number;
  memMb: number;
  /** -t in minutes, 0 = none given */
  limitMin: number;
  /** request shape: "none" (squeue shows no task count), "-n" (cpus tasks x 1 CPU), "-c" (1 task x cpus) */
  shape: "none" | "-n" | "-c";
  /** SchedNodes + StartTime (minutes from now), empty = not booked */
  bookedOn: string[];
  bookedInMin: number;
  req: string[];
  exc: string[];
  /** running jobs: the nodes it runs on (settle()) */
  hosts: string[];
}

export interface Scenario {
  parts: PartSpec[];
  qos: Record<string, QosSpec>;
  nodes: NodeSpec[];
  jobs: JobSpec[];
  topology: boolean;
}

export const partOf = (sc: Scenario, p: string) => sc.parts.find((x) => x.name === p)!;
export const qosOfPart = (sc: Scenario, p: string) => sc.qos[partOf(sc, p).qos];

const subset = <T>(xs: T[], min = 0) =>
  fc.subarray(xs, { minLength: min }).map((s) => xs.filter((x) => s.includes(x)));

type NodeGen = Omit<NodeSpec, "coresUsed" | "memUsedMb" | "gpusUsed">;
type JobGen = Omit<JobSpec, "id" | "hosts"> & { hostShift: number };

const nodeArb = (name: string, gpu: boolean): fc.Arbitrary<NodeGen> =>
  fc.record({
    name: fc.constant(name),
    parts: subset(gpu ? GPU_PARTS : CPU_PARTS, 1),
    leaf: fc.constantFrom<0 | 1>(0, 1),
    cores: fc.constantFrom(4, 8, 16),
    memMb: fc.constantFrom(16000, 32000, 64000),
    gpus: gpu ? fc.integer({ min: 1, max: 4 }) : fc.constant(0),
    service: fc.constantFrom<Service>("up", "up", "up", "up", "planned", "drain"),
  });

const qosArb = (gpu: boolean): fc.Arbitrary<QosSpec> =>
  fc.record({
    grpJobs: fc.constantFrom(0, 0, 1, 2, 3),
    maxJobsPerUser: fc.constantFrom(0, 0, 1, 2),
    wallH: fc.constantFrom(0, 1, 4, 24),
    maxNodes: fc.constantFrom(0, 1, 2),
    maxCores: fc.constantFrom(0, 8, 16, 32),
    maxMemGb: fc.constantFrom(0, 0, 32),
    maxGpus: gpu ? fc.constantFrom(0, 1, 2, 4) : fc.constant(0),
  });

const partArb = (name: string, gpu: boolean): fc.Arbitrary<PartSpec> =>
  fc.record({
    name: fc.constant(name),
    qos: fc.constantFrom(name, gpu ? "qG" : "qC"),
    defCores: gpu ? fc.constantFrom(2, 4, 8) : fc.constantFrom(1, 2, 4),
    defTasks: fc.constantFrom(0, 1),
    defMemPerCpu: fc.constantFrom(0, 1000, 4000),
    interactiveMin: fc.constantFrom(0, 0, 0, 30),
  });

const REASONS = ["Priority", "Resources", "None", "QOSGrpJobsLimit", "QOSMaxJobsPerUserLimit",
  "Dependency", "JobHeldUser", "ReqNodeNotAvail"];

const jobArb = (nodeNames: { gpu: string[]; cpu: string[] }): fc.Arbitrary<JobGen> =>
  fc.constantFrom<"gpu" | "cpu">("gpu", "cpu").chain((pool) => {
    const parts = pool === "gpu" ? GPU_PARTS : CPU_PARTS;
    const names = nodeNames[pool];
    return fc.record({
      running: fc.constantFrom(false, false, false, true, true),
      user: fc.constantFrom("u1", "u2", "u3"),
      parts: subset(parts, 1),
      reason: fc.constantFrom(...REASONS),
      priority: fc.integer({ min: 0, max: 5 }),
      submitAgoMin: fc.constantFrom(1, 10, 60, 600, 3000),
      nodes: fc.constantFrom(1, 1, 1, 2),
      cpus: fc.constantFrom(1, 1, 1, 2, 2, 4, 8, 16),
      gpus: pool === "gpu" ? fc.constantFrom(1, 1, 1, 2, 4) : fc.constant(0),
      memMb: fc.constantFrom(0, 0, 0, 2000, 8000, 30000),
      limitMin: fc.constantFrom(0, 30, 30, 60, 240, 1440),
      shape: fc.constantFrom<"none" | "-n" | "-c">("none", "-n", "-c"),
      bookedOn: fc.oneof({ weight: 3, arbitrary: fc.constant([] as string[]) }, { weight: 1, arbitrary: subset(names, 1) }),
      bookedInMin: fc.integer({ min: 1, max: 600 }),
      req: fc.oneof({ weight: 4, arbitrary: fc.constant([] as string[]) }, { weight: 1, arbitrary: subset(names, 1) }),
      exc: fc.oneof({ weight: 4, arbitrary: fc.constant([] as string[]) }, { weight: 1, arbitrary: subset(names, 1) }),
      hostShift: fc.integer({ min: 0, max: 3 }),
    }).map((j) => {
      const req = j.req.slice(0, 2);
      const nodes = Math.max(j.nodes, req.length);
      return {
        ...j,
        // a running job sits in one partition and books nothing
        parts: j.running ? j.parts.slice(0, 1) : j.parts,
        nodes,
        cpus: Math.max(j.cpus, nodes),
        bookedOn: j.running ? [] : j.bookedOn,
        req: j.running ? [] : req,
        exc: j.running ? [] : j.exc.filter((n) => !req.includes(n)),
      };
    });
  });

/** Per-node share of a job: Slurm's even split, as queue.ts shareOf reads it. */
export const perNode = (j: Pick<JobSpec, "nodes" | "cpus" | "gpus" | "memMb">) => ({
  cpus: Math.ceil(j.cpus / j.nodes), gpus: Math.ceil(j.gpus / j.nodes), memMb: Math.ceil(j.memMb / j.nodes),
});

/** Put each running job on nodes of its partition that have room for its
 *  per-node share (in node order, rotated by hostShift), and derive every
 *  node's allocation from the jobs on it. A running job that fits nowhere is
 *  dropped: Slurm could not be running it. */
function settle(nodesIn: NodeGen[], jobsIn: JobGen[]): { nodes: NodeSpec[]; jobs: JobSpec[] } {
  const nodes: NodeSpec[] = nodesIn.map((n) => ({ ...n, coresUsed: 0, memUsedMb: 0, gpusUsed: 0 }));
  const jobs: JobSpec[] = [];
  for (const { hostShift, ...j } of jobsIn) {
    if (!j.running) {
      jobs.push({ ...j, id: jobs.length + 1, hosts: [] });
      continue;
    }
    const share = perNode(j);
    const cand = nodes.filter((n) => n.parts.includes(j.parts[0]));
    const rotated = [...cand.slice(hostShift % Math.max(1, cand.length)), ...cand.slice(0, hostShift % Math.max(1, cand.length))];
    const hosts = rotated.filter((n) => n.cores - n.coresUsed >= share.cpus && n.gpus - n.gpusUsed >= share.gpus
      && n.memMb - n.memUsedMb >= share.memMb).slice(0, j.nodes);
    if (hosts.length < j.nodes) continue;
    for (const n of hosts) {
      n.coresUsed += share.cpus;
      n.gpusUsed += share.gpus;
      n.memUsedMb += share.memMb;
    }
    jobs.push({ ...j, id: jobs.length + 1, hosts: hosts.map((n) => n.name) });
  }
  return { nodes, jobs };
}

export const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({ gpuNodes: fc.integer({ min: 1, max: 4 }), cpuNodes: fc.integer({ min: 1, max: 4 }) })
  .chain(({ gpuNodes, cpuNodes }) => {
    const names = {
      gpu: Array.from({ length: gpuNodes }, (_, i) => "g" + (i + 1)),
      cpu: Array.from({ length: cpuNodes }, (_, i) => "c" + (i + 1)),
    };
    return fc.record({
      parts: fc.tuple(...GPU_PARTS.map((p) => partArb(p, true)), ...CPU_PARTS.map((p) => partArb(p, false))),
      qos: fc.record({ gA: qosArb(true), gB: qosArb(true), qG: qosArb(true), cA: qosArb(false), cB: qosArb(false), qC: qosArb(false) }),
      nodes: fc.tuple(...names.gpu.map((n) => nodeArb(n, true)), ...names.cpu.map((n) => nodeArb(n, false))),
      jobs: fc.array(jobArb(names), { maxLength: 12, size: "medium" }),
      topology: fc.boolean(),
    }).map(({ nodes, jobs, ...rest }) => ({ ...rest, ...settle(nodes, jobs) }));
  });

// ---- Scenario -> Snapshot ---------------------------------------------------

const iso = (sec: number) => new Date(sec * 1000).toISOString();
const hhmm = (min: number) => min >= 1440 ? Math.floor(min / 1440) + "-" + String(Math.floor((min % 1440) / 60)).padStart(2, "0") + ":00:00"
  : String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0") + ":00";

/** Slurm's node state list for a spec, as scontrol prints it. */
export function nodeStates(n: NodeSpec): string[] {
  const base = n.coresUsed === 0 && n.gpusUsed === 0 ? "IDLE" : n.coresUsed >= n.cores ? "ALLOCATED" : "MIXED";
  return n.service === "planned" ? [base, "PLANNED"] : n.service === "drain" ? [base, "DRAIN"] : [base];
}

/** backend/normalize.py is_schedulable(). */
export const isSchedulable = (n: NodeSpec) => {
  const states = nodeStates(n);
  return states.some((s) => s === "IDLE" || s === "MIXED") && !states.some((s) => s === "PLANNED" || s === "DRAIN");
};

function rawNode(n: NodeSpec): RawNode {
  const state = nodeStates(n);
  return {
    name: n.name, pool: POOL_OF[n.parts[0]], state, state_bucket: "", schedulable: isSchedulable(n),
    partitions: n.parts, cpus: n.cores, alloc_cpus: n.coresUsed, cpu_load: "",
    real_memory: n.memMb, alloc_memory: n.memUsedMb, free_mem: n.memMb - n.memUsedMb,
    gres: n.gpus ? "gpu:" + GPU_TYPE + ":" + n.gpus : "", gres_used: n.gpus ? "gpu:" + GPU_TYPE + ":" + n.gpusUsed + "(IDX:N/A)" : "",
    features: "", alloc_tres: "", cfg_tres: "", boot_time: "", reason: "",
  };
}

function rawJob(j: JobSpec): RawJob {
  const pending = !j.running;
  return {
    job_id: j.id, user_name: j.user, account: "acct", partition: j.parts.join(","),
    job_state: pending ? "PENDING" : "RUNNING", state_reason: pending ? j.reason : "None",
    node_count: j.nodes, cpus: j.cpus, gpus: j.gpus, gpu_type: "", tres_req_str: "",
    min_memory_mb: j.memMb, container: "", submit_time: GEN - j.submitAgoMin * 60,
    end_time: "", start_est: pending && j.bookedOn.length ? iso(GEN + j.bookedInMin * 60) : "",
    time_left: "", name: "job" + j.id, qos: "", nodelist: j.hosts.join(","),
    sched_nodes: pending ? j.bookedOn.join(",") : "", req_nodes: j.req.join(","), exc_nodes: j.exc.join(","),
    time_used: "", priority: j.priority, time_limit: j.limitMin ? hhmm(j.limitMin) : "",
    ...(j.shape === "-n" ? { tasks: j.cpus, cpus_per_task: 1 } : j.shape === "-c" ? { tasks: 1, cpus_per_task: j.cpus } : {}),
  };
}

export function buildSnapshot(sc: Scenario): Snapshot {
  const nodes = sc.nodes.map(rawNode);
  const partitions: Partition[] = sc.parts.map((p) => {
    const mine = sc.nodes.filter((n) => n.parts.includes(p.name));
    const gpu = POOL_OF[p.name] === "gpu";
    const free = mine.reduce((s, n) => s + (isSchedulable(n) ? n.gpus - n.gpusUsed : 0), 0);
    return {
      name: p.name, kind: gpu ? "gpu" : "cpu", nodes: mine.length, pool: POOL_OF[p.name],
      cpus: { total: 0, alloc: 0, free: 0, util: 0 },
      gpu: gpu ? { total: 0, used: 0, down: 0, free, util: 0 } : null,
      jobs: { running: 0, pending: 0 },
      spec: { cores_per_node: Math.max(0, ...mine.map((n) => n.cores)), mem_per_node: Math.max(0, ...mine.map((n) => n.memMb)),
              gpu_per_node: Math.max(0, ...mine.map((n) => n.gpus)) },
      nodes_state: { drain: mine.filter((n) => n.service === "drain").length },
      available_nodes: mine.filter((n) => isSchedulable(n) && (gpu ? n.gpus > n.gpusUsed : n.cores > n.coresUsed)).length,
    };
  });
  const pool = (id: string, gpu: boolean): Pool => {
    const mine = sc.nodes.filter((n) => POOL_OF[n.parts[0]] === id);
    return {
      id, kind: gpu ? "gpu" : "cpu", nodes: mine.length, mem_per_node: Math.max(0, ...mine.map((n) => n.memMb)),
      nodes_state: {}, idle_nodes: 0, available_nodes: 0, down_nodes: 0,
      cores: { total: mine.reduce((s, n) => s + n.cores, 0), alloc: 0, free: 0, util: 0 }, util: 0,
      gpu: gpu ? { type: GPU_TYPE, label: GPU_TYPE, mem_gb: null, total: 0, used: 0, down: 0, free: 0, maint: false, util: 0, next_free: null } : null,
      partitions: gpu ? GPU_PARTS : CPU_PARTS, queue: { running: 0, pending: 0 },
    };
  };
  // backend/sources.py build_policy_snapshot: every partition gets its QoS's cap and policy
  const capOf = (q: QosSpec) => ({
    ...(q.wallH ? { wall: q.wallH + "h" } : {}),
    ...(q.maxNodes ? { maxNodes: q.maxNodes } : {}),
    ...(q.maxCores ? { maxCores: q.maxCores } : {}),
    ...(q.maxMemGb ? { maxMemGb: q.maxMemGb } : {}),
    ...(q.maxGpus ? { maxGpus: q.maxGpus } : {}),
  });
  const policy: PolicySnapshot = {
    generated_at: GEN, interval: 60,
    topology: sc.topology ? [
      { name: "s0", level: 0, nodes: sc.nodes.filter((n) => n.leaf === 0).map((n) => n.name).join(","), switches: "" },
      { name: "s1", level: 0, nodes: sc.nodes.filter((n) => n.leaf === 1).map((n) => n.name).join(","), switches: "" },
      { name: "top", level: 1, nodes: sc.nodes.map((n) => n.name).join(","), switches: "s0,s1" },
    ] : [],
    partition_caps: Object.fromEntries(sc.parts.map((p) => [p.name, capOf(sc.qos[p.qos])])),
    partition_policies: Object.fromEntries(sc.parts.map((p) => [p.name, {
      ...(sc.qos[p.qos].grpJobs ? { grpJobs: sc.qos[p.qos].grpJobs } : {}),
      ...(sc.qos[p.qos].maxJobsPerUser ? { maxJobsPerUser: sc.qos[p.qos].maxJobsPerUser } : {}),
    }])),
    partition_defaults: Object.fromEntries(sc.parts.map((p) => [p.name, {
      cores: p.defCores,
      ...(p.defTasks ? { tasks: p.defTasks } : {}),
      ...(p.defMemPerCpu ? { def_mem_per_cpu_mb: p.defMemPerCpu } : {}),
      ...(POOL_OF[p.name] === "gpu" ? { gpus_per_node: 1 } : {}),
      ...(p.interactiveMin ? { interactive_time_min: p.interactiveMin } : {}),
    }])),
    partitions: Object.fromEntries(sc.parts.map((p) => [p.name, { qos: p.qos }])),
  };
  return {
    schema_version: 1, cluster: "verify", slurm_version: "25.05",
    pools: [pool("gpu", true), pool("cpu", false)], partitions,
    queue: { running: 0, pending: 0, pending_reasons: {}, top_pending: [], releases: [], container_jobs: 0 },
    policy, nodes_down: [], nodes, jobs: sc.jobs.map(rawJob),
    part_pool: { ...POOL_OF }, generated_at: GEN, age_s: 0, source: "verify", stale: false,
  };
}

/** One line per QoS, partition, node and job, for failure messages. */
export function tell(sc: Scenario): string {
  const used = new Set(sc.parts.map((p) => p.qos));
  const qos = Object.entries(sc.qos).filter(([k]) => used.has(k)).map(([k, q]) => "  qos " + k
    + " GrpJobs " + (q.grpJobs || "-") + " MaxJobsPU " + (q.maxJobsPerUser || "-") + " wall " + (q.wallH ? q.wallH + "h" : "-")
    + " MaxTRES node=" + (q.maxNodes || "-") + " cpu=" + (q.maxCores || "-") + " mem=" + (q.maxMemGb ? q.maxMemGb + "G" : "-")
    + (q.maxGpus ? " gpu=" + q.maxGpus : ""));
  const parts = sc.parts.map((p) => "  partition " + p.name + " qos " + p.qos
    + " default " + p.defCores + " cores x " + (p.defMemPerCpu || 0) + " MB" + (p.interactiveMin ? " interactive -t " + p.interactiveMin + "m" : ""));
  const nodes = sc.nodes.map((n) => "  node " + n.name + " [" + n.parts.join(",") + "] " + nodeStates(n).join("+")
    + " cores " + n.coresUsed + "/" + n.cores + " mem " + n.memUsedMb + "/" + n.memMb
    + (n.gpus ? " gpus " + n.gpusUsed + "/" + n.gpus : ""));
  const jobs = sc.jobs.map((j) => "  job " + j.id + " " + (j.running ? "RUNNING on " + j.hosts.join(",") : "PENDING(" + j.reason + ")") + " " + j.user
    + " -p " + j.parts.join(",") + " prio " + j.priority + " -N " + j.nodes + " cpus " + j.cpus
    + (j.shape === "-n" ? " (-n " + j.cpus + ")" : j.shape === "-c" ? " (-n 1 -c " + j.cpus + ")" : "")
    + (j.gpus ? " gpus " + j.gpus : "") + (j.memMb ? " mem " + j.memMb : "") + (j.limitMin ? " -t " + j.limitMin + "m" : "")
    + (j.bookedOn.length ? " booked " + j.bookedOn.join(",") + " in " + j.bookedInMin + "m" : "")
    + (j.req.length ? " -w " + j.req.join(",") : "") + (j.exc.length ? " -x " + j.exc.join(",") : ""));
  return [...qos, ...parts, ...nodes, ...jobs].join("\n") + (sc.topology ? "\n  topology: s0/s1 under top" : "");
}
