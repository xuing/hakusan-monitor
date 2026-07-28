/**
 * Real hakusan records behind the GPU availability tests.
 *
 * Everything here was captured from the live cluster, not invented, so a test
 * failure means the rules changed — never that the fixture drifted from
 * reality. Provenance is recorded per record; the few derived cases say
 * exactly which real record they start from and what single fact was changed.
 *
 * Capture session: 2026-07-29 ~06:34 JST, hakusan2.
 *   snapshot           GET localhost:8787/api/snapshot   (nodes[], jobs[])
 *   partition config   scontrol show partition <NAME>
 *   request defaults   sbatch -H --parsable -p <NAME> --wrap 'sleep 1'
 *                      scontrol show job <ID>   # NumCPUs, MinMemoryCPU
 *                      scancel <ID>             # held jobs never run
 *   placement check    salloc -p VM-GPU-L bash -c 'scontrol show job $SLURM_JOB_ID'
 */
import type { GpuDefaultRequest } from "@/lib/gpu-availability";
import type { PartitionCap } from "@/lib/slurm";
import type { Pool, RawJob, RawNode } from "@/types/snapshot";

export const CAPTURED_AT = "2026-07-29T06:34:00+09:00";

// ---------------------------------------------------------------------------
// Measured request defaults. `scontrol show partition` gives DefMemPerCPU;
// the core count comes from the held-job probe above. These are the numbers
// backend/cluster_policy.py BUILTIN_PARTITION_DEFAULTS ships.
// ---------------------------------------------------------------------------

/** GPU-1: NumCPUs=26, MinMemoryCPU=9845M, TresPerNode=gres/gpu:1
 *  -> 26 x 9845 = 255970 MB, matching every default-shaped running job. */
export const REQUEST_GPU_1: GpuDefaultRequest = {
  partition: "GPU-1",
  cores: 26,
  memPerCoreMb: 9845,
  gpusPerNode: 1,
};

/** VM-GPU-L: NumCPUs=32, MinMemoryCPU=14900M, TresPerNode=gres/gpu:1
 *  -> 32 x 14900 = 476800 MB, which is MORE than a gl0x node's 469070 MB.
 *  Slurm answers by spreading the job over two nodes (observed placement:
 *  spcc-cld-gl[02-03]); it does not reject it. */
export const REQUEST_VM_GPU_L: GpuDefaultRequest = {
  partition: "VM-GPU-L",
  cores: 32,
  memPerCoreMb: 14900,
  gpusPerNode: 1,
};

/** GPU-1A, same plugin defaults as GPU-1. */
export const REQUEST_GPU_1A: GpuDefaultRequest = { ...REQUEST_GPU_1, partition: "GPU-1A" };

/** QoS MaxTRES, from `sacctmgr show qos`. The ceiling, never the default:
 *  gpu-1 = cpu=26,gres/gpu:nvidia_a40=1,mem=256G,node=1 */
export const CAP_GPU_1: PartitionCap = { maxGpus: 1, maxCores: 26, maxMemGb: 256, maxNodes: 1, wall: "7d" };
/** vm-gpu-l = cpu=32,gres/gpu:h100-80c=1,mem=480G */
export const CAP_VM_GPU_L: PartitionCap = { maxGpus: 1, maxCores: 32, maxMemGb: 480, maxNodes: 1, wall: "2d" };

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

export const POOL_H100 = { id: "h100-80", kind: "gpu", gpu: { type: "h100-80c" } } as Pool;
export const POOL_A40 = { id: "a40", kind: "gpu", gpu: { type: "nvidia_a40" } } as Pool;
export const POOL_A100 = { id: "a100", kind: "gpu", gpu: { type: "nvidia_a100" } } as Pool;

// ---------------------------------------------------------------------------
// Nodes, verbatim from the snapshot
// ---------------------------------------------------------------------------

