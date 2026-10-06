import { describe, expect, it } from "vitest";
import { gpuStartCount, gpuStatus, gpuVerdict } from "./gpu-partition";
import { poolPick, poolTone } from "./pool-status";
import { POOLS, SNAPSHOT } from "./queue.fixtures";
import type { Partition, Pool, RawJob, RawNode, Snapshot } from "@/types/snapshot";

const AT = Date.parse("2026-10-06T22:44:00+09:00");

describe("GPU verdicts on the 22:44 capture", () => {
  const a40 = POOLS.find((p) => p.id === "a40")!;

  it("says a full group cap, and offers no --mem or -t way past it", () => {
    const s = gpuStatus(SNAPSHOT, a40, "GPU-S", {}, AT);
    expect(s.reason).toEqual({ kind: "group", running: 10, cap: 10 });
    expect([s.memTip, s.gapTip]).toEqual([null, null]);
    expect(gpuVerdict(s)).toBe("queue");
  });

  it("queues GPU-1 with no in-service node holding a free A40", () => {
    expect(gpuStatus(SNAPSHOT, a40, "GPU-1", {}, AT).reason).toEqual({ kind: "no-node" });
    expect(gpuStartCount(SNAPSHOT, a40, "GPU-1")).toBe(0);
  });

  it("colours the pool by the partition that does best", () => {
    expect(poolPick(SNAPSHOT, a40)?.partition).toBe("GPU-1");
    expect(poolTone(SNAPSHOT, a40)).toBe("bad");
  });
});

// ---- one rule each, on a two-node A40 pool ----------------------------------

const pool = {
  id: "a40", kind: "gpu", nodes: 2, mem_per_node: 515_306, down_nodes: 0, partitions: ["GPU-1"],
  cores: { total: 104, alloc: 0, free: 104 }, gpu: { type: "nvidia_a40", total: 4, used: 0, free: 4, down: 0, reserved: 0 },
} as unknown as Pool;

const node = (name: string, over: Partial<RawNode> = {}): RawNode => ({
  name, pool: "a40", state: ["IDLE"], state_bucket: "idle", schedulable: true, partitions: ["GPU-1"],
  cpus: 52, alloc_cpus: 0, cpu_load: "", real_memory: 515_306, alloc_memory: 0, free_mem: 0,
  gres: "gpu:nvidia_a40:2", gres_used: "", features: "", alloc_tres: "", cfg_tres: "", boot_time: "", reason: "",
  ...over,
});

const waiter = (job_id: number, over: Partial<RawJob> = {}): RawJob => ({
  job_id, user_name: `u${job_id}`, account: "", partition: "GPU-1", job_state: "PENDING", state_reason: "Priority",
  node_count: 1, cpus: 26, gpus: 1, tres_req_str: "", container: "", submit_time: 1_791_000_000, end_time: "",
  start_est: "", time_left: "", name: "", qos: "", nodelist: "", time_used: "", time_limit: "1-00:00:00",
  min_memory_mb: 255_970, priority: 100, ...over,
});

function snapOf(nodes: RawNode[], jobs: RawJob[] = [], part: Partial<Partition> = {}, grpJobs?: number): Snapshot {
  const partition = {
    name: "GPU-1", kind: "gpu", nodes: nodes.length, pool: "a40", jobs: { running: 0, pending: 0 },
    nodes_state: { idle: nodes.length }, available_nodes: nodes.length,
    gpu: { total: 4, used: 0, free: 4, down: 0, reserved: 0 }, spec: { cores_per_node: 52, mem_per_node: 515_306, gpu_per_node: 2 },
    ...part,
  } as unknown as Partition;
  return {
    nodes, jobs, pools: [pool], partitions: [partition], part_pool: { "GPU-1": "a40" }, generated_at: 1_791_200_000,
    licenses: [], cpu_submit_probes: [],
    policy: {
      partition_caps: { "GPU-1": { maxGpus: 1, maxCores: 26, maxMemGb: 256, maxNodes: 1, wall: "7d" } },
      partition_policies: { "GPU-1": grpJobs ? { grpJobs } : {} },
      partition_defaults: { "GPU-1": { cores: 26, gpus_per_node: 1, def_mem_per_cpu_mb: 9845, interactive_time_min: 720 } },
    },
  } as unknown as Snapshot;
}

