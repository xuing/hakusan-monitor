/**
 * Real hakusan records behind the top-users tests.
 *
 * Every job and pool here is copied from one live snapshot, not invented, so
 * a failing test means the ranking rules changed — never that the fixture
 * drifted from the cluster. The one derived case says which real record it
 * starts from and the single fact it changes.
 *
 * Capture: 2026-10-05 ~16:37 JST, GET 127.0.0.1:8787/api/snapshot
 * (generated_at 1791188227). Pools and part_pool are verbatim; jobs keep the fields
 * the derivation reads (user, partition, state, cpus, gpus, min_memory_mb,
 * node_count, nodelist). Node rows are generated from each pool's measured
 * shape — every node in a pool had the same cores / RealMemory / gres that
 * minute — so memory totals match the live cluster exactly.
 */
import type { Pool, RawJob, RawNode, Snapshot } from "@/types/snapshot";

export const CAPTURED_AT = "2026-10-05T16:37:07+09:00";

// ---------------------------------------------------------------------------
// Pools, verbatim from snap.pools (the fields the derivation and card read)
// ---------------------------------------------------------------------------

const pool = (p: Partial<Pool> & Pick<Pool, "id" | "kind" | "nodes" | "mem_per_node" | "cores" | "gpu" | "partitions" | "queue">): Pool => ({
  nodes_state: {},
  idle_nodes: 0,
  available_nodes: 0,
  down_nodes: 0,
  cpus_total: p.cores.total,
  cpus_alloc: p.cores.alloc,
  util: p.cores.util,
  avail: { units: 0, unit: p.gpu ? "gpu" : "cores", can_now: false, idle_nodes: 0 },
  ...p,
});

export const POOL_A40 = pool({
  id: "a40", kind: "gpu", nodes: 20, mem_per_node: 515306,
  cores: { total: 1040, alloc: 692, free: 208, unavailable: 140, util: 0.665 },
  gpu: { type: "nvidia_a40", label: "A40", mem_gb: 48, total: 40, used: 40, down: 0, reserved: 0, free: 0, maint: false, util: 1.0, next_free: null },
  partitions: ["GPU-1", "GPU-L", "GPU-S"],
  queue: { running: 38, pending: 51, releasing: { jobs: 0, nodes: 0 } },
});

export const POOL_A100 = pool({
  id: "a100", kind: "gpu", nodes: 10, mem_per_node: 515306,
  cores: { total: 520, alloc: 376, free: 68, unavailable: 76, util: 0.723 },
  gpu: { type: "nvidia_a100", label: "A100", mem_gb: 40, total: 20, used: 20, down: 0, reserved: 0, free: 0, maint: false, util: 1.0, next_free: null },
  partitions: ["GPU-1A", "GPU-LA"],
  queue: { running: 20, pending: 42, releasing: { jobs: 0, nodes: 0 } },
});

export const POOL_H100_80 = pool({
  id: "h100-80", kind: "gpu", nodes: 4, mem_per_node: 469070,
  cores: { total: 128, alloc: 88, free: 0, unavailable: 40, util: 0.688 },
  gpu: { type: "h100-80c", label: "H100 80GB", mem_gb: 80, total: 4, used: 3, down: 1, reserved: 0, free: 0, maint: false, util: 0.75, next_free: null },
  partitions: ["VM-GPU-L"],
  queue: { running: 3, pending: 6, releasing: { jobs: 0, nodes: 0 } },
});

export const POOL_H100_20C = pool({
  id: "h100-20c", kind: "gpu", nodes: 16, mem_per_node: 114000,
  cores: { total: 128, alloc: 0, free: 0, unavailable: 128, util: 0.0 },
  gpu: { type: "h100-20c", label: "H100 MIG 20GB", mem_gb: 20, total: 16, used: 0, down: 16, reserved: 0, free: 0, maint: true, util: 0.0, next_free: null },
  partitions: [],
  queue: { running: 0, pending: 0, releasing: { jobs: 0, nodes: 0 } },
});

