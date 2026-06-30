import unittest

from backend.normalize import normalize


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


if __name__ == "__main__":
    unittest.main()
