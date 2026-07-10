import unittest

from backend.normalize import is_schedulable, normalize


class QueueSummaryTests(unittest.TestCase):
    def test_longest_pending_job_is_kept_per_partition(self):
        nodes = {
            "nodes": [
                {
                    "name": "lcpcc-001",
                    "state": ["IDLE"],
                    "partitions": ["DEF", "SMALL"],
                    "cpus": 256,
                    "alloc_cpus": 0,
                    "real_memory": 1543224,
                    "alloc_memory": 0,
                    "gres": "",
                    "gres_used": "",
                },
                {
                    "name": "spcc-a40g01",
                    "state": ["IDLE"],
                    "partitions": ["GPU-1"],
                    "cpus": 52,
                    "alloc_cpus": 0,
                    "real_memory": 515000,
                    "alloc_memory": 0,
                    "gres": "gpu:nvidia_a40:2",
                    "gres_used": "",
                },
            ],
        }
        jobs = {
            "jobs": [
                pending_job(101, "DEF", 100, cpus=16),
                pending_job(102, "DEF", 50, cpus=16),
                pending_job(201, "SMALL", 70, cpus=256),
                pending_job(301, "GPU-1", 80, cpus=26, gpus=1),
            ],
        }

        snap = normalize(nodes, jobs)
        by_part = {job["partition"]: job for job in snap["queue"]["longest_pending_by_partition"]}

        self.assertEqual(by_part["DEF"]["job_id"], 102)
        self.assertEqual(by_part["SMALL"]["job_id"], 201)
        self.assertEqual(by_part["GPU-1"]["job_id"], 301)
        self.assertEqual(by_part["GPU-1"]["gpu"], "A40×1")

    def test_next_gpu_release_includes_cards_at_the_earliest_end_time(self):
        node = raw_node(
            state=["ALLOCATED"], cpus=52, alloc=52,
            gres="gpu:nvidia_a40:4", gres_used="gpu:nvidia_a40:4",
        )
        jobs = {
            "jobs": [
                running_gpu_job(1, "2026-07-10T13:00:00", "01:00:00", 1),
                running_gpu_job(2, "2026-07-10T13:00:00", "01:00:00", 2),
                running_gpu_job(3, "2026-07-10T14:00:00", "02:00:00", 1),
            ],
        }

        snap = normalize({"nodes": [node]}, jobs)

        self.assertEqual(
            snap["pools"][0]["gpu"]["next_free"],
            {"at": "2026-07-10T13:00:00", "left": "01:00:00", "gpus": 3},
        )