export const POOL_CPU = pool({
  id: "cpu", kind: "cpu", nodes: 124, mem_per_node: 1543224,
  cores: { total: 31744, alloc: 30087, free: 1465, unavailable: 192, util: 0.948 },
  gpu: null,
  partitions: ["DEF", "LARGE", "LONG", "LONG-L", "MS_Amorphous", "MS_Castep", "MS_Compass", "MS_Dftbplus", "MS_Dmol3", "MS_Forcite", "MatStudio", "SINGLE", "SMALL", "TINY", "X2LARGE", "XLARGE"],
  queue: { running: 374, pending: 220, releasing: { jobs: 0, nodes: 0 } },
});

export const POOL_VM_CPU = pool({
  id: "vm-cpu", kind: "cpu", nodes: 44, mem_per_node: 469070,
  cores: { total: 1408, alloc: 32, free: 1376, unavailable: 0, util: 0.023 },
  gpu: null,
  partitions: ["VM-CPU"],
  queue: { running: 1, pending: 1, releasing: { jobs: 0, nodes: 0 } },
});

export const POOL_LM = pool({
  id: "lm", kind: "cpu", nodes: 1, mem_per_node: 3754178,
  cores: { total: 96, alloc: 0, free: 96, unavailable: 0, util: 0.0 },
  gpu: null,
  partitions: ["VM-LM"],
  queue: { running: 0, pending: 0, releasing: { jobs: 0, nodes: 0 } },
});

/** snap.part_pool, verbatim. */
export const PART_POOL: Record<string, string> = {
  "DEF": "cpu",
  "TINY": "cpu",
  "SINGLE": "cpu",
  "SMALL": "cpu",
  "LARGE": "cpu",
  "XLARGE": "cpu",
  "LONG": "cpu",
  "LONG-L": "cpu",
  "MS_Castep": "cpu",
  "MS_Dmol3": "cpu",
  "MS_Forcite": "cpu",
  "MS_Compass": "cpu",
  "MS_Dftbplus": "cpu",
  "MS_Amorphous": "cpu",
  "MatStudio": "cpu",
  "X2LARGE": "cpu",
  "GPU-1": "a40",
  "GPU-S": "a40",
  "GPU-L": "a40",
  "GPU-1A": "a100",
  "GPU-LA": "a100",
  "VM-CPU": "vm-cpu",
  "VM-GPU-L": "h100-80",
  "VM-LM": "lm",
};

// ---------------------------------------------------------------------------
// Nodes: generated from the measured per-pool shape (count × cores × MB × gres)
// ---------------------------------------------------------------------------

