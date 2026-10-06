import { describe, expect, it } from "vitest";
import { poolGpuAvailability } from "./gpu-fit";
import { poolContenders, queueModel, reasonKind, turnOrder, type QueueInput } from "./queue";
import { GENERATED_AT, JOBS, NODES, PART_POOL, POLICY, POOLS } from "./queue.fixtures";
import { applySite, getSite } from "./site";
import type { RawJob, RawNode, Snapshot } from "@/types/snapshot";

const live: QueueInput = { jobs: JOBS, nodes: NODES, pools: POOLS, policy: POLICY, part_pool: PART_POOL, generated_at: GENERATED_AT };
const byId = (id: string) => queueModel(live).waiters.find((w) => String(w.job.job_id) === id)!;

describe("who is waiting for what (squeue, 2026-10-06 22:44)", () => {
  it("counts GrpJobs and MaxJobsPerUser itself, and lands where Slurm's reasons do", () => {
    // every single-partition job Slurm holds on one of these two caps; the
    // count from the running jobs must reach the same verdict
    const capped = JOBS.filter((j) => j.job_state === "PENDING" && !j.partition.includes(",")
      && (j.state_reason === "QOSGrpJobsLimit" || j.state_reason === "QOSMaxJobsPerUserLimit"));
    expect(capped).toHaveLength(40);
    for (const job of capped) {
      expect(byId(String(job.job_id)).kind).toBe(job.state_reason === "QOSGrpJobsLimit" ? "group-cap" : "user-cap");
    }
  });

  it("ignores the one Reason of a job queued to several partitions", () => {
    // GPU-1,GPU-1A,GPU-S says QOSGrpJobsLimit (GPU-S is 10/10), yet Slurm
    // booked each of the five onto an A40 at the next A40 release
    const multi = ["783590", "783591", "783592", "784090", "784092"].map(byId);
    for (const w of multi) {
      expect(w.job.state_reason).toBe("QOSGrpJobsLimit");
      expect(w.job.sched_nodes).toMatch(/^spcc-a40g/);
      expect(w.kind).toBe("next");
      expect(w.open).toEqual(["GPU-1", "GPU-1A"]);
    }
  });

  it("puts every job Slurm has booked nodes for in line", () => {
    const booked = queueModel(live).waiters.filter((w) => w.job.sched_nodes);
    expect(booked.length).toBeGreaterThan(0);
    expect(booked.every((w) => w.kind === "next")).toBe(true);
  });

  it("ranks the A40 contenders the way Slurm booked the A40 releases", () => {
    const order = poolContenders(live, "a40").map((w) => String(w.job.job_id));
    // Slurm's own plan: 785313 23:35, then 783590 23:52, 783591 01:32,
    // 783592 03:14, 784090 11:57, 784092 15:20
    expect(order.slice(0, 6)).toEqual(["785313", "783590", "783591", "783592", "784090", "784092"]);
  });

  it("names the jobs that never start, wait on a dependency, or are held", () => {
    expect(byId("777900").kind).toBe("never");
    expect(byId("626618").kind).toBe("dependency");
    expect(byId("783582").kind).toBe("held");
  });

  it("counts the running jobs per partition QoS", () => {
    const q = queueModel(live);
    expect([q.running("GPU-S"), q.groupFull("GPU-S")]).toEqual([10, true]);
    expect([q.running("GPU-1"), q.groupFull("GPU-1")]).toEqual([26, false]);
  });
});

