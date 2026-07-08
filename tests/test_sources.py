import unittest

from backend.sources import (
    SEP,
    _parse_tres,
    _wall_compact,
    build_policy_snapshot,
    parse_containers,
    parse_cpu_submit_probes,
    parse_pending_reqtres,
    parse_qos_policies,
    parse_queue,
)


class TresPolicyTests(unittest.TestCase):
    def test_parse_tres_treats_typed_and_generic_gpu_as_same_limit(self):
        self.assertEqual(
            _parse_tres("cpu=26,gres/gpu:nvidia_a40=1,gres/gpu=1,mem=256G,node=1"),
            {"cores": 26, "mem_gb": 256, "mem_mb": 262144, "nodes": 1, "gpus": 1,
             "gpu_type": "nvidia_a40"},
        )

    def test_wall_compact(self):
        self.assertEqual(_wall_compact("00:30:00"), "30m")
        self.assertEqual(_wall_compact("03:00:00"), "3h")
        self.assertEqual(_wall_compact("7-00:00:00"), "7d")
        self.assertEqual(_wall_compact("UNLIMITED"), "")

    def test_parse_qos_policies_extracts_caps_and_limits(self):
        rows = "\n".join(
            [
                "gpu-1|cpu=26,gres/gpu:nvidia_a40=1,gres/gpu=1,mem=256G,node=1|7-00:00:00|30|4|30||DenyOnLimit",
                "large|cpu=2048,mem=12T|7-00:00:00|10|2|15|cpu=256|DenyOnLimit",
            ],
        )
        qos = parse_qos_policies(rows)

        self.assertEqual(qos["gpu-1"]["cap"], {"maxCores": 26, "maxMemGb": 256, "maxGpus": 1, "maxNodes": 1, "wall": "7d"})
        self.assertEqual(qos["gpu-1"]["policy"], {"grpJobs": 30, "maxJobsPerUser": 4, "maxSubmitPerUser": 30})
        self.assertEqual(qos["large"]["cap"]["minCores"], 256)
        self.assertEqual(qos["large"]["cap"]["maxMemGb"], 12288)

    def test_build_policy_snapshot_maps_partition_to_qos(self):
        qos_text = "GPU-1|cpu=26,gres/gpu:nvidia_a40=1,mem=256G,node=1|7-00:00:00|30|4|30||DenyOnLimit"
        partition_text = (
            "PartitionName=GPU-1 AllowGroups=ALL AllowAccounts=ALL AllowQos=normal,GPU-1 "
            "AllocNodes=ALL Default=NO QoS=GPU-1 Nodes=spcc-a40g[01-20] State=UP"
        )

        snap = build_policy_snapshot(qos_text, partition_text, now=123, interval=86400)

        self.assertEqual(snap["generated_at"], 123)
        self.assertEqual(snap["partition_caps"]["GPU-1"]["maxGpus"], 1)
        self.assertEqual(snap["partition_policies"]["GPU-1"]["grpJobs"], 30)
        self.assertEqual(snap["partitions"]["GPU-1"]["nodes"], "spcc-a40g[01-20]")


