"""Built-in Hakusan partition policy tables — the fallback behind sacctmgr.

Single source of truth for published partition limits. The live QoS/partition
collection (sources.build_policy_snapshot) overlays these; the UI only ever
reads the merged result from the snapshot, so a cluster policy change needs an
edit here (or nothing at all, once the live collection picks it up) — never a
frontend change.

Key names are camelCase on purpose: they land in the JSON snapshot verbatim
and match web/src/lib/slurm.ts's PartitionCap/PartitionPolicy interfaces.
"""

BUILTIN_PARTITION_CAPS = {
    "DEF": {"maxCores": 64, "maxMemGb": 384, "maxNodes": 1, "wall": "7d"},
    "TINY": {"maxCores": 16, "maxMemGb": 96, "maxNodes": 1, "wall": "30m"},
    "SINGLE": {"maxCores": 256, "maxMemGb": 1536, "maxNodes": 1, "wall": "7d"},
    "LONG": {"maxCores": 256, "maxMemGb": 1536, "maxNodes": 1, "wall": "21d"},
    "SMALL": {"maxCores": 768, "maxMemGb": 4608, "maxNodes": 3, "wall": "7d"},
    "LARGE": {"minCores": 256, "maxCores": 2048, "maxMemGb": 12288, "maxNodes": 8, "wall": "7d"},
    "XLARGE": {"minCores": 256, "maxCores": 4096, "maxMemGb": 24576, "maxNodes": 16, "wall": "5d"},
    "X2LARGE": {"minCores": 256, "maxCores": 8192, "maxMemGb": 49152, "maxNodes": 32, "wall": "5d"},
    "LONG-L": {"minCores": 256, "maxCores": 768, "maxMemGb": 4608, "maxNodes": 3, "wall": "14d"},
    "MS_Castep": {"maxCores": 32, "maxMemGb": 192, "maxNodes": 1, "wall": "7d"},
    "MS_Dmol3": {"maxCores": 128, "maxMemGb": 768, "maxNodes": 1, "wall": "7d"},
    "MS_Forcite": {"maxCores": 64, "maxMemGb": 384, "maxNodes": 1, "wall": "7d"},
    "MS_Compass": {"maxCores": 64, "maxMemGb": 384, "maxNodes": 1, "wall": "7d"},
    "MS_Dftbplus": {"maxCores": 32, "maxMemGb": 192, "maxNodes": 1, "wall": "7d"},
    "MS_Amorphous": {"maxCores": 32, "maxMemGb": 192, "maxNodes": 1, "wall": "7d"},
    "MatStudio": {"maxCores": 32, "maxMemGb": 192, "maxNodes": 1, "wall": "7d"},
    "GPU-1": {"maxGpus": 1, "maxCores": 26, "maxMemGb": 256, "maxNodes": 1, "wall": "7d"},
    "GPU-S": {"maxGpus": 2, "maxCores": 52, "maxMemGb": 512, "maxNodes": 1, "wall": "5d"},
    "GPU-L": {"maxGpus": 8, "maxCores": 208, "maxMemGb": 2048, "maxNodes": 4, "wall": "3d"},
    "GPU-1A": {"maxGpus": 1, "maxCores": 26, "maxMemGb": 256, "maxNodes": 1, "wall": "7d"},
    "GPU-LA": {"maxGpus": 8, "maxCores": 208, "maxMemGb": 2048, "maxNodes": 4, "wall": "3d"},
    "VM-CPU": {"maxCores": 32, "maxMemGb": 480, "maxNodes": 1, "wall": "7d"},
    "VM-GPU-L": {"maxGpus": 1, "maxCores": 32, "maxMemGb": 480, "maxNodes": 1, "wall": "2d"},
    "VM-LM": {"maxCores": 96, "maxMemGb": 3840, "maxNodes": 1, "wall": "7d"},
}

BUILTIN_PARTITION_POLICIES = {
    "DEF": {"maxJobsPerUser": 300, "maxSubmitPerUser": 40},
    "TINY": {"maxJobsPerUser": 5},
    "SINGLE": {"grpJobs": 100, "maxJobsPerUser": 10, "maxSubmitPerUser": 40},
    "SMALL": {"grpJobs": 30, "maxJobsPerUser": 4, "maxSubmitPerUser": 30},
    "LARGE": {"grpJobs": 10, "maxJobsPerUser": 2, "maxSubmitPerUser": 15},
    "XLARGE": {"grpJobs": 4, "maxJobsPerUser": 1, "maxSubmitPerUser": 7},
    "X2LARGE": {"grpJobs": 2, "maxJobsPerUser": 1, "maxSubmitPerUser": 7},
    "LONG": {"grpJobs": 15, "maxJobsPerUser": 1, "maxSubmitPerUser": 15},
    "LONG-L": {"grpJobs": 5, "maxJobsPerUser": 1, "maxSubmitPerUser": 10},
    "GPU-1": {"grpJobs": 30, "maxJobsPerUser": 4, "maxSubmitPerUser": 30},
    "GPU-S": {"grpJobs": 10, "maxJobsPerUser": 2, "maxSubmitPerUser": 15},
    "GPU-L": {"grpJobs": 3, "maxJobsPerUser": 1, "maxSubmitPerUser": 5},
    "GPU-1A": {"grpJobs": 20, "maxJobsPerUser": 2, "maxSubmitPerUser": 20},
    "GPU-LA": {"grpJobs": 2, "maxJobsPerUser": 1, "maxSubmitPerUser": 5},
    "VM-CPU": {"maxJobsPerUser": 1, "maxSubmitPerUser": 10},
    "VM-GPU-L": {"maxJobsPerUser": 1, "maxSubmitPerUser": 3},
    "VM-LM": {"maxJobsPerUser": 1, "maxSubmitPerUser": 60},
    "MS_Forcite": {"grpJobs": 1},
    "MS_Compass": {"grpJobs": 1},
    "MS_Dftbplus": {"grpJobs": 1},
    "MS_Amorphous": {"grpJobs": 1},
}
