/**
 * The GPU side of hakusan's queue, as /api/snapshot showed it on 2026-10-06
 * at 22:44 JST — nodes, running and pending jobs of the a40, a100 and
 * h100-80 pools, with their partitions' QoS caps. User names are replaced
 * by u01, u02, … ; nothing else is edited.
 *
 * Captured with: curl -s localhost:8787/api/snapshot > snap.json
 *                python3 capture_queue_fixture.py snap.json queue.fixtures.ts
 *
 * What it holds (the reason it was kept):
 *  - five jobs of one user queued to GPU-1,GPU-1A,GPU-S whose Reason is
 *    QOSGrpJobsLimit (GPU-S 10/10) while squeue's SchedNodes books each on an
 *    A40 node at the next A40 release — the waiters isLimitBlocked dropped;
 *  - GPU-S waiters behind a full GrpJobs cap, GPU-1A waiters behind their
 *    owners' MaxJobsPerUser, dependencies, holds, a DependencyNeverSatisfied.
 */
import type { Partition, PolicySnapshot, Pool, RawJob, RawNode, Snapshot } from "@/types/snapshot";

export const GENERATED_AT = 1791294279;

export const PART_POOL: Record<string, string> = {"GPU-1": "a40", "GPU-1A": "a100", "GPU-L": "a40", "GPU-LA": "a100", "GPU-S": "a40", "VM-GPU-L": "h100-80"};

export const POOLS = [
  {
    "id": "a40",
    "kind": "gpu",
    "nodes": 20,
    "mem_per_node": 515306,
    "down_nodes": 0,
    "available_nodes": 0,
    "idle_nodes": 0,
    "cores": {
      "total": 1040,
      "alloc": 856,
      "free": 112,
      "unavailable": 72,
      "util": 0.823
    },
    "gpu": {
      "type": "nvidia_a40",
      "label": "A40",
      "mem_gb": 48,
      "total": 40,
      "used": 40,
      "down": 0,
      "reserved": 0,
      "free": 0,
      "maint": false,
      "util": 1.0,
      "next_free": {
        "at": "2026-10-06T23:35:44",
        "left": "51:05",
        "gpus": 1
      }
    },
    "partitions": [
      "GPU-1",
      "GPU-L",
      "GPU-S"
    ],
    "queue": {
      "running": 39,
      "pending": 41,
      "releasing": {
        "jobs": 2,
        "nodes": 2
      }
    }
  },
  {
    "id": "a100",
    "kind": "gpu",
    "nodes": 10,
    "mem_per_node": 515306,
    "down_nodes": 0,
    "available_nodes": 0,
    "idle_nodes": 0,
    "cores": {
      "total": 520,
      "alloc": 439,
      "free": 14,
      "unavailable": 67,
      "util": 0.844
    },
    "gpu": {
      "type": "nvidia_a100",
      "label": "A100",
      "mem_gb": 40,
      "total": 20,
      "used": 20,
      "down": 0,
      "reserved": 0,
      "free": 0,
      "maint": false,
      "util": 1.0,
      "next_free": {
        "at": "2026-10-07T09:21:19",
        "left": "10:36:40",
        "gpus": 1
      }
    },
    "partitions": [
      "GPU-1A",
      "GPU-LA"
    ],
    "queue": {
      "running": 20,
      "pending": 48,
      "releasing": {
        "jobs": 0,
        "nodes": 0
      }
    }
  },
  {
    "id": "h100-80",
    "kind": "gpu",
    "nodes": 4,
    "mem_per_node": 469070,
    "down_nodes": 1,
    "available_nodes": 0,
    "idle_nodes": 0,
    "cores": {
      "total": 128,
      "alloc": 88,
      "free": 8,
      "unavailable": 32,
      "util": 0.688
    },
    "gpu": {
      "type": "h100-80c",
      "label": "H100 80GB",
      "mem_gb": 80,
      "total": 4,
      "used": 3,
      "down": 1,
      "reserved": 0,
      "free": 0,
      "maint": false,
      "util": 0.75,
      "next_free": {
        "at": "2026-10-07T04:17:09",
        "left": "5:32:30",
        "gpus": 1
      }
    },
    "partitions": [
      "VM-GPU-L"
    ],
    "queue": {
      "running": 3,
      "pending": 5,
      "releasing": {
        "jobs": 0,
        "nodes": 0
      }
    }
  }
] as unknown as Pool[];

export const PARTITIONS = [
  {
    "name": "GPU-1A",
    "kind": "gpu",
    "nodes": 10,
    "pool": "a100",
    "gpu": {
      "total": 20,
      "used": 20,
      "down": 0,
      "reserved": 0,
      "free": 0,
      "util": 1.0
    },
    "jobs": {
      "running": 18,
      "pending": 42
    },
    "spec": {
      "cores_per_node": 52,
      "mem_per_node": 515306,
      "gpu_per_node": 2
    },
    "nodes_state": {
      "allocated": 4,
      "mixed": 6
    },
    "free_nodes": 0,
    "available_nodes": 0
  },
  {
    "name": "GPU-1",
    "kind": "gpu",
    "nodes": 20,
    "pool": "a40",
    "gpu": {
      "total": 40,
      "used": 40,
      "down": 0,
      "reserved": 0,
      "free": 0,
      "util": 1.0
    },
    "jobs": {
      "running": 26,
      "pending": 27
    },
    "spec": {
      "cores_per_node": 52,
      "mem_per_node": 515306,
      "gpu_per_node": 2
    },
    "nodes_state": {
      "mixed": 9,
      "allocated": 11
    },
    "free_nodes": 0,
    "available_nodes": 0
  },
  {
    "name": "GPU-S",
    "kind": "gpu",
    "nodes": 20,
    "pool": "a40",
    "gpu": {
      "total": 40,
      "used": 40,
      "down": 0,
      "reserved": 0,
      "free": 0,
      "util": 1.0
    },
    "jobs": {
      "running": 10,
      "pending": 18
    },
    "spec": {
      "cores_per_node": 52,
      "mem_per_node": 515306,
      "gpu_per_node": 2
    },
    "nodes_state": {
      "mixed": 9,
      "allocated": 11
    },
    "free_nodes": 0,
    "available_nodes": 0
  },
  {
    "name": "GPU-LA",
    "kind": "gpu",
    "nodes": 10,
    "pool": "a100",
    "gpu": {
      "total": 20,
      "used": 20,
      "down": 0,
      "reserved": 0,
      "free": 0,
      "util": 1.0
    },
    "jobs": {
      "running": 2,
      "pending": 6
    },
    "spec": {
      "cores_per_node": 52,
      "mem_per_node": 515306,
      "gpu_per_node": 2
    },
    "nodes_state": {
      "allocated": 4,
      "mixed": 6
    },
    "free_nodes": 0,
    "available_nodes": 0
  },
  {
    "name": "GPU-L",
    "kind": "gpu",
    "nodes": 20,
    "pool": "a40",
    "gpu": {
      "total": 40,
      "used": 40,
      "down": 0,
      "reserved": 0,
      "free": 0,
      "util": 1.0
    },
    "jobs": {
      "running": 3,
      "pending": 5
    },
    "spec": {
      "cores_per_node": 52,
      "mem_per_node": 515306,
      "gpu_per_node": 2
    },
    "nodes_state": {
      "mixed": 9,
      "allocated": 11
    },
    "free_nodes": 0,
    "available_nodes": 0
  },
  {
    "name": "VM-GPU-L",
    "kind": "gpu",
    "nodes": 4,
    "pool": "h100-80",
    "gpu": {
      "total": 4,
      "used": 3,
      "down": 1,
      "reserved": 0,
      "free": 0,
      "util": 0.75
    },
    "jobs": {
      "running": 3,
      "pending": 5
    },
    "spec": {
      "cores_per_node": 32,
      "mem_per_node": 469070,
      "gpu_per_node": 1
    },
    "nodes_state": {
      "allocated": 2,
      "drain": 1,
      "mixed": 1
    },
    "free_nodes": 0,
    "available_nodes": 0
  }
] as unknown as Partition[];