function node(fields: Partial<RawNode> & Pick<RawNode, "name" | "pool" | "cpus" | "real_memory" | "gres">): RawNode {
  return {
    state: ["IDLE"],
    partitions: [],
    alloc_cpus: 0,
    cpu_load: "0.00",
    alloc_memory: 0,
    free_mem: 0,
    gres_used: "",
    features: "",
    alloc_tres: "",
    cfg_tres: "",
    boot_time: "",
    reason: "",
    state_bucket: "idle",
    schedulable: true,
    ...fields,
  } as RawNode;
}

/** spcc-cld-gl01 — the one busy H100 node: 1 GPU, all 32 cores and 428G taken. */
export const H100_ALLOCATED = node({
  name: "spcc-cld-gl01",
  pool: "h100-80",
  state: ["ALLOCATED"],
  partitions: ["VM-GPU-L"],
  cpus: 32,
  alloc_cpus: 32,
  real_memory: 469070,
  alloc_memory: 438272,
  gres: "gpu:h100-80c:1",
  gres_used: "gpu:h100-80c:1",
  alloc_tres: "cpu=32,mem=428G,gres/gpu:h100-80c=1",
  state_bucket: "allocated",
  schedulable: false,
});

/** spcc-cld-gl[02-04] — completely empty. These are the three GPUs the
 *  dashboard used to call "memory insufficient". */
export const H100_IDLE = ["spcc-cld-gl02", "spcc-cld-gl03", "spcc-cld-gl04"].map((name) =>
  node({
    name,
    pool: "h100-80",
    state: ["IDLE"],
    partitions: ["VM-GPU-L"],
    cpus: 32,
    real_memory: 469070,
    gres: "gpu:h100-80c:1",
  }),
);

export const NODES_H100 = [H100_ALLOCATED, ...H100_IDLE];

/** spcc-a40g15 — one GPU free, 26 cores and 309479 MB free (fits GPU-1's
 *  default exactly), but PLANNED: the scheduler holds it for job 499329. */
export const A40_PLANNED = node({
  name: "spcc-a40g15",
  pool: "a40",
  state: ["MIXED", "COMPLETING", "PLANNED"],
  partitions: ["GPU-1", "GPU-S", "GPU-L"],
  cpus: 52,
  alloc_cpus: 26,
  real_memory: 515306,
  alloc_memory: 255970,
  gres: "gpu:nvidia_a40:2(S:0-1)",
  gres_used: "gpu:nvidia_a40:1",
  alloc_tres: "cpu=26,mem=255970M,gres/gpu:nvidia_a40=1",
  state_bucket: "mixed",
  schedulable: false,
});

/** spcc-a40g09 — both GPUs busy, the ordinary "nothing here" node. */
export const A40_FULL = node({
  name: "spcc-a40g09",
  pool: "a40",
  state: ["ALLOCATED"],
  partitions: ["GPU-1", "GPU-S", "GPU-L"],
  cpus: 52,
  alloc_cpus: 52,
  real_memory: 515306,
  alloc_memory: 511940,
  gres: "gpu:nvidia_a40:2(S:0-1)",
  gres_used: "gpu:nvidia_a40:2",
  alloc_tres: "cpu=52,mem=511940M,gres/gpu:nvidia_a40=2",
  state_bucket: "allocated",
  schedulable: false,
});

/** spcc-a100g02 — one idle A100, but the node is DRAIN after a failed kill
 *  ("Kill task failed (JobId=493255"). Idle silicon, not capacity. */
export const A100_DRAIN = node({
  name: "spcc-a100g02",
  pool: "a100",
  state: ["MIXED", "COMPLETING", "DRAIN"],
  partitions: ["GPU-1A", "GPU-LA"],
  cpus: 52,
  alloc_cpus: 26,
  real_memory: 515306,
  alloc_memory: 255970,
  gres: "gpu:nvidia_a100:2(S:0-1)",
  gres_used: "gpu:nvidia_a100:1",
  alloc_tres: "cpu=26,mem=255970M,gres/gpu:nvidia_a100=1",
  reason: "Kill task failed (JobId=493255",
  state_bucket: "drain",
  schedulable: false,
});