describe("what the queue takes when GPUs free up", () => {
  /** Derived from the 22:44 capture: the running jobs whose end Slurm's four
   *  next A40 bookings wait for (23:35, 23:52, 01:32, 03:14) have ended, and
   *  their nodes got the GPU, cores and memory back. */
  function released(endTimes: string[]): QueueInput {
    const ending = JOBS.filter((j) => j.job_state === "RUNNING" && endTimes.includes(j.end_time));
    expect(ending).toHaveLength(endTimes.length);
    const nodes = NODES.map((n) => {
      const gone = ending.filter((j) => j.nodelist === n.name);
      if (!gone.length) return n;
      const gpus = gone.reduce((s, j) => s + j.gpus, 0);
      return {
        ...n,
        state: ["MIXED"],
        schedulable: true,
        gres_used: n.gres_used.replace(/(gpu:[^:(,]+:)(\d+)/, (_m, head: string, k: string) => `${head}${Number(k) - gpus}`),
        alloc_cpus: n.alloc_cpus - gone.reduce((s, j) => s + j.cpus, 0),
        alloc_memory: n.alloc_memory - gone.reduce((s, j) => s + (j.min_memory_mb ?? 0), 0),
      };
    });
    const partitions = Object.entries(PART_POOL).map(([name, pool]) => ({ name, pool }));
    return { ...live, nodes, jobs: JOBS.filter((j) => !ending.includes(j)), partitions } as QueueInput;
  }

  it("gives four freed A40s to four waiters, so a new job gets none", () => {
    const snap = released(["2026-10-06T23:35:44", "2026-10-06T23:52:24", "2026-10-07T01:32:37", "2026-10-07T03:14:47"]);
    const avail = poolGpuAvailability(snap as Snapshot, POOLS.find((p) => p.id === "a40")!);
    // Slurm booked all four releases. Dropping the five QOSGrpJobsLimit-
    // reason jobs (the old rule) left one GPU "ready" here.
    expect(avail.ready).toBe(0);
    expect(avail.segments).toEqual([{ kind: "contested", count: 4 }]);
  });
});

// ---- small cases: one rule each ----------------------------------------------

const node = (name: string, over: Partial<RawNode> = {}): RawNode => ({
  name, pool: "a40", state: ["IDLE"], state_bucket: "idle", schedulable: true, partitions: ["GPU-1"],
  cpus: 52, alloc_cpus: 0, cpu_load: "", real_memory: 515_000, alloc_memory: 0, free_mem: 0,
  gres: "gpu:nvidia_a40:2", gres_used: "", features: "", alloc_tres: "", cfg_tres: "", boot_time: "", reason: "",
  ...over,
});
const job = (job_id: number, over: Partial<RawJob> = {}): RawJob => ({
  job_id, user_name: `user${job_id}`, account: "", partition: "GPU-1", job_state: "PENDING", state_reason: "Priority",
  node_count: 1, cpus: 26, gpus: 1, tres_req_str: "", container: "", submit_time: 0, end_time: "", start_est: "",
  time_left: "", name: "", qos: "", nodelist: "", time_used: "", time_limit: "1-00:00:00", min_memory_mb: 255_970,
  priority: 1000 - job_id, ...over,
});
const snapOf = (nodes: RawNode[], jobs: RawJob[], policies: Record<string, object> = {}): QueueInput => ({
  nodes, jobs, generated_at: 1_791_276_000,
  pools: [{ id: "a40", kind: "gpu", gpu: { type: "nvidia_a40" } }, { id: "a100", kind: "gpu", gpu: { type: "nvidia_a100" } }] as never,
  part_pool: { "GPU-1": "a40", "GPU-S": "a40", "GPU-1A": "a100" },
  policy: { partition_caps: { "GPU-1": { wall: "7d" }, "GPU-1A": { wall: "7d" } }, partition_policies: policies } as never,
});
const claimed = (s: QueueInput) => [...queueModel(s).claims.entries()].map(([n, c]) => `${n}:${c.gpus}`);
const claimedGpus = (s: QueueInput) => [...queueModel(s).claims.values()].reduce((sum, c) => sum + c.gpus, 0);
const running = (user: string, partition = "GPU-1") => job(9000, { user_name: user, partition, job_state: "RUNNING" });

describe("queue claims (one rule each)", () => {
  const two = [node("g02"), node("g03")];

  it("lets one waiter claim one GPU, not every node it could use", () => {
    // two dead jobs in front of nine idle A40s once read "all 15 GPUs queue" (2026-10-01)
    expect(claimed(snapOf(two, [job(1)]))).toEqual(["g02:1"]);
    expect(claimedGpus(snapOf(two, [job(1), job(2), job(3)]))).toBe(3);
  });

  it("claims nothing for a waiter whose required host is full", () => {
    const full = node("g01", { gres_used: "gpu:nvidia_a40:2", alloc_cpus: 52 });
    expect(claimed(snapOf([full, ...two], [job(1, { req_nodes: "g01" })]))).toEqual([]);
  });

  it("puts a pinned waiter on its required host and honours exclusions", () => {
    expect(claimed(snapOf(two, [job(1, { req_nodes: "g03" })]))).toEqual(["g03:1"]);
    expect(claimed(snapOf(two, [job(1, { exc_nodes: "g02" })]))).toEqual(["g03:1"]);
  });

  it("uses up the owner's MaxJobsPerUser and the GrpJobs slots as it places", () => {
    const pol = { "GPU-1": { maxJobsPerUser: 2, grpJobs: 3 } };
    // u has one running: one more of its three waiters can start
    expect(claimed(snapOf(two, [running("u"), job(1, { user_name: "u" }), job(2, { user_name: "u" }), job(3, { user_name: "u" })], pol)))
      .toEqual(["g02:1"]);
    // two slots left in the group: the third waiter gets none
    expect(claimedGpus(snapOf(two, [running("x"), job(1), job(2), job(3)], pol))).toBe(2);
  });

  it("does not count a 'Priority' waiter behind a full cap (Reason lags the cap)", () => {
    const pol = { "GPU-1": { grpJobs: 1 } };
    const w = queueModel(snapOf(two, [running("x"), job(1)], pol)).waiters[0];
    expect(w.kind).toBe("group-cap");
  });

  it("starts a waiter in the next partition of its list when the first is capped", () => {
    const a100 = node("a1", { pool: "a100", partitions: ["GPU-1A"], gres: "gpu:nvidia_a100:2" });
    const pol = { "GPU-1": { grpJobs: 1 } };
    expect(claimed(snapOf([...two, a100], [running("x"), job(1, { partition: "GPU-1,GPU-1A" })], pol))).toEqual(["a1:1"]);
  });

  it("drops a waiter older than the longest time limit on its nodes", () => {
    const old = job(1, { submit_time: 1_791_276_000 - 8 * 86_400 });
    expect(queueModel(snapOf(two, [old])).waiters[0].kind).toBe("stuck");
    expect(claimed(snapOf(two, [old]))).toEqual([]);
  });
});

describe("reasons against bookings", () => {
  const two = [node("g02"), node("g03")];
  const later = new Date(1_791_276_000_000 + 6 * 3600_000).toISOString();

  it("puts a booked job in line whatever QoS or partition reason it shows", () => {
    // the reason may be GPU-S's wall limit while Slurm runs it through GPU-1
    const wall = { partition: "GPU-1,GPU-S", state_reason: "QOSMaxWallDurationPerJobLimit" };
    expect(queueModel(snapOf(two, [job(1, { ...wall, sched_nodes: "g02", start_est: later })])).waiters[0].kind).toBe("next");
    expect(queueModel(snapOf(two, [job(1, wall)])).waiters[0].kind).toBe("never");
  });

  it("believes a whole-job limit even when Slurm has booked the job", () => {
    for (const reason of ["Licenses", "AssocGrpGRES", "JobArrayTaskLimit"]) {
      const s = snapOf(two, [job(1, { state_reason: reason, sched_nodes: "g02", start_est: later })]);
      expect(queueModel(s).waiters[0].kind).toBe("limit");
      expect(claimed(s)).toEqual([]);
    }
  });

  it("drops the booking of a waiter that starts now", () => {
    const s = snapOf(two, [job(1, { sched_nodes: "g03", start_est: later })]);
    expect(claimed(s)).toEqual(["g02:1"]);
    expect(queueModel(s).bookings.size).toBe(0);
  });

  it("reads bookings again once the cluster's zone arrives", () => {
    // three GPUs fit no node now, so the booking stands
    const s = snapOf(two, [job(1, { gpus: 3, sched_nodes: "g03", start_est: "2026-10-07T12:00:00" })]);
    const site = getSite();
    try {
      applySite({ ...site, time_zone: "Asia/Tokyo" });
      expect(queueModel(s).bookings.get("g03")).toEqual([Date.parse("2026-10-07T12:00:00+09:00")]);
      applySite({ ...site, time_zone: "America/New_York" });
      expect(queueModel(s).bookings.get("g03")).toEqual([Date.parse("2026-10-07T12:00:00-04:00")]);
    } finally {
      applySite(site);
    }
  });
});

describe("where a waiter starts, and what it takes", () => {
  const a40 = node("g02");
  const a100 = node("a1", { pool: "a100", partitions: ["GPU-1A"], gres: "gpu:nvidia_a100:2" });

  it("counts a waiter that starts in another pool out of this one's queue", () => {
    const s = snapOf([a40, a100], [job(1, { partition: "GPU-1A,GPU-1" })]);
    expect(claimed(s)).toEqual(["a1:1"]);
    expect(poolContenders(s, "a100").map((w) => w.job.job_id)).toEqual([1]);
    expect(poolContenders(s, "a40")).toEqual([]);
    // with no room in either pool it waits for both
    const full = { gres_used: "gpu:nvidia_a40:2" };
    const none = snapOf([node("g02", full), node("a1", { ...full, pool: "a100", partitions: ["GPU-1A"], gres: "gpu:nvidia_a100:2", gres_used: "gpu:nvidia_a100:2" })],
      [job(1, { partition: "GPU-1A,GPU-1" })]);
    expect([poolContenders(none, "a100").length, poolContenders(none, "a40").length]).toEqual([1, 1]);
  });

  it("starts a job that names its GPU type only on that type", () => {
    const s = snapOf([a40, a100], [job(1, { partition: "GPU-1A,GPU-1", gpu_type: "nvidia_a40" })]);
    expect(claimed(s)).toEqual(["g02:1"]);
  });

  it("uses up the group slots a new job would need", () => {
    const pol = { "GPU-1": { grpJobs: 2 } };
    const q = queueModel(snapOf([node("g02")], [running("x"), job(1)], pol));
    expect([q.running("GPU-1"), q.slotsLeft("GPU-1"), q.groupFull("GPU-1")]).toEqual([1, 0, true]);
  });
});

describe("a CPU job over several nodes", () => {
  const cpu = (name: string, free: number) =>
    node(name, { pool: "cpu", partitions: ["SMALL"], gres: "", cpus: 256, alloc_cpus: 256 - free, real_memory: 1_500_000 });
  const cores = (s: QueueInput) => [...queueModel(s).claims.entries()].map(([n, c]) => `${n}:${c.cores}:${c.memMb}`);
  const small = (over: Partial<RawJob> = {}) =>
    job(1, { partition: "SMALL", node_count: 2, cpus: 48, gpus: 0, min_memory_mb: 48_000, ...over });

  it("spreads its tasks over the cores the nodes have, not an equal share each", () => {
    // 24 + 24 fits neither 16-core node; Slurm starts it as 32 + 16
    expect(cores(snapOf([cpu("c1", 16), cpu("c2", 32)], [small()]))).toEqual(["c2:32:32000", "c1:16:16000"]);
  });

  it("starts only when its nodes hold all its cores, one per node at least", () => {
    expect(cores(snapOf([cpu("c1", 16), cpu("c2", 16)], [small()]))).toEqual([]);
    expect(cores(snapOf([cpu("c1", 64)], [small()]))).toEqual([]);
  });
});

describe("reasonKind", () => {
  it("believes reasons that hold the whole job, and counts the caps itself", () => {
    expect(reasonKind("DependencyNeverSatisfied")).toBe("never");
    expect(reasonKind("QOSMaxCpuPerJobLimit")).toBe("never");
    expect(reasonKind("JobHeldAdmin")).toBe("held");
    expect(reasonKind("AssocGrpGRES")).toBe("limit");
    expect(reasonKind("QOSGrpJobsLimit")).toBeNull();
    expect(reasonKind("QOSMaxJobsPerUserLimit")).toBeNull();
    expect(reasonKind("Nodes required for job are DOWN, DRAINED or reserved for jobs in higher priority partitions")).toBeNull();
  });
});

describe("turnOrder (GPU-1 queue, squeue on 2026-10-05)", () => {
  it("booked starts first, then priority; cap- and limit-held after; never-start last", () => {
    const pending = (job_id: number, state_reason: string, priority: number, start_est = "") =>
      job(job_id, { state_reason, priority, start_est, sched_nodes: start_est ? "g02" : "" });
    const s = snapOf([node("g02")], [
      pending(756866, "QOSMaxJobsPerUserLimit", 25222), pending(756864, "QOSMaxJobsPerUserLimit", 25222),
      pending(778827, "Resources", 22691, "2026-10-06T12:15:42"), pending(507503, "Dependency", 21926),
      pending(507501, "DependencyNeverSatisfied", 21926), pending(778799, "Priority", 20984, "2026-10-07T02:20:41"),
      pending(778900, "Priority", 21500), pending(668942, "JobHeldAdmin", 30000),
      running("user756866"), running("user756864"),
    ], { "GPU-1": { maxJobsPerUser: 1 } });
    expect(turnOrder(queueModel(s).waiters).map((w) => w.job.job_id)).toEqual([
      778827, 778799, 778900,   // what Slurm starts next: by booked start, then priority
      756864, 756866, 507503,   // held by a cap or a dependency
      668942, 507501,           // never start on their own (priority decides between them)
    ]);
  });
});