class QueueParserTests(unittest.TestCase):
    def test_parse_queue_multiplies_gres_per_node_by_node_count(self):
        line = SEP.join(
            [
                "332522",
                "user01",
                "student",
                "GPU-L",
                "RUNNING",
                "None",
                "2",
                "52",
                "gpu:nvidia_a40:2",
                "2026-06-30T12:00:00",
                "2026-06-30T13:00:00",
                "N/A",
                "59:00",
                "train",
                "gpu-l",
                "spcc-a40g[13,17]",
                "01:00",
                "1:00:00",
                "512G",
            ],
        )

        job = parse_queue(line)["jobs"][0]

        self.assertEqual(job["gpus"], 4)
        self.assertEqual(job["gpu_type"], "nvidia_a40")
        self.assertEqual(job["node_count"], 2)
        self.assertEqual(job["min_memory_mb"], 524288)
        self.assertEqual(job["nodelist"], "spcc-a40g[13,17]")

    def test_parse_queue_prefers_tres_alloc_over_ambiguous_squeue_fields(self):
        # %m prints MinMemoryCPU=6000M as a bare "6000M" — without tres-alloc the
        # 64-CPU job below would show 6 GB instead of its real 375 GiB.
        line = SEP.join(
            [
                "378759", "user02", "student", "DEF", "RUNNING", "None",
                "1", "64", "N/A", "2026-06-30T12:00:00", "2026-07-07T12:00:00",
                "N/A", "6-00:00:00", "calc", "normal", "lcpcc-043",
                "1-00:00:00", "7-00:00:00", "6000M",
            ],
        )
        extras = {"378759": {"tres": "cpu=64,mem=375G,node=1,billing=64", "container": ""}}

        job = parse_queue(line, extras)["jobs"][0]

        self.assertEqual(job["min_memory_mb"], 384000)
        self.assertEqual(job["gpus"], 0)
        self.assertEqual(job["gpu_type"], "")

        # --gpus-style jobs report %b as N/A; the GPU count must come from tres.
        extras_gpu = {"378759": {"tres": "cpu=26,mem=260000M,node=1,gres/gpu:h100-20c=1", "container": ""}}
        job = parse_queue(line, extras_gpu)["jobs"][0]
        self.assertEqual(job["gpus"], 1)
        self.assertEqual(job["gpu_type"], "h100-20c")

        # Pending jobs: tres-alloc's GPU type is a scheduler placeholder, not an
        # allocation — suppress it unless the user explicitly requested a type.
        pending = line.replace("RUNNING", "PENDING")
        job = parse_queue(pending, extras_gpu)["jobs"][0]
        self.assertEqual(job["gpus"], 1)
        self.assertEqual(job["gpu_type"], "")

    def test_parse_queue_uses_sacct_reqtres_for_pending_memory(self):
        # A pending 26-CPU job asking --mem-per-cpu=10000M: %m shows "10000M",
        # tres-alloc is null, and only sacct's ReqTRES has the 260000M total.
        # Without it the fit logic sees a 10 GB waiter that fits everywhere.
        line = SEP.join(
            [
                "406523", "user03", "student", "GPU-S", "PENDING", "Resources",
                "1", "26", "gpu:1", "2026-07-04T13:32:39", "N/A",
                "2026-07-09T01:45:25", "12:00:00", "interactive", "gpu-s", "",
                "0:00", "12:00:00", "10000M",
            ],
        )
        reqtres = parse_pending_reqtres(
            "406523|billing=26,cpu=26,gres/gpu:h100-20c=1,mem=260000M,node=1\n"
            "999999|cpu=1,mem=4G,node=1\n"
            "|\n",
        )

        job = parse_queue(line, None, reqtres)["jobs"][0]

        self.assertEqual(job["min_memory_mb"], 260000)
        self.assertEqual(job["min_memory"], "260000M")

        # Running jobs must keep trusting tres-alloc, not the pending map.
        running = line.replace("PENDING", "RUNNING")
        extras = {"406523": {"tres": "cpu=26,mem=240G,node=1", "container": ""}}
        job = parse_queue(running, extras, reqtres)["jobs"][0]
        self.assertEqual(job["min_memory_mb"], 245760)

    def test_parse_containers_slices_fixed_width_columns(self):
        line = "378759".ljust(64) + "cpu=64,mem=375G,node=1".ljust(256) + "docker://ubuntu:22.04"
        out = parse_containers(line)
        self.assertEqual(out["378759"]["tres"], "cpu=64,mem=375G,node=1")
        self.assertEqual(out["378759"]["container"], "docker://ubuntu:22.04")

    def test_parse_cpu_submit_probes(self):
        raw = (
            "Job 333069 to start at 2026-06-30T12:30:00 "
            "using 256 processors on nodes lcpcc-[052,055,058] in partition SMALL"
        )
        row = SEP.join(["SMALL", "0", raw])

        probe = parse_cpu_submit_probes(row)[0]

        self.assertTrue(probe["ok"])
        self.assertEqual(probe["partition"], "SMALL")
        self.assertEqual(probe["processors"], 256)
        self.assertEqual(probe["nodes"], "lcpcc-[052,055,058]")


if __name__ == "__main__":
    unittest.main()