function nodes(pool: string, prefix: string, count: number, cpus: number, realMemory: number, gres: string, width = 3): RawNode[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}${String(i + 1).padStart(width, "0")}`,
    pool,
    state_bucket: "allocated",
    schedulable: false,
    state: ["ALLOCATED"],
    partitions: [],
    cpus,
    alloc_cpus: cpus,
    cpu_load: "0.00",
    real_memory: realMemory,
    alloc_memory: realMemory,
    free_mem: 0,
    gres,
    gres_used: gres,
    features: "",
    alloc_tres: "",
    cfg_tres: "",
    boot_time: "",
    reason: "",
  }));
}

/** 20 × 52 cores × 515306 MB, gpu:nvidia_a40:2(S:0-1) (spcc-a40g01 … spcc-a40g20) */
export const NODES_A40 = nodes("a40", "spcc-a40g", 20, 52, 515306, "gpu:nvidia_a40:2(S:0-1)", 2);
/** 10 × 52 cores × 515306 MB, gpu:nvidia_a100:2(S:0-1) (spcc-a100g01 … spcc-a100g10) */
export const NODES_A100 = nodes("a100", "spcc-a100g", 10, 52, 515306, "gpu:nvidia_a100:2(S:0-1)", 2);
/** 4 × 32 cores × 469070 MB, gpu:h100-80c:1 (spcc-cld-gl01 … spcc-cld-gl04) */
export const NODES_H100_80 = nodes("h100-80", "spcc-cld-gl", 4, 32, 469070, "gpu:h100-80c:1", 2);
/** 16 × 8 cores × 114000 MB, gpu:h100-20c:1 (spcc-cld-g01 … spcc-cld-g16) */
export const NODES_H100_20C = nodes("h100-20c", "spcc-cld-g", 16, 8, 114000, "gpu:h100-20c:1", 2);
/** 124 × 256 cores × 1543224 MB (lcpcc-001 … lcpcc-124) */
export const NODES_CPU = nodes("cpu", "lcpcc-", 124, 256, 1543224, "", 3);
/** 44 × 32 cores × 469070 MB (spcc-cld-05 … spcc-cld-52) */
export const NODES_VM_CPU = nodes("vm-cpu", "spcc-cld-", 44, 32, 469070, "", 2);
/** 1 × 96 cores × 3754178 MB (spcc-cld-lm01 … spcc-cld-lm01) */
export const NODES_LM = nodes("lm", "spcc-cld-lm", 1, 96, 3754178, "", 2);

export const ALL_NODES: RawNode[] = [...NODES_A40, ...NODES_A100, ...NODES_H100_80, ...NODES_H100_20C, ...NODES_CPU, ...NODES_VM_CPU, ...NODES_LM];

// ---------------------------------------------------------------------------
// Jobs, verbatim from snap.jobs
// ---------------------------------------------------------------------------

function job(
  job_id: number | string,
  user_name: string,
  partition: string,
  job_state: string,
  cpus: number,
  gpus: number,
  min_memory_mb: number,
  node_count: number,
  nodelist: string,
): RawJob {
  return {
    job_id,
    user_name,
    account: "",
    partition,
    job_state,
    state_reason: job_state === "PENDING" ? "Priority" : "None",
    node_count,
    cpus,
    gpus,
    gpu_type: "",
    tres_req_str: gpus ? `gres/gpu=${gpus}` : "",
    min_memory: `${min_memory_mb}M`,
    min_memory_mb,
    container: "",
    submit_time: 0,
    end_time: "",
    start_est: "",
    time_left: "",
    name: "",
    qos: "normal",
    nodelist,
    time_used: "",
    time_limit: "",
  };
}

/** Every running job on the A40 pool that minute: 38 jobs, 40 of 40 GPUs in use. */
export const A40_RUNNING: RawJob[] = [
  job(756860, "s2410439", "GPU-1", "RUNNING", 26, 1, 255970, 1, "spcc-a40g03"),
  job(756859, "s2410439", "GPU-1", "RUNNING", 26, 1, 255970, 1, "spcc-a40g16"),
  job(756858, "s2410439", "GPU-1", "RUNNING", 26, 1, 255970, 1, "spcc-a40g02"),
  job(756861, "s2410439", "GPU-1", "RUNNING", 26, 1, 255970, 1, "spcc-a40g10"),
  job(776489, "phuongnm", "GPU-1", "RUNNING", 26, 1, 255970, 1, "spcc-a40g05"),
  job(776490, "phuongnm", "GPU-1", "RUNNING", 26, 1, 255970, 1, "spcc-a40g06"),
  job(776491, "phuongnm", "GPU-1", "RUNNING", 26, 1, 255970, 1, "spcc-a40g06"),
  job(759480, "phuongnm", "GPU-1", "RUNNING", 26, 1, 255970, 1, "spcc-a40g05"),
  job(758233, "s2510439", "GPU-1", "RUNNING", 7, 1, 65536, 1, "spcc-a40g08"),
  job(777903, "s2610205", "GPU-1", "RUNNING", 12, 1, 98304, 1, "spcc-a40g07"),
  job(777904, "s2610205", "GPU-1", "RUNNING", 12, 1, 98304, 1, "spcc-a40g09"),
  job(775347, "s2510460", "GPU-1", "RUNNING", 14, 1, 128000, 1, "spcc-a40g01"),
  job(775348, "s2510460", "GPU-1", "RUNNING", 14, 1, 128000, 1, "spcc-a40g13"),
  job(775349, "s2510460", "GPU-1", "RUNNING", 14, 1, 128000, 1, "spcc-a40g15"),
  job(775350, "s2510460", "GPU-1", "RUNNING", 14, 1, 128000, 1, "spcc-a40g16"),
  job(777902, "s2610205", "GPU-1", "RUNNING", 12, 1, 98304, 1, "spcc-a40g17"),
  job(777901, "s2610205", "GPU-1", "RUNNING", 12, 1, 98304, 1, "spcc-a40g11"),
  job(761548, "s2510439", "GPU-1", "RUNNING", 7, 1, 65536, 1, "spcc-a40g09"),
  job(772145, "s2510439", "GPU-1", "RUNNING", 7, 1, 65536, 1, "spcc-a40g11"),
  job(777560, "s2120038", "GPU-1", "RUNNING", 16, 1, 65536, 1, "spcc-a40g18"),
  job(777557, "s2120038", "GPU-1", "RUNNING", 16, 1, 65536, 1, "spcc-a40g04"),
  job(777558, "s2120038", "GPU-1", "RUNNING", 16, 1, 65536, 1, "spcc-a40g04"),
  job(777559, "s2120038", "GPU-1", "RUNNING", 16, 1, 65536, 1, "spcc-a40g18"),
  job(769129, "s2510444", "GPU-1", "RUNNING", 26, 1, 131072, 1, "spcc-a40g14"),
  job(769130, "s2510444", "GPU-1", "RUNNING", 26, 1, 131072, 1, "spcc-a40g14"),
  job(769131, "s2510444", "GPU-1", "RUNNING", 26, 1, 131072, 1, "spcc-a40g15"),
  job(767607, "s2510444", "GPU-1", "RUNNING", 26, 1, 131072, 1, "spcc-a40g12"),
  job(777563, "s2120038", "GPU-L", "RUNNING", 16, 1, 65536, 1, "spcc-a40g07"),
  job(756870, "s2410439", "GPU-S", "RUNNING", 26, 1, 255970, 1, "spcc-a40g01"),
  job(756871, "s2410439", "GPU-S", "RUNNING", 26, 1, 255970, 1, "spcc-a40g03"),
  job(776867, "s2410431", "GPU-S", "RUNNING", 26, 2, 65536, 1, "spcc-a40g19"),
  job(777232, "s2410431", "GPU-S", "RUNNING", 26, 2, 65536, 1, "spcc-a40g20"),
  job(777905, "s2610205", "GPU-S", "RUNNING", 12, 1, 98304, 1, "spcc-a40g10"),
  job(777192, "s2420411", "GPU-S", "RUNNING", 1, 1, 9845, 1, "spcc-a40g08"),
  job(775351, "s2510460", "GPU-S", "RUNNING", 14, 1, 128000, 1, "spcc-a40g17"),
  job(778211, "s2610205", "GPU-S", "RUNNING", 12, 1, 98304, 1, "spcc-a40g12"),
  job(777562, "s2120038", "GPU-S", "RUNNING", 16, 1, 65536, 1, "spcc-a40g13"),
  job(777561, "s2120038", "GPU-S", "RUNNING", 16, 1, 65536, 1, "spcc-a40g02"),
];

/** A40 waiters of three users: two who also run there (s2410439, s2610205) and one who only waits (s2510457). */
export const A40_PENDING: RawJob[] = [
  job(756866, "s2410439", "GPU-1", "PENDING", 26, 1, 255970, 1, ""),
  job(756864, "s2410439", "GPU-1", "PENDING", 26, 1, 255970, 1, ""),
  job(756863, "s2410439", "GPU-1", "PENDING", 26, 1, 255970, 1, ""),
  job(756862, "s2410439", "GPU-1", "PENDING", 26, 1, 255970, 1, ""),
  job(778216, "s2610205", "GPU-1", "PENDING", 20, 1, 196608, 1, ""),
  job(778522, "s2610205", "GPU-1,GPU-1A,GPU-S", "PENDING", 12, 1, 98304, 1, ""),
  job(778957, "s2610205", "GPU-1,GPU-1A,GPU-S", "PENDING", 12, 1, 98304, 1, ""),
  job(778958, "s2610205", "GPU-1,GPU-1A,GPU-S", "PENDING", 12, 1, 98304, 1, ""),
  job(778213, "s2610205", "GPU-1,GPU-S", "PENDING", 12, 1, 98304, 1, ""),
  job(778214, "s2610205", "GPU-1,GPU-S", "PENDING", 12, 1, 98304, 1, ""),
  job(778212, "s2610205", "GPU-1,GPU-S", "PENDING", 12, 1, 98304, 1, ""),
  job(777911, "s2610205", "GPU-1,GPU-S", "PENDING", 12, 1, 98304, 1, ""),
  job(777910, "s2610205", "GPU-1,GPU-S", "PENDING", 12, 1, 98304, 1, ""),
  job(777909, "s2610205", "GPU-1,GPU-S", "PENDING", 12, 1, 98304, 1, ""),
  job(777908, "s2610205", "GPU-1,GPU-S", "PENDING", 12, 1, 98304, 1, ""),
  job(777907, "s2610205", "GPU-1,GPU-S", "PENDING", 12, 1, 98304, 1, ""),
  job(777906, "s2610205", "GPU-1,GPU-S", "PENDING", 12, 1, 98304, 1, ""),
  job(777900, "s2610205", "GPU-1,GPU-S", "PENDING", 8, 1, 65536, 1, ""),
  job(778506, "s2510457", "GPU-1,GPU-S,GPU-1A", "PENDING", 7, 1, 65536, 1, ""),
  job(778507, "s2510457", "GPU-1,GPU-S,GPU-1A", "PENDING", 7, 1, 65536, 1, ""),
  job(778508, "s2510457", "GPU-1,GPU-S,GPU-1A", "PENDING", 7, 1, 65536, 1, ""),
  job(778509, "s2510457", "GPU-1,GPU-S,GPU-1A", "PENDING", 7, 1, 65536, 1, ""),
  job(778510, "s2510457", "GPU-1,GPU-S,GPU-1A", "PENDING", 7, 1, 65536, 1, ""),
  job(778511, "s2510457", "GPU-1,GPU-S,GPU-1A", "PENDING", 7, 1, 65536, 1, ""),
  job(778519, "s2510457", "GPU-1,GPU-S,GPU-1A", "PENDING", 7, 1, 65536, 1, ""),
  job(778524, "s2510457", "GPU-1,GPU-S,GPU-1A", "PENDING", 7, 1, 65536, 1, ""),
  job(778734, "s2510457", "GPU-1,GPU-S,GPU-1A", "PENDING", 7, 1, 65536, 1, ""),
  job(778968, "s2510457", "GPU-1,GPU-S,GPU-1A", "PENDING", 7, 1, 65536, 1, ""),
  job(778505, "s2510457", "GPU-1,GPU-S,GPU-1A", "PENDING", 7, 1, 65536, 1, ""),
  job(778503, "s2510457", "GPU-1,GPU-S,GPU-1A", "PENDING", 7, 1, 65536, 1, ""),
  job(778504, "s2510457", "GPU-1,GPU-S,GPU-1A", "PENDING", 7, 1, 65536, 1, ""),
  job(778502, "s2510457", "GPU-1,GPU-S,GPU-1A", "PENDING", 7, 1, 65536, 1, ""),
  job(778799, "s2610205", "GPU-L", "PENDING", 12, 1, 65536, 1, ""),
  job(756876, "s2410439", "GPU-S", "PENDING", 26, 1, 255970, 1, ""),
  job(756875, "s2410439", "GPU-S", "PENDING", 26, 1, 255970, 1, ""),
  job(756873, "s2410439", "GPU-S", "PENDING", 26, 1, 255970, 1, ""),
  job(756872, "s2410439", "GPU-S", "PENDING", 26, 1, 255970, 1, ""),
];

/** The three H100 jobs: one GPU and one node each, equal GPU shares, unequal cores and memory. */
export const H100_80_RUNNING: RawJob[] = [
  job(760600, "s2320019", "VM-GPU-L", "RUNNING", 24, 1, 262144, 1, "spcc-cld-gl01"),
  job(760659, "s2420424", "VM-GPU-L", "RUNNING", 32, 1, 468992, 1, "spcc-cld-gl04"),
  job(772798, "s2410212", "VM-GPU-L", "RUNNING", 32, 1, 438272, 1, "spcc-cld-gl03"),
];

/** The only VM-CPU job. */
export const VM_CPU_RUNNING: RawJob[] = [
  job(755103, "s2510166", "VM-CPU", "RUNNING", 32, 0, 468992, 1, "spcc-cld-05"),
];

/** Ten of the 374 lcpcc jobs, six users: hongo's three widest, s2516105's two widest MPI jobs, and small jobs down to 2 cores (two of them array tasks). */
export const CPU_RUNNING: RawJob[] = [
  job(737003, "hongo", "XLARGE", "RUNNING", 4096, 0, 24576000, 16, "lcpcc-[001,012-013,022,026,034,042,044,048,077,079,088-089,118-119,121]"),
  job(776006, "hongo", "SINGLE", "RUNNING", 256, 0, 1536000, 1, "lcpcc-078"),
  job(776000, "hongo", "SINGLE", "RUNNING", 256, 0, 1536000, 1, "lcpcc-019"),
  job(776063, "s2516105", "SMALL", "RUNNING", 256, 0, 1536000, 18, "lcpcc-[003,005-006,008-009,015,018,021,024,027-028,030,032-033,040,047,050,124]"),
  job(776061, "s2516105", "SMALL", "RUNNING", 256, 0, 1536000, 8, "lcpcc-[052,054-055,062,064,066-068]"),
  job(754785, "reno-h", "DEF", "RUNNING", 64, 0, 384000, 1, "lcpcc-021"),
  job("776215_0", "s2430412", "DEF", "RUNNING", 2, 0, 8192, 1, "lcpcc-002"),
  job("776215_1", "s2430412", "DEF", "RUNNING", 2, 0, 8192, 1, "lcpcc-002"),
  job(777850, "biovia", "MatStudio", "RUNNING", 2, 0, 12000, 1, "lcpcc-002"),
  job(777144, "s2510033", "DEF", "RUNNING", 16, 0, 96000, 1, "lcpcc-003"),
];

/** Two of hongo's 38 waiting lcpcc jobs. */
export const CPU_PENDING: RawJob[] = [
  job(778921, "hongo", "DEF", "PENDING", 32, 0, 192000, 1, ""),
  job(778920, "hongo", "DEF", "PENDING", 32, 0, 192000, 1, ""),
];

/** Derived case: biovia's real 2-core job with min_memory_mb set to the
 *  node's RealMemory (1543224 MB, lcpcc-002) — the one change — so memory,
 *  not cores, is what it takes from the pool. */
export const CPU_MEMORY_HOG: RawJob = { ...CPU_RUNNING.find((j) => j.user_name === "biovia")!, min_memory_mb: 1543224, min_memory: "1543224M" };

/** A snapshot shell around the fixture pools, nodes and the given jobs. */
export function snapshotWith(jobs: RawJob[], nodes: RawNode[] = ALL_NODES): Snapshot {
  return {
    pools: [POOL_A40, POOL_A100, POOL_H100_80, POOL_H100_20C, POOL_CPU, POOL_VM_CPU, POOL_LM],
    part_pool: PART_POOL,
    jobs,
    nodes,
  } as unknown as Snapshot;
}