// ---------------------------------------------------------------------------
// Derived nodes: a real record with exactly one fact changed, stated here.
// ---------------------------------------------------------------------------

/** spcc-a40g15's numbers with the PLANNED flag dropped — the state it enters
 *  the moment its reservation is filled. Free: 1 GPU, 26 cores, 259336 MB
 *  against a 255970 MB default request. */
export const A40_FREE_SLOT = node({
  ...A40_PLANNED,
  name: "spcc-a40g16",
  state: ["MIXED"],
  state_bucket: "mixed",
  schedulable: true,
});

/** Real shape, memory-starved sibling: a GPU-1 user takes one GPU at the
 *  policy maximum `--mem=256G` (262144 MB, exactly what pending job 500837
 *  asks for) on a 515306 MB A40 node. 253162 MB is left — 2808 MB short of
 *  the 255970 MB the next default request needs, with cores to spare. */
export const A40_MEM_SHORT = node({
  ...A40_FREE_SLOT,
  name: "spcc-a40g17",
  alloc_cpus: 26,
  alloc_memory: 262144,
  alloc_tres: "cpu=26,mem=262144M,gres/gpu:nvidia_a40=1",
});

/** Real shape, core-starved sibling: a GPU-S user takes one GPU with 40 of
 *  the node's 52 cores (GPU-S allows cpu=52 across 2 GPUs). 12 cores are
 *  left, below the 26 a default GPU-1 request wants; memory is ample. */
export const A40_CPU_SHORT = node({
  ...A40_FREE_SLOT,
  name: "spcc-a40g18",
  alloc_cpus: 40,
  alloc_memory: 65536,
  alloc_tres: "cpu=40,mem=65536M,gres/gpu:nvidia_a40=1",
});

/** spcc-a40g14's observed leftovers (10 cores, 101816 MB free) with its
 *  second GPU released — short on both counts at once. */
export const A40_CPU_MEM_SHORT = node({
  ...A40_FREE_SLOT,
  name: "spcc-a40g14",
  alloc_cpus: 42,
  alloc_memory: 413490,
  alloc_tres: "cpu=42,mem=413490M,gres/gpu:nvidia_a40=1",
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

function job(fields: Partial<RawJob> & Pick<RawJob, "job_id" | "partition" | "job_state">): RawJob {
  return {
    user_name: "s0000000",
    account: "",
    state_reason: "Priority",
    node_count: 1,
    cpus: 0,
    gpus: 0,
    tres_req_str: "",
    container: "",
    submit_time: 0,
    end_time: "",
    start_est: "",
    time_left: "",
    name: "job",
    qos: "",
    nodelist: "",
    sched_nodes: "",
    req_nodes: "",
    exc_nodes: "",
    time_limit: "",
    min_memory_mb: 0,
    ...fields,
  } as RawJob;
}

/** Job 499329 — GPU-S, Reason=Resources, the waiter spcc-a40g15 is held for.
 *  Its request (26 cores / 1 GPU / 255970 MB) fits the node's leftovers. */
export const PENDING_A40_CONTENDER = job({
  job_id: 499329,
  user_name: "s2516101",
  partition: "GPU-S",
  job_state: "PENDING",
  state_reason: "Resources",
  cpus: 26,
  gpus: 1,
  min_memory_mb: 255970,
  time_limit: "12:00:00",
  sched_nodes: "spcc-a40g15",
  start_est: "2026-07-29T06:33:35",
});

/** Job 499123 — VM-GPU-L, Reason=QOSMaxJobsPerUserLimit. It looks like a
 *  contender but cannot start at all, which is why the H100 GPUs stay green.
 *  Verified live the same morning: a fresh salloc walked straight past it. */
export const PENDING_H100_LIMIT_BLOCKED = job({
  job_id: 499123,
  user_name: "s2410212",
  partition: "VM-GPU-L",
  job_state: "PENDING",
  state_reason: "QOSMaxJobsPerUserLimit",
  cpus: 32,
  gpus: 1,
  min_memory_mb: 438272,
  time_limit: "12:00:00",
});