class NodeAvailabilityTests(unittest.TestCase):
    def test_draining_mixed_node_contributes_no_free_capacity(self):
        snap = normalize(
            {"nodes": [raw_node(state=["MIXED", "DRAIN"], cpus=10, alloc=5,
                                gres="gpu:nvidia_a40:2", gres_used="gpu:nvidia_a40:1")]},
            {"jobs": []},
        )

        pool = snap["pools"][0]
        part = snap["partitions"][0]
        self.assertEqual(snap["totals"]["nodes"]["available"], 0)
        self.assertEqual(snap["totals"]["cpus"]["free"], 0)
        self.assertEqual(snap["totals"]["gpus"]["free"], 0)
        self.assertEqual(pool["cores"]["free"], 0)
        self.assertEqual(pool["gpu"]["free"], 0)
        self.assertEqual(part["cpus"]["free"], 0)
        self.assertEqual(part["gpu"]["free"], 0)
        self.assertEqual(len(snap["nodes_down"]), 1)

    def test_reserved_and_planned_nodes_are_not_requestable(self):
        for state in (["RESERVED"], ["IDLE", "PLANNED"], ["IDLE", "MAINT"]):
            with self.subTest(state=state):
                snap = normalize(
                    {"nodes": [raw_node(state=state, cpus=10, alloc=0, gres="", gres_used="")]},
                    {"jobs": []},
                )
                pool = snap["pools"][0]
                self.assertEqual(snap["totals"]["nodes"]["available"], 0)
                self.assertEqual(snap["totals"]["nodes"]["cpu_free"], 0)
                self.assertEqual(snap["totals"]["cpus"]["free"], 0)
                self.assertEqual(pool["available_nodes"], 0)
                self.assertEqual(pool["cores"]["free"], 0)

    def test_planned_gpu_is_reserved_not_down(self):
        snap = normalize(
            {"nodes": [raw_node(
                state=["MIXED", "PLANNED"], cpus=10, alloc=5,
                gres="gpu:nvidia_a40:2", gres_used="gpu:nvidia_a40:1",
            )]},
            {"jobs": []},
        )

        gpu = snap["pools"][0]["gpu"]
        self.assertEqual(gpu["used"], 1)
        self.assertEqual(gpu["reserved"], 1)
        self.assertEqual(gpu["down"], 0)
        self.assertEqual(gpu["free"], 0)
        self.assertEqual(snap["totals"]["nodes"]["down"], 0)

    def test_schedulable_state_matrix(self):
        self.assertTrue(is_schedulable(["IDLE"]))
        self.assertTrue(is_schedulable(["MIXED"]))
        self.assertFalse(is_schedulable(["ALLOCATED"]))
        self.assertFalse(is_schedulable(["MIXED", "DRAIN"]))
        self.assertFalse(is_schedulable(["IDLE", "PLANNED"]))
        self.assertFalse(is_schedulable(["RESERVED"]))
        self.assertFalse(is_schedulable(["IDLE", "POWERING_UP"]))

    def test_bucket_state_flags_beat_base_states(self):
        from backend.normalize import bucket_state
        # scheduler holds on an idle node are not free capacity
        self.assertEqual(bucket_state(["IDLE", "PLANNED"]), "reserved")
        self.assertEqual(bucket_state(["IDLE", "RESERVED"]), "reserved")
        # a node running jobs is busy first, reservation or not
        self.assertEqual(bucket_state(["MIXED", "PLANNED"]), "mixed")
        # maintenance counts with drain so all-maint partitions read as maint
        self.assertEqual(bucket_state(["IDLE", "MAINT"]), "drain")
        self.assertEqual(bucket_state(["IDLE"]), "idle")

    def test_duplicate_node_name_is_counted_once_last_value_wins(self):
        first = raw_node(name="lcpcc-001", state=["IDLE"], cpus=10, alloc=0, gres="", gres_used="")
        last = raw_node(name="lcpcc-001", state=["ALLOCATED"], cpus=10, alloc=10, gres="", gres_used="")

        snap = normalize({"nodes": [first, last]}, {"jobs": []})

        self.assertEqual(snap["totals"]["nodes"]["total"], 1)
        self.assertEqual(snap["totals"]["cpus"]["total"], 10)
        self.assertEqual(snap["totals"]["cpus"]["alloc"], 10)
        self.assertEqual(snap["diagnostics"]["duplicate_nodes"], ["lcpcc-001"])

    def test_native_slurm_number_object_works_for_partition_memory_spec(self):
        node = raw_node(state=["IDLE"], cpus=10, alloc=0, gres="", gres_used="")
        node["real_memory"] = {"set": True, "number": 2048}
        node["alloc_memory"] = {"set": True, "number": 0}

        snap = normalize({"nodes": [node]}, {"jobs": []})

        self.assertEqual(snap["partitions"][0]["spec"]["mem_per_node"], 2048)


def pending_job(job_id, partition, submit_time, *, cpus, gpus=0):
    return {
        "job_id": job_id,
        "user_name": "user01",
        "partition": partition,
        "job_state": "PENDING",
        "state_reason": "Priority",
        "node_count": 1,
        "cpus": cpus,
        "gpus": gpus,
        "submit_time": submit_time,
        "start_est": "",
    }


def running_gpu_job(job_id, end_time, time_left, gpus):
    return {
        "job_id": job_id,
        "user_name": "user01",
        "partition": "P",
        "job_state": "RUNNING",
        "state_reason": "None",
        "node_count": 1,
        "cpus": 13,
        "gpus": gpus,
        "tres_req_str": f"gres/gpu:nvidia_a40={gpus}",
        "end_time": end_time,
        "time_left": time_left,
    }


def raw_node(*, name="spcc-a40g01", state, cpus, alloc, gres, gres_used):
    return {
        "name": name,
        "state": state,
        "partitions": ["P"],
        "cpus": cpus,
        "alloc_cpus": alloc,
        "real_memory": 4096,
        "alloc_memory": 0,
        "gres": gres,
        "gres_used": gres_used,
    }


if __name__ == "__main__":
    unittest.main()