export const POLICY = {
  "partition_caps": {
    "GPU-1": {
      "maxCores": 26,
      "maxMemGb": 256,
      "maxGpus": 1,
      "maxNodes": 1,
      "wall": "7d"
    },
    "GPU-1A": {
      "maxCores": 26,
      "maxMemGb": 256,
      "maxNodes": 1,
      "wall": "7d"
    },
    "GPU-L": {
      "maxCores": 208,
      "maxMemGb": 2048,
      "maxGpus": 8,
      "wall": "3d"
    },
    "GPU-LA": {
      "maxCores": 208,
      "maxMemGb": 2048,
      "wall": "3d"
    },
    "GPU-S": {
      "maxCores": 52,
      "maxMemGb": 512,
      "maxGpus": 2,
      "maxNodes": 1,
      "wall": "5d"
    },
    "VM-GPU-L": {
      "maxCores": 32,
      "maxMemGb": 458,
      "maxGpus": 1,
      "wall": "2d"
    }
  },
  "partition_policies": {
    "GPU-1": {
      "grpJobs": 30,
      "maxJobsPerUser": 4,
      "maxSubmitPerUser": 30
    },
    "GPU-1A": {
      "grpJobs": 20,
      "maxJobsPerUser": 2,
      "maxSubmitPerUser": 20
    },
    "GPU-L": {
      "grpJobs": 3,
      "maxJobsPerUser": 1,
      "maxSubmitPerUser": 5
    },
    "GPU-LA": {
      "grpJobs": 2,
      "maxJobsPerUser": 1,
      "maxSubmitPerUser": 5
    },
    "GPU-S": {
      "grpJobs": 10,
      "maxJobsPerUser": 2,
      "maxSubmitPerUser": 15
    },
    "VM-GPU-L": {
      "maxJobsPerUser": 1,
      "maxSubmitPerUser": 3
    }
  },
  "partition_defaults": {
    "GPU-1": {
      "cores": 26,
      "gpus_per_node": 1,
      "interactive_time_min": 720,
      "def_mem_per_cpu_mb": 9845
    },
    "GPU-1A": {
      "cores": 26,
      "gpus_per_node": 1,
      "interactive_time_min": 720,
      "def_mem_per_cpu_mb": 9845
    },
    "GPU-L": {
      "cores": 26,
      "gpus_per_node": 1,
      "interactive_time_min": 720,
      "def_mem_per_cpu_mb": 9845
    },
    "GPU-LA": {
      "cores": 26,
      "gpus_per_node": 1,
      "interactive_time_min": 720,
      "def_mem_per_cpu_mb": 9845
    },
    "GPU-S": {
      "cores": 26,
      "gpus_per_node": 1,
      "interactive_time_min": 720,
      "def_mem_per_cpu_mb": 9845
    },
    "VM-GPU-L": {
      "cores": 32,
      "gpus_per_node": 1,
      "interactive_time_min": 720,
      "def_mem_per_cpu_mb": 14656
    }
  },
  "partitions": {
    "GPU-1": {
      "qos": "gpu-1"
    },
    "GPU-1A": {
      "qos": "gpu-1a"
    },
    "GPU-L": {
      "qos": "gpu-l"
    },
    "GPU-LA": {
      "qos": "gpu-la"
    },
    "GPU-S": {
      "qos": "gpu-s"
    },
    "VM-GPU-L": {
      "qos": "vm-gpu-l"
    }
  }
} as unknown as PolicySnapshot;

