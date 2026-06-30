import unittest

from backend.sources import (
    SEP,
    _parse_tres,
    _wall_compact,
    build_policy_snapshot,
    parse_cpu_submit_probes,
    parse_qos_policies,
    parse_queue,
)


class TresPolicyTests(unittest.TestCase):
    def test_parse_tres_treats_typed_and_generic_gpu_as_same_limit(self):
        self.assertEqual(
            _parse_tres("cpu=26,gres/gpu:nvidia_a40=1,gres/gpu=1,mem=256G,node=1"),
            {"cores": 26, "mem_gb": 256, "nodes": 1, "gpus": 1},
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
        self.assertEqual(job["node_count"], 2)
        self.assertEqual(job["min_memory_mb"], 524288)
        self.assertEqual(job["nodelist"], "spcc-a40g[13,17]")

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