describe("gpuStatus: one precedence for every page", () => {
  it("starts in a slot the queue leaves", () => {
    const s = gpuStatus(snapOf([node("g1"), node("g2")], [waiter(1), waiter(2), waiter(3)]), pool, "GPU-1", {}, AT);
    expect(s.now).toBe("clear");
    expect(gpuVerdict(s)).toBe("now");
  });

  it("queues once the waiters take every slot, and says how many are ahead", () => {
    const jobs = [1, 2, 3, 4].map((id) => waiter(id));
    expect(gpuStatus(snapOf([node("g1"), node("g2")], jobs), pool, "GPU-1", {}, AT).reason).toEqual({ kind: "ahead", n: 4, free: 4 });
  });

  it("puts a full group cap before anything the hardware says", () => {
    const running = waiter(9, { job_state: "RUNNING", nodelist: "elsewhere" });
    const s = gpuStatus(snapOf([node("g1")], [running], {}, 1), pool, "GPU-1", {}, AT);
    expect(s.reason?.kind).toBe("group");
    expect(gpuStartCount(snapOf([node("g1")], [running], {}, 1), pool, "GPU-1")).toBe(0);
  });

  it("calls a partition whose every node is drained maintenance", () => {
    const s = gpuStatus(snapOf([node("g1")], [], { nodes_state: { drain: 1 } }), pool, "GPU-1", {}, AT);
    expect(gpuVerdict(s)).toBe("maint");
  });

  it("offers --mem on a stranded GPU only while no waiter can take it", () => {
    // 26 cores free but 200 GB short of the 255 970 MB default
    const short = node("g1", { state: ["MIXED"], alloc_cpus: 26, alloc_memory: 315_306, gres_used: "gpu:nvidia_a40:1" });
    const free = snapOf([short], [], { available_nodes: 1, gpu: { total: 2, used: 1, free: 1, down: 0, reserved: 0 } } as never);
    expect(gpuVerdict(gpuStatus(free, pool, "GPU-1", {}, AT))).toBe("bypass");
    const contested = snapOf([short], [waiter(1, { min_memory_mb: 100_000 })], { available_nodes: 1, gpu: { total: 2, used: 1, free: 1, down: 0, reserved: 0 } } as never);
    expect(gpuStatus(contested, pool, "GPU-1", {}, AT).reason).toEqual({ kind: "contested", n: 1 });
  });

  it("starts inside a PLANNED node's gap when the request ends before the booking", () => {
    // Slurm holds idle g1 (IDLE+PLANNED) for a two-node job it booked 20 h
    // out, when busy g2 frees up: no in-service node is free, yet a job that
    // ends in time backfills on g1
    const planned = node("g1", { state: ["IDLE", "PLANNED"], state_bucket: "idle", schedulable: false });
    const busy = node("g2", { state: ["ALLOCATED"], state_bucket: "allocated", alloc_cpus: 52, alloc_memory: 515_306, gres_used: "gpu:nvidia_a40:2" });
    const booked = waiter(1, { sched_nodes: "g[1-2]", start_est: new Date(AT + 20 * 3600_000).toISOString(),
      node_count: 2, gpus: 4, cpus: 104, min_memory_mb: 1_023_880 });
    const held = { available_nodes: 0, gpu: { total: 4, used: 2, free: 0, down: 0, reserved: 2 } } as never;
    const s = (timeSec?: number) => gpuStatus(snapOf([planned, busy], [booked], held), pool, "GPU-1", { timeSec }, AT);
    expect(s().now).toBe("backfill");       // the 12 h interactive default fits
    expect(gpuVerdict(s())).toBe("now");
    expect(s(30 * 3600).now).toBeNull();    // a 30 h job does not
    expect(gpuVerdict(s(30 * 3600))).toBe("gap");
  });

  it("finds no gap where a waiter that starts now takes the free GPU", () => {
    // g1 has one GPU free and is booked 20 h out for a two-GPU job; a
    // one-GPU waiter starts on that GPU now, so nothing is left to backfill
    const g1 = node("g1", { state: ["MIXED"], gres_used: "gpu:nvidia_a40:1", alloc_cpus: 26, alloc_memory: 255_970 });
    const booked = waiter(1, { sched_nodes: "g1", start_est: new Date(AT + 20 * 3600_000).toISOString(), gpus: 2, cpus: 52, min_memory_mb: 511_940 });
    const one = { available_nodes: 1, gpu: { total: 2, used: 1, free: 1, down: 0, reserved: 0 } } as never;
    const alone = gpuStatus(snapOf([g1], [booked], one), pool, "GPU-1", {}, AT);
    expect(alone.now).toBe("clear");
    const taken = gpuStatus(snapOf([g1], [booked, waiter(2)], one), pool, "GPU-1", {}, AT);
    expect(taken.now).toBeNull();
    expect(taken.gapTip).toBeNull();
  });

  it("queues when the waiters that start now take the last group slots", () => {
    // GrpJobs 2: one running elsewhere, one waiter starts on g1 now
    const running = waiter(9, { job_state: "RUNNING", nodelist: "elsewhere" });
    const s = gpuStatus(snapOf([node("g1")], [running, waiter(1)], {}, 2), pool, "GPU-1", {}, AT);
    expect(s.reason).toEqual({ kind: "group", running: 1, cap: 2 });
  });
});