type NodeRow = [string, string, string, string, number, number, number, number, string, string, boolean];
// name, pool, state, partitions, cpus, alloc_cpus, real_memory, alloc_memory, gres, gres_used, schedulable
const NODE_ROWS: NodeRow[] = [
  ["spcc-a100g01", "a100", "ALLOCATED", "GPU-1A,GPU-LA", 52, 52, 515306, 511940, "gpu:nvidia_a100:2(S:0-1)", "gpu:nvidia_a100:2", false],
  ["spcc-a100g02", "a100", "MIXED", "GPU-1A,GPU-LA", 52, 50, 515306, 387042, "gpu:nvidia_a100:2(S:0-1)", "gpu:nvidia_a100:2", true],
  ["spcc-a100g03", "a100", "ALLOCATED", "GPU-1A,GPU-LA", 52, 52, 515306, 511940, "gpu:nvidia_a100:2(S:0-1)", "gpu:nvidia_a100:2", false],
  ["spcc-a100g04", "a100", "MIXED+PLANNED", "GPU-1A,GPU-LA", 52, 34, 515306, 334730, "gpu:nvidia_a100:2(S:0-1)", "gpu:nvidia_a100:2", false],
  ["spcc-a100g05", "a100", "MIXED+PLANNED", "GPU-1A,GPU-LA", 52, 42, 515306, 321506, "gpu:nvidia_a100:2(S:0-1)", "gpu:nvidia_a100:2", false],
  ["spcc-a100g06", "a100", "ALLOCATED", "GPU-1A,GPU-LA", 52, 52, 515306, 511940, "gpu:nvidia_a100:2(S:0-1)", "gpu:nvidia_a100:2", false],
  ["spcc-a100g07", "a100", "ALLOCATED", "GPU-1A,GPU-LA", 52, 52, 515306, 511940, "gpu:nvidia_a100:2(S:0-1)", "gpu:nvidia_a100:2", false],
  ["spcc-a100g08", "a100", "MIXED+PLANNED", "GPU-1A,GPU-LA", 52, 23, 515306, 131072, "gpu:nvidia_a100:2(S:0-1)", "gpu:nvidia_a100:2", false],
  ["spcc-a100g09", "a100", "MIXED+PLANNED", "GPU-1A,GPU-LA", 52, 42, 515306, 321506, "gpu:nvidia_a100:2(S:0-1)", "gpu:nvidia_a100:2", false],
  ["spcc-a100g10", "a100", "MIXED", "GPU-1A,GPU-LA", 52, 40, 515306, 387042, "gpu:nvidia_a100:2(S:0-1)", "gpu:nvidia_a100:2", true],
  ["spcc-a40g01", "a40", "MIXED", "GPU-1,GPU-S,GPU-L", 52, 38, 515306, 354274, "gpu:nvidia_a40:2(S:0-1)", "gpu:nvidia_a40:2", true],
  ["spcc-a40g02", "a40", "ALLOCATED", "GPU-1,GPU-S,GPU-L", 52, 52, 515306, 511940, "gpu:nvidia_a40:2(S:0-1)", "gpu:nvidia_a40:2", false],
  ["spcc-a40g03", "a40", "ALLOCATED", "GPU-1,GPU-S,GPU-L", 52, 52, 515306, 511940, "gpu:nvidia_a40:2(S:0-1)", "gpu:nvidia_a40:2", false],
  ["spcc-a40g04", "a40", "MIXED", "GPU-1,GPU-S,GPU-L", 52, 24, 515306, 196608, "gpu:nvidia_a40:2(S:0-1)", "gpu:nvidia_a40:2", true],
  ["spcc-a40g05", "a40", "ALLOCATED", "GPU-1,GPU-S,GPU-L", 52, 52, 515306, 511940, "gpu:nvidia_a40:2(S:0-1)", "gpu:nvidia_a40:2", false],
  ["spcc-a40g06", "a40", "ALLOCATED", "GPU-1,GPU-S,GPU-L", 52, 52, 515306, 511940, "gpu:nvidia_a40:2(S:0-1)", "gpu:nvidia_a40:2", false],
  ["spcc-a40g07", "a40", "ALLOCATED", "GPU-1,GPU-S,GPU-L", 52, 52, 515306, 511940, "gpu:nvidia_a40:2(S:0-1)", "gpu:nvidia_a40:2", false],
  ["spcc-a40g08", "a40", "MIXED", "GPU-1,GPU-S,GPU-L", 52, 27, 515306, 265815, "gpu:nvidia_a40:2(S:0-1)", "gpu:nvidia_a40:2", true],
  ["spcc-a40g09", "a40", "MIXED+PLANNED", "GPU-1,GPU-S,GPU-L", 52, 38, 515306, 321506, "gpu:nvidia_a40:2(S:0-1)", "gpu:nvidia_a40:2", false],
  ["spcc-a40g10", "a40", "ALLOCATED", "GPU-1,GPU-S,GPU-L", 52, 52, 515306, 511940, "gpu:nvidia_a40:2(S:0-1)", "gpu:nvidia_a40:2", false],
  ["spcc-a40g11", "a40", "ALLOCATED", "GPU-1,GPU-S,GPU-L", 52, 52, 515306, 511940, "gpu:nvidia_a40:2(S:0-1)", "gpu:nvidia_a40:2", false],
  ["spcc-a40g12", "a40", "ALLOCATED", "GPU-1,GPU-S,GPU-L", 52, 52, 515306, 387042, "gpu:nvidia_a40:2(S:0-1)", "gpu:nvidia_a40:2", false],
  ["spcc-a40g13", "a40", "MIXED+PLANNED", "GPU-1,GPU-S,GPU-L", 52, 42, 515306, 321506, "gpu:nvidia_a40:2(S:0-1)", "gpu:nvidia_a40:2", false],
  ["spcc-a40g14", "a40", "ALLOCATED", "GPU-1,GPU-S,GPU-L", 52, 52, 515306, 262144, "gpu:nvidia_a40:2(S:0-1)", "gpu:nvidia_a40:2", false],
  ["spcc-a40g15", "a40", "ALLOCATED", "GPU-1,GPU-S,GPU-L", 52, 52, 515306, 387042, "gpu:nvidia_a40:2(S:0-1)", "gpu:nvidia_a40:2", false],
  ["spcc-a40g16", "a40", "MIXED", "GPU-1,GPU-S,GPU-L", 52, 33, 515306, 321506, "gpu:nvidia_a40:2(S:0-1)", "gpu:nvidia_a40:2", true],
  ["spcc-a40g17", "a40", "ALLOCATED", "GPU-1,GPU-S,GPU-L", 52, 52, 515306, 272354, "gpu:nvidia_a40:2(S:0-1)", "gpu:nvidia_a40:2", false],
  ["spcc-a40g18", "a40", "MIXED+PLANNED", "GPU-1,GPU-S,GPU-L", 52, 23, 515306, 131072, "gpu:nvidia_a40:2(S:0-1)", "gpu:nvidia_a40:2", false],
  ["spcc-a40g19", "a40", "MIXED", "GPU-1,GPU-S,GPU-L", 52, 26, 515306, 65536, "gpu:nvidia_a40:2(S:0-1)", "gpu:nvidia_a40:2", true],
  ["spcc-a40g20", "a40", "MIXED+PLANNED", "GPU-1,GPU-S,GPU-L", 52, 33, 515306, 321506, "gpu:nvidia_a40:2(S:0-1)", "gpu:nvidia_a40:2", false],
  ["spcc-cld-gl01", "h100-80", "ALLOCATED", "VM-GPU-L", 32, 32, 469070, 468992, "gpu:h100-80c:1", "gpu:h100-80c:1", false],
  ["spcc-cld-gl02", "h100-80", "IDLE+DRAIN", "VM-GPU-L", 32, 0, 469070, 0, "gpu:h100-80c:1", "", false],
  ["spcc-cld-gl03", "h100-80", "MIXED", "VM-GPU-L", 32, 24, 469070, 262144, "gpu:h100-80c:1", "gpu:h100-80c:1", true],
  ["spcc-cld-gl04", "h100-80", "ALLOCATED", "VM-GPU-L", 32, 32, 469070, 468992, "gpu:h100-80c:1", "gpu:h100-80c:1", false],
];

export const NODES: RawNode[] = NODE_ROWS.map(([name, pool, state, partitions, cpus, alloc_cpus, real_memory, alloc_memory, gres, gres_used, schedulable]) => ({
  name, pool, state: state.split("+"), partitions: partitions.split(","), cpus, alloc_cpus, real_memory, alloc_memory,
  gres, gres_used, schedulable, state_bucket: "", cpu_load: "", free_mem: 0, features: "", alloc_tres: "", cfg_tres: "",
  boot_time: "", reason: "",
}));

type JobRow = [string, string, string, string, string, number, number, number, number, number, string, string, number, string, string, string];
// job_id, user, partition, state, reason, node_count, cpus, gpus, min_memory_mb, submit_time, start_est, sched_nodes, priority, time_limit, nodelist, end_time
const JOB_ROWS: JobRow[] = [
  ["773604", "u06", "VM-GPU-L", "PENDING", "QOSMaxJobsPerUserLimit", 1, 24, 1, 262144, 1791048854, "", "", 25423, "2-00:00:00", "", ""],
  ["760658", "u05", "VM-GPU-L", "PENDING", "QOSMaxJobsPerUserLimit", 1, 32, 1, 468992, 1790776301, "", "", 25340, "2-00:00:00", "", ""],
  ["756854", "u04", "GPU-1A", "PENDING", "QOSMaxJobsPerUserLimit", 1, 26, 1, 255970, 1790613682, "", "", 25218, "7-00:00:00", "", ""],
  ["756855", "u04", "GPU-1A", "PENDING", "QOSMaxJobsPerUserLimit", 1, 26, 1, 255970, 1790613688, "", "", 25218, "7-00:00:00", "", ""],
  ["756862", "u04", "GPU-1", "PENDING", "QOSMaxJobsPerUserLimit", 1, 26, 1, 255970, 1790613716, "", "", 25218, "7-00:00:00", "", ""],
  ["756863", "u04", "GPU-1", "PENDING", "QOSMaxJobsPerUserLimit", 1, 26, 1, 255970, 1790613719, "", "", 25218, "7-00:00:00", "", ""],
  ["756864", "u04", "GPU-1", "PENDING", "QOSMaxJobsPerUserLimit", 1, 26, 1, 255970, 1790613723, "", "", 25218, "7-00:00:00", "", ""],
  ["756866", "u04", "GPU-1", "PENDING", "QOSMaxJobsPerUserLimit", 1, 26, 1, 255970, 1790613727, "", "", 25218, "7-00:00:00", "", ""],
  ["756872", "u04", "GPU-S", "PENDING", "QOSGrpJobsLimit", 1, 26, 1, 255970, 1790613753, "", "", 25218, "5-00:00:00", "", ""],
  ["756873", "u04", "GPU-S", "PENDING", "QOSGrpJobsLimit", 1, 26, 1, 255970, 1790613755, "", "", 25218, "5-00:00:00", "", ""],
  ["756875", "u04", "GPU-S", "PENDING", "QOSGrpJobsLimit", 1, 26, 1, 255970, 1790613787, "", "", 25218, "5-00:00:00", "", ""],
  ["756876", "u04", "GPU-S", "PENDING", "QOSGrpJobsLimit", 1, 26, 1, 255970, 1790613791, "", "", 25218, "5-00:00:00", "", ""],
  ["776315", "u07", "VM-GPU-L", "PENDING", "Resources", 1, 32, 1, 438272, 1791134524, "2026-10-07T04:17:09", "spcc-cld-gl04", 24468, "2-00:00:00", "", "2026-10-09T04:17:09"],
  ["784349", "u13", "GPU-1", "PENDING", "QOSMaxJobsPerUserLimit", 1, 26, 1, 255970, 1791272504, "", "", 23621, "7-00:00:00", "", ""],
  ["784350", "u13", "GPU-1", "PENDING", "QOSMaxJobsPerUserLimit", 1, 26, 1, 255970, 1791272504, "", "", 23621, "7-00:00:00", "", ""],
  ["784351", "u13", "GPU-1", "PENDING", "QOSMaxJobsPerUserLimit", 1, 26, 1, 255970, 1791272504, "", "", 23621, "7-00:00:00", "", ""],
  ["784352", "u13", "GPU-1", "PENDING", "QOSMaxJobsPerUserLimit", 1, 26, 1, 255970, 1791272504, "", "", 23621, "7-00:00:00", "", ""],
  ["784355", "u13", "GPU-1A", "PENDING", "QOSMaxJobsPerUserLimit", 1, 26, 1, 255970, 1791272505, "", "", 23621, "7-00:00:00", "", ""],
  ["784356", "u13", "GPU-1A", "PENDING", "QOSMaxJobsPerUserLimit", 1, 26, 1, 255970, 1791272505, "", "", 23621, "7-00:00:00", "", ""],
  ["784359", "u13", "GPU-S", "PENDING", "QOSGrpJobsLimit", 1, 26, 1, 255970, 1791272505, "", "", 23621, "5-00:00:00", "", ""],
  ["784360", "u13", "GPU-L", "PENDING", "QOSGrpJobsLimit", 1, 26, 1, 255970, 1791272506, "", "", 23621, "3-00:00:00", "", ""],
  ["784361", "u13", "GPU-L", "PENDING", "QOSGrpJobsLimit", 1, 26, 1, 255970, 1791272506, "", "", 23621, "3-00:00:00", "", ""],
  ["784362", "u13", "GPU-LA", "PENDING", "QOSGrpJobsLimit", 1, 26, 1, 255970, 1791272506, "", "", 23621, "3-00:00:00", "", ""],
  ["784363", "u13", "GPU-LA", "PENDING", "QOSGrpJobsLimit", 1, 26, 1, 255970, 1791272506, "", "", 23621, "3-00:00:00", "", ""],
  ["507501", "u01", "GPU-1", "PENDING", "DependencyNeverSatisfied", 1, 4, 1, 32768, 1785376461, "", "", 21970, "30:00", "", ""],
  ["507502", "u01", "GPU-1", "PENDING", "Dependency", 1, 4, 1, 32768, 1785376461, "", "", 21970, "1:00:00", "", ""],
  ["507503", "u01", "GPU-1", "PENDING", "Dependency", 1, 8, 1, 65536, 1785376461, "", "", 21969, "12:00:00", "", ""],
  ["625083", "u02", "GPU-1A", "PENDING", "DependencyNeverSatisfied", 1, 12, 1, 98304, 1787582861, "", "", 21969, "2-00:00:00", "", ""],
  ["625084", "u02", "GPU-1A", "PENDING", "Dependency", 1, 12, 1, 98304, 1787582864, "", "", 21969, "2-00:00:00", "", ""],
  ["625085", "u02", "GPU-1A", "PENDING", "Dependency", 1, 8, 1, 32768, 1787582869, "", "", 21969, "4:00:00", "", ""],
  ["626617_0", "u02", "GPU-1A", "PENDING", "DependencyNeverSatisfied", 1, 12, 1, 98304, 1787631571, "", "", 21969, "7-00:00:00", "", ""],
  ["626617_1", "u02", "GPU-1A", "PENDING", "DependencyNeverSatisfied", 1, 12, 1, 98304, 1787631571, "", "", 21969, "7-00:00:00", "", ""],
  ["626617_2", "u02", "GPU-1A", "PENDING", "DependencyNeverSatisfied", 1, 12, 1, 98304, 1787631571, "", "", 21969, "7-00:00:00", "", ""],
  ["626618", "u02", "GPU-1A", "PENDING", "Dependency", 1, 12, 1, 98304, 1787631579, "", "", 21969, "2-00:00:00", "", ""],
  ["626619", "u02", "GPU-1A", "PENDING", "Dependency", 1, 12, 1, 98304, 1787631590, "", "", 21969, "2-00:00:00", "", ""],
  ["626620", "u02", "GPU-1A", "PENDING", "Dependency", 1, 8, 1, 32768, 1787631597, "", "", 21969, "4:00:00", "", ""],
  ["644817", "u03", "GPU-1", "PENDING", "DependencyNeverSatisfied", 1, 26, 1, 65536, 1788201640, "", "", 21967, "8:00:00", "", ""],
  ["644818", "u03", "GPU-1", "PENDING", "Dependency", 1, 26, 1, 32768, 1788201644, "", "", 21967, "30:00", "", ""],
  ["778359", "u05", "GPU-LA", "PENDING", "QOSGrpJobsLimit", 1, 26, 1, 255970, 1791179242, "", "", 21635, "3-00:00:00", "", ""],
  ["778361", "u05", "GPU-1A", "PENDING", "QOSMaxJobsPerUserLimit", 1, 26, 1, 255970, 1791179246, "", "", 21635, "7-00:00:00", "", ""],
  ["780131", "u08", "GPU-1A", "PENDING", "QOSMaxJobsPerUserLimit", 1, 16, 1, 65536, 1791198816, "", "", 20565, "1-00:00:00", "", ""],
  ["780132", "u08", "GPU-1A", "PENDING", "QOSMaxJobsPerUserLimit", 1, 16, 1, 65536, 1791198816, "", "", 20565, "1-00:00:00", "", ""],
  ["781125", "u06", "VM-GPU-L", "PENDING", "QOSMaxJobsPerUserLimit", 1, 24, 1, 262144, 1791214632, "", "", 19669, "2-00:00:00", "", ""],
  ["782572", "u10", "GPU-S", "PENDING", "QOSGrpJobsLimit", 1, 26, 2, 65536, 1791244424, "", "", 18313, "5-00:00:00", "", ""],
  ["783200", "u10", "GPU-S", "PENDING", "QOSGrpJobsLimit", 1, 26, 2, 65536, 1791256837, "", "", 17595, "5-00:00:00", "", ""],
  ["783097", "u11", "GPU-LA", "PENDING", "QOSGrpJobsLimit", 1, 26, 1, 255970, 1791254152, "", "", 17403, "12:00:00", "", ""],
  ["783101", "u11", "GPU-L", "PENDING", "QOSGrpJobsLimit", 1, 26, 1, 255970, 1791254171, "", "", 17401, "12:00:00", "", ""],
  ["783152", "u11", "GPU-1A", "PENDING", "Resources", 1, 26, 1, 255970, 1791255135, "2026-10-07T09:21:19", "spcc-a100g05", 17346, "12:00:00", "", "2026-10-07T21:21:19"],
  ["783422", "u07", "VM-GPU-L", "PENDING", "Priority", 1, 32, 1, 438272, 1791260001, "2026-10-08T00:36:04", "", 17206, "2-00:00:00", "", "2026-10-10T00:36:04"],
  ["783425", "u07", "GPU-1A", "PENDING", "Priority", 1, 26, 1, 131072, 1791260036, "2026-10-07T14:00:44", "spcc-a100g04", 17205, "3-00:00:00", "", "2026-10-10T14:00:44"],
  ["783423", "u07", "GPU-S", "PENDING", "QOSGrpJobsLimit", 1, 52, 2, 262144, 1791260011, "", "", 17203, "5-00:00:00", "", ""],
  ["783471", "u12", "GPU-1A", "PENDING", "Priority", 1, 7, 1, 65536, 1791260747, "2026-10-07T15:10:44", "spcc-a100g08", 17126, "7-00:00:00", "", "2026-10-14T15:10:44"],
  ["783518", "u09", "GPU-1A", "PENDING", "Priority", 1, 12, 1, 65536, 1791261212, "2026-10-07T17:10:14", "spcc-a100g09", 16853, "1-00:00:00", "", "2026-10-08T17:10:14"],
  ["783519", "u09", "GPU-1A", "PENDING", "Priority", 1, 12, 1, 65536, 1791261212, "2026-10-07T21:22:00", "spcc-a100g05", 16853, "1-00:00:00", "", "2026-10-08T21:22:00"],
  ["779755", "u08", "GPU-1A", "PENDING", "QOSMaxJobsPerUserLimit", 1, 16, 1, 65536, 1791212645, "", "", 16842, "1-00:00:00", "", ""],
  ["779756", "u08", "GPU-1A", "PENDING", "QOSMaxJobsPerUserLimit", 1, 16, 1, 65536, 1791212674, "", "", 16842, "1-00:00:00", "", ""],
  ["776959", "u08", "GPU-1A", "PENDING", "QOSMaxJobsPerUserLimit", 1, 16, 1, 65536, 1791158648, "", "", 16616, "1-00:00:00", "", ""],
  ["776962", "u08", "GPU-LA", "PENDING", "QOSGrpJobsLimit", 1, 16, 1, 65536, 1791158648, "", "", 16616, "1-00:00:00", "", ""],
  ["776964", "u08", "GPU-LA", "PENDING", "QOSGrpJobsLimit", 1, 16, 1, 65536, 1791158648, "", "", 16616, "1-00:00:00", "", ""],
  ["784397", "u14", "GPU-S", "PENDING", "QOSGrpJobsLimit", 1, 26, 1, 16384, 1791273143, "", "", 16569, "2:00:00", "", ""],
  ["785263", "u19", "GPU-1A", "PENDING", "Priority", 1, 26, 1, 98304, 1791289148, "2026-10-08T00:27:18", "", 16323, "4:00:00", "", "2026-10-08T04:27:18"],
  ["785267", "u19", "GPU-1A", "PENDING", "Priority", 1, 26, 1, 98304, 1791289270, "2026-10-08T00:27:18", "", 16323, "4:00:00", "", "2026-10-08T04:27:18"],
  ["785313", "u19", "GPU-1", "PENDING", "Resources", 1, 26, 1, 65536, 1791290190, "2026-10-06T23:35:44", "spcc-a40g13", 16323, "3-00:00:00", "", "2026-10-09T23:35:44"],
  ["783590", "u09", "GPU-1,GPU-1A,GPU-S", "PENDING", "QOSGrpJobsLimit", 1, 12, 1, 98304, 1791262167, "2026-10-06T23:52:24", "spcc-a40g20", 16136, "3-00:00:00", "", "2026-10-09T23:52:24"],
  ["783591", "u09", "GPU-1,GPU-1A,GPU-S", "PENDING", "QOSGrpJobsLimit", 1, 12, 1, 98304, 1791262171, "2026-10-07T01:32:37", "spcc-a40g07", 16136, "3-00:00:00", "", "2026-10-10T01:32:37"],
  ["783592", "u09", "GPU-1,GPU-1A,GPU-S", "PENDING", "QOSGrpJobsLimit", 1, 12, 1, 98304, 1791262175, "2026-10-07T03:14:47", "spcc-a40g18", 16136, "3-00:00:00", "", "2026-10-10T03:14:47"],
  ["784090", "u09", "GPU-1,GPU-1A,GPU-S", "PENDING", "QOSGrpJobsLimit", 1, 12, 1, 98304, 1791267971, "2026-10-07T11:57:55", "spcc-a40g05", 16136, "3-00:00:00", "", "2026-10-10T11:57:55"],
  ["784092", "u09", "GPU-1,GPU-1A,GPU-S", "PENDING", "QOSGrpJobsLimit", 1, 12, 1, 98304, 1791267977, "2026-10-07T15:20:17", "spcc-a40g09", 16136, "3-00:00:00", "", "2026-10-10T15:20:17"],
  ["785117", "u17", "GPU-1A", "PENDING", "Priority", 1, 8, 1, 78760, 1791285091, "2026-10-08T00:27:18", "", 16038, "45:00", "", "2026-10-08T01:12:18"],
  ["784934", "u15", "GPU-1A", "PENDING", "Priority", 1, 16, 1, 65536, 1791281773, "2026-10-08T00:27:18", "", 16030, "30:00", "", "2026-10-08T00:57:18"],
  ["785098", "u16", "GPU-1", "PENDING", "Priority", 1, 26, 1, 255970, 1791284697, "2026-10-09T01:42:39", "", 15798, "7-00:00:00", "", "2026-10-16T01:42:39"],
  ["785099", "u16", "GPU-1A", "PENDING", "Priority", 1, 26, 1, 255970, 1791284725, "2026-10-08T00:27:18", "", 15797, "7-00:00:00", "", "2026-10-15T00:27:18"],
  ["785141", "u18", "GPU-1", "PENDING", "Priority", 1, 26, 1, 255970, 1791286114, "2026-10-09T01:42:39", "", 15676, "3:00:00", "", "2026-10-09T04:42:39"],
  ["776961", "u08", "GPU-1A", "PENDING", "Dependency", 1, 16, 1, 65536, 1791158648, "", "", 15404, "1-00:00:00", "", ""],
  ["776963", "u08", "GPU-1A", "PENDING", "Dependency", 1, 16, 1, 65536, 1791158648, "", "", 15404, "1-00:00:00", "", ""],
  ["785231", "u05", "GPU-1A", "PENDING", "QOSMaxJobsPerUserLimit", 1, 26, 1, 255970, 1791288140, "", "", 15341, "7-00:00:00", "", ""],
  ["777900", "u09", "GPU-1,GPU-S", "PENDING", "DependencyNeverSatisfied", 1, 8, 1, 65536, 1791175503, "", "", 15303, "6:00:00", "", ""],
  ["783523", "u09", "GPU-1A", "PENDING", "Dependency", 1, 12, 1, 65536, 1791261212, "", "", 15302, "1-00:00:00", "", ""],
  ["783524", "u09", "GPU-1A", "PENDING", "Dependency", 1, 12, 1, 65536, 1791261212, "", "", 15302, "1-00:00:00", "", ""],
  ["783525", "u09", "GPU-L", "PENDING", "Dependency", 1, 12, 1, 65536, 1791261212, "", "", 15302, "1-00:00:00", "", ""],
  ["783527", "u09", "GPU-L", "PENDING", "Dependency", 1, 12, 1, 65536, 1791261212, "", "", 15302, "2-00:00:00", "", ""],
  ["783528", "u09", "GPU-1", "PENDING", "Dependency", 1, 12, 1, 65536, 1791261212, "", "", 15302, "2-00:00:00", "", ""],
  ["783529", "u09", "GPU-1", "PENDING", "Dependency", 1, 12, 1, 65536, 1791261212, "", "", 15302, "2-00:00:00", "", ""],
  ["783582", "u09", "GPU-1,GPU-1A,GPU-S", "PENDING", "JobHeldUser", 1, 12, 1, 98304, 1791262130, "", "", 0, "3-00:00:00", "", ""],
  ["783583", "u09", "GPU-1,GPU-1A,GPU-S", "PENDING", "JobHeldUser", 1, 12, 1, 98304, 1791262134, "", "", 0, "3-00:00:00", "", ""],
  ["783584", "u09", "GPU-1,GPU-1A,GPU-S", "PENDING", "JobHeldUser", 1, 12, 1, 98304, 1791262138, "", "", 0, "3-00:00:00", "", ""],
  ["776477", "u21", "VM-GPU-L", "RUNNING", "None", 1, 32, 1, 468992, 1791141420, "2026-10-06T00:36:04", "", 26173, "2-00:00:00", "spcc-cld-gl01", "2026-10-08T00:36:04"],
  ["768303", "u06", "VM-GPU-L", "RUNNING", "None", 1, 24, 1, 262144, 1790929461, "2026-10-06T12:14:20", "", 25425, "2-00:00:00", "spcc-cld-gl03", "2026-10-08T12:14:20"],
  ["750277", "u20", "GPU-1A", "RUNNING", "None", 1, 26, 1, 255970, 1790505589, "2026-10-03T10:34:33", "", 25368, "7-00:00:00", "spcc-a100g03", "2026-10-10T10:34:33"],
  ["760659", "u05", "VM-GPU-L", "RUNNING", "None", 1, 32, 1, 468992, 1790776303, "2026-10-05T04:17:09", "", 25325, "2-00:00:00", "spcc-cld-gl04", "2026-10-07T04:17:09"],
  ["756852", "u04", "GPU-1A", "RUNNING", "None", 1, 26, 1, 255970, 1790613673, "2026-10-04T15:54:17", "", 25243, "7-00:00:00", "spcc-a100g09", "2026-10-11T15:54:17"],
  ["756853", "u04", "GPU-1A", "RUNNING", "None", 1, 26, 1, 255970, 1790613678, "2026-10-04T15:54:18", "", 25243, "7-00:00:00", "spcc-a100g01", "2026-10-11T15:54:18"],
  ["756858", "u04", "GPU-1", "RUNNING", "None", 1, 26, 1, 255970, 1790613698, "2026-10-02T23:56:42", "", 25243, "7-00:00:00", "spcc-a40g02", "2026-10-09T23:56:42"],
  ["756859", "u04", "GPU-1", "RUNNING", "None", 1, 26, 1, 255970, 1790613702, "2026-10-03T00:07:19", "", 25243, "7-00:00:00", "spcc-a40g16", "2026-10-10T00:07:19"],
  ["756860", "u04", "GPU-1", "RUNNING", "None", 1, 26, 1, 255970, 1790613707, "2026-10-03T04:50:47", "", 25243, "7-00:00:00", "spcc-a40g03", "2026-10-10T04:50:47"],
  ["756870", "u04", "GPU-S", "RUNNING", "None", 1, 26, 1, 255970, 1790613747, "2026-10-04T01:42:39", "", 25243, "5-00:00:00", "spcc-a40g01", "2026-10-09T01:42:39"],
  ["756871", "u04", "GPU-S", "RUNNING", "None", 1, 26, 1, 255970, 1790613751, "2026-10-04T01:42:39", "", 25243, "5-00:00:00", "spcc-a40g03", "2026-10-09T01:42:39"],
  ["756861", "u04", "GPU-1", "RUNNING", "None", 1, 26, 1, 255970, 1790613711, "2026-10-03T13:30:12", "", 25223, "7-00:00:00", "spcc-a40g10", "2026-10-10T13:30:12"],
  ["784357", "u13", "GPU-S", "RUNNING", "None", 1, 26, 1, 255970, 1791272505, "2026-10-06T18:18:52", "", 22991, "5-00:00:00", "spcc-a40g11", "2026-10-11T18:18:52"],
  ["784358", "u13", "GPU-S", "RUNNING", "None", 1, 26, 1, 255970, 1791272505, "2026-10-06T19:09:04", "", 22991, "5-00:00:00", "spcc-a40g17", "2026-10-11T19:09:04"],
  ["784345", "u13", "GPU-1", "RUNNING", "None", 1, 26, 1, 255970, 1791272503, "2026-10-06T16:42:00", "", 22719, "7-00:00:00", "spcc-a40g08", "2026-10-13T16:42:00"],
  ["784346", "u13", "GPU-1", "RUNNING", "None", 1, 26, 1, 255970, 1791272503, "2026-10-06T17:00:03", "", 22719, "7-00:00:00", "spcc-a40g02", "2026-10-13T17:00:03"],
  ["784347", "u13", "GPU-1", "RUNNING", "None", 1, 26, 1, 255970, 1791272503, "2026-10-06T17:02:03", "", 22719, "7-00:00:00", "spcc-a40g12", "2026-10-13T17:02:03"],
  ["784348", "u13", "GPU-1", "RUNNING", "None", 1, 26, 1, 255970, 1791272504, "2026-10-06T17:42:31", "", 22719, "7-00:00:00", "spcc-a40g15", "2026-10-13T17:42:31"],
  ["784353", "u13", "GPU-1A", "RUNNING", "None", 1, 26, 1, 255970, 1791272504, "2026-10-06T16:46:02", "", 22719, "7-00:00:00", "spcc-a100g03", "2026-10-13T16:46:02"],
  ["784354", "u13", "GPU-1A", "RUNNING", "None", 1, 26, 1, 255970, 1791272504, "2026-10-06T16:46:02", "", 22719, "7-00:00:00", "spcc-a100g06", "2026-10-13T16:46:02"],
  ["776489", "u21", "GPU-1", "RUNNING", "None", 1, 26, 1, 255970, 1791141497, "2026-10-05T04:18:34", "", 22048, "7-00:00:00", "spcc-a40g05", "2026-10-12T04:18:34"],
  ["776490", "u21", "GPU-1", "RUNNING", "None", 1, 26, 1, 255970, 1791141500, "2026-10-05T04:18:34", "", 22048, "7-00:00:00", "spcc-a40g06", "2026-10-12T04:18:34"],
  ["776491", "u21", "GPU-1", "RUNNING", "None", 1, 26, 1, 255970, 1791141508, "2026-10-05T04:18:34", "", 22048, "7-00:00:00", "spcc-a40g06", "2026-10-12T04:18:34"],
  ["776493", "u21", "GPU-1A", "RUNNING", "None", 1, 26, 1, 255970, 1791141521, "2026-10-05T04:19:05", "", 22048, "7-00:00:00", "spcc-a100g01", "2026-10-12T04:19:05"],
  ["776496", "u21", "GPU-1A", "RUNNING", "None", 1, 26, 1, 255970, 1791141526, "2026-10-05T04:19:05", "", 22048, "7-00:00:00", "spcc-a100g02", "2026-10-12T04:19:05"],
  ["759480", "u21", "GPU-1", "RUNNING", "None", 1, 26, 1, 255970, 1790737069, "2026-09-30T11:57:55", "", 22021, "7-00:00:00", "spcc-a40g05", "2026-10-07T11:57:55"],
  ["760783", "u16", "GPU-1A", "RUNNING", "None", 1, 26, 1, 255970, 1790778964, "2026-10-01T00:27:18", "", 22000, "7-00:00:00", "spcc-a100g07", "2026-10-08T00:27:18"],
  ["781466", "u25", "GPU-1A", "RUNNING", "None", 1, 14, 1, 131072, 1791221192, "2026-10-06T02:31:55", "", 21945, "3-00:00:00", "spcc-a100g10", "2026-10-09T02:31:55"],
  ["783062", "u26", "GPU-1", "RUNNING", "None", 1, 26, 1, 255970, 1791253127, "2026-10-06T11:19:02", "", 21942, "7-00:00:00", "spcc-a40g11", "2026-10-13T11:19:02"],
  ["780129", "u08", "GPU-LA", "RUNNING", "None", 1, 16, 1, 65536, 1791198816, "2026-10-06T15:10:44", "", 19316, "1-00:00:00", "spcc-a100g08", "2026-10-07T15:10:44"],
  ["780130", "u08", "GPU-1A", "RUNNING", "None", 1, 16, 1, 65536, 1791198816, "2026-10-06T17:10:14", "", 19316, "1-00:00:00", "spcc-a100g09", "2026-10-07T17:10:14"],
  ["780128", "u08", "GPU-1A", "RUNNING", "None", 1, 16, 1, 65536, 1791198816, "2026-10-06T09:21:19", "", 18069, "1-00:00:00", "spcc-a100g05", "2026-10-07T09:21:19"],
  ["783047", "u23", "GPU-1A", "RUNNING", "None", 1, 26, 1, 255970, 1791252635, "2026-10-06T18:59:47", "", 16887, "7-00:00:00", "spcc-a100g05", "2026-10-13T18:59:47"],
  ["780216", "u08", "GPU-1", "RUNNING", "None", 1, 16, 1, 65536, 1791199680, "2026-10-06T03:14:47", "", 16548, "1-00:00:00", "spcc-a40g18", "2026-10-07T03:14:47"],
  ["780217", "u08", "GPU-L", "RUNNING", "None", 1, 16, 1, 65536, 1791199680, "2026-10-06T03:31:56", "", 16548, "1-00:00:00", "spcc-a40g13", "2026-10-07T03:31:56"],
  ["781126", "u06", "GPU-1A", "RUNNING", "None", 1, 24, 1, 131072, 1791214636, "2026-10-06T07:46:33", "", 16548, "7-00:00:00", "spcc-a100g02", "2026-10-13T07:46:33"],
  ["781259", "u12", "GPU-1", "RUNNING", "None", 1, 7, 1, 65536, 1791216726, "2026-10-06T06:03:11", "", 16491, "7-00:00:00", "spcc-a40g20", "2026-10-13T06:03:11"],
  ["759767", "u17", "GPU-1A", "RUNNING", "None", 1, 8, 1, 78760, 1790744434, "2026-09-30T14:00:44", "", 16410, "7-00:00:00", "spcc-a100g04", "2026-10-07T14:00:44"],
  ["781017", "u14", "GPU-S", "RUNNING", "None", 1, 26, 1, 16384, 1791212441, "2026-10-06T05:22:50", "", 16318, "5-00:00:00", "spcc-a40g17", "2026-10-11T05:22:50"],
  ["778358", "u05", "GPU-LA", "RUNNING", "None", 1, 26, 1, 255970, 1791179241, "2026-10-05T19:57:36", "", 15995, "3-00:00:00", "spcc-a100g04", "2026-10-08T19:57:36"],
  ["778360", "u05", "GPU-1A", "RUNNING", "None", 1, 26, 1, 255970, 1791179245, "2026-10-05T20:00:38", "", 15995, "7-00:00:00", "spcc-a100g07", "2026-10-12T20:00:38"],
  ["777192", "u24", "GPU-S", "RUNNING", "None", 1, 1, 1, 9845, 1791164869, "2026-10-05T10:48:04", "", 15993, "5-00:00:00", "spcc-a40g08", "2026-10-10T10:48:04"],
  ["760870", "u05", "GPU-1A", "RUNNING", "None", 1, 26, 1, 255970, 1790782303, "2026-10-01T03:32:41", "", 15904, "7-00:00:00", "spcc-a100g06", "2026-10-08T03:32:41"],
  ["779801", "u10", "GPU-S", "RUNNING", "None", 1, 26, 2, 65536, 1791196643, "2026-10-06T10:53:01", "", 15867, "5-00:00:00", "spcc-a40g19", "2026-10-11T10:53:01"],
  ["783588", "u09", "GPU-1", "RUNNING", "None", 1, 12, 1, 98304, 1791262158, "2026-10-06T18:43:07", "", 15864, "3-00:00:00", "spcc-a40g04", "2026-10-09T18:43:07"],
  ["783589", "u09", "GPU-1", "RUNNING", "None", 1, 12, 1, 98304, 1791262163, "2026-10-06T19:40:04", "", 15864, "3-00:00:00", "spcc-a40g01", "2026-10-09T19:40:04"],
  ["783520", "u09", "GPU-L", "RUNNING", "None", 1, 12, 1, 65536, 1791261212, "2026-10-06T15:20:17", "", 15665, "1-00:00:00", "spcc-a40g09", "2026-10-07T15:20:17"],
  ["783268", "u16", "GPU-1", "RUNNING", "None", 1, 26, 1, 255970, 1791258616, "2026-10-06T13:22:35", "", 15610, "7-00:00:00", "spcc-a40g09", "2026-10-13T13:22:35"],
  ["772170", "u12", "GPU-1A", "RUNNING", "None", 1, 7, 1, 65536, 1791021495, "2026-10-03T19:22:17", "", 15538, "7-00:00:00", "spcc-a100g08", "2026-10-10T19:22:17"],
  ["784775", "u12", "GPU-1", "RUNNING", "None", 1, 7, 1, 65536, 1791278078, "2026-10-06T19:55:04", "", 15529, "7-00:00:00", "spcc-a40g16", "2026-10-13T19:55:04"],
  ["783118", "u11", "GPU-S", "RUNNING", "None", 1, 26, 1, 255970, 1791254307, "2026-10-06T13:32:37", "", 15520, "12:00:00", "spcc-a40g07", "2026-10-07T01:32:37"],
  ["783048", "u23", "GPU-S", "RUNNING", "None", 1, 26, 1, 255970, 1791252647, "2026-10-06T11:40:15", "", 15509, "5-00:00:00", "spcc-a40g07", "2026-10-11T11:40:15"],
  ["783049", "u23", "GPU-S", "RUNNING", "None", 1, 26, 1, 255970, 1791252650, "2026-10-06T11:52:47", "", 15509, "5-00:00:00", "spcc-a40g10", "2026-10-11T11:52:47"],
  ["783448", "u12", "GPU-1", "RUNNING", "None", 1, 7, 1, 65536, 1791260297, "2026-10-06T13:36:02", "", 15490, "7-00:00:00", "spcc-a40g18", "2026-10-13T13:36:02"],
  ["783096", "u11", "GPU-L", "RUNNING", "None", 1, 26, 1, 255970, 1791254144, "2026-10-06T11:35:44", "", 15447, "12:00:00", "spcc-a40g13", "2026-10-06T23:35:44"],
  ["783153", "u11", "GPU-1", "RUNNING", "None", 1, 26, 1, 255970, 1791255144, "2026-10-06T11:52:24", "", 15447, "12:00:00", "spcc-a40g20", "2026-10-06T23:52:24"],
  ["774443", "u23", "GPU-1A", "RUNNING", "None", 1, 26, 1, 255970, 1791085857, "2026-10-04T12:51:04", "", 15430, "7-00:00:00", "spcc-a100g10", "2026-10-11T12:51:04"],
  ["783585", "u09", "GPU-1", "RUNNING", "None", 1, 12, 1, 98304, 1791262143, "2026-10-06T15:28:52", "", 15364, "3-00:00:00", "spcc-a40g04", "2026-10-09T15:28:52"],
  ["769129", "u22", "GPU-1", "RUNNING", "None", 1, 26, 1, 131072, 1790947032, "2026-10-02T22:17:41", "", 15326, "7-00:00:00", "spcc-a40g14", "2026-10-09T22:17:41"],
  ["769130", "u22", "GPU-1", "RUNNING", "None", 1, 26, 1, 131072, 1790947032, "2026-10-02T22:17:41", "", 15326, "7-00:00:00", "spcc-a40g14", "2026-10-09T22:17:41"],
  ["769131", "u22", "GPU-1", "RUNNING", "None", 1, 26, 1, 131072, 1790947032, "2026-10-02T22:17:41", "", 15326, "7-00:00:00", "spcc-a40g15", "2026-10-09T22:17:41"],
  ["767607", "u22", "GPU-1", "RUNNING", "None", 1, 26, 1, 131072, 1790918987, "2026-10-02T14:30:05", "", 15306, "7-00:00:00", "spcc-a40g12", "2026-10-09T14:30:05"],
];

export const JOBS: RawJob[] = JOB_ROWS.map(([job_id, user_name, partition, job_state, state_reason, node_count, cpus, gpus,
  min_memory_mb, submit_time, start_est, sched_nodes, priority, time_limit, nodelist, end_time]) => ({
  job_id, user_name, partition, job_state, state_reason, node_count, cpus, gpus, min_memory_mb, submit_time, start_est,
  sched_nodes, priority, time_limit, nodelist, end_time, account: "", tres_req_str: "", container: "", time_left: "",
  name: "", qos: "", time_used: "",
}));

/** The capture as a snapshot (the fields the verdicts read). */
export const SNAPSHOT = {
  jobs: JOBS, nodes: NODES, pools: POOLS, partitions: PARTITIONS, policy: POLICY, part_pool: PART_POOL,
  generated_at: GENERATED_AT, licenses: [], cpu_submit_probes: [],
} as unknown as Snapshot;
