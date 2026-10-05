import os
import unittest

from backend.lua_policy import parse_job_submit_lua, strip_lua_comments

HERE = os.path.dirname(__file__)


def sample():
    with open(os.path.join(HERE, "fixtures", "job_submit_sample.lua")) as f:
        return f.read()


class LuaPolicyTests(unittest.TestCase):
    def test_reads_defaults_per_partition(self):
        p = parse_job_submit_lua(sample())

        self.assertEqual(p["CPU-T"]["default_tasks"], 16)
        self.assertEqual(p["CPU-T"]["default_cpus"], 16)
        self.assertNotIn("interactive_time_min", p["CPU-T"])  # honors -t
        self.assertEqual(p["CPU-I"]["default_cpus"], 256)

    def test_code_wins_over_comments(self):
        # "-- 12 hours" sits above max_time = 2880, and a commented-out block
        # sets 9999 — only the live assignment counts.
        p = parse_job_submit_lua(sample())

        self.assertEqual(p["CPU-I"]["interactive_time_min"], 2880)
        self.assertNotIn("9999", strip_lua_comments(sample()))

    def test_flags_a_gpu_default_that_overwrites_gres_requests(self):
        # The 2026-06-11 plugin dropped `job_desc.gres ~= nil` from the check,
        # so --gres=gpu:2 became gpu:1 on every GPU partition.
        p = parse_job_submit_lua(sample())

        self.assertTrue(p["GPU-OLD"]["gpu_request_respected"])
        self.assertFalse(p["GPU-NEW"]["gpu_request_respected"])
        self.assertEqual(p["GPU-NEW"]["gpu_request_fields"], ["gpus", "gpus_per_node"])
        self.assertEqual(p["GPU-NEW"]["default_gpus_per_node"], 1)
        self.assertEqual(p["GPU-NEW"]["interactive_time_min"], 720)

    def test_license_requirement_and_scope(self):
        p = parse_job_submit_lua(sample())

        self.assertTrue(p["LIC"]["requires_license"])
        # a branch that fills in a license does not require one
        self.assertNotIn("requires_license", p["LICDEF"])
        self.assertEqual(p["LICDEF"]["default_license"], "ms_castep@lmgr:1")
        self.assertNotIn("IGNORED", p)  # slurm_job_modify is not the submit path

    def test_empty_source_gives_nothing(self):
        self.assertEqual(parse_job_submit_lua(""), {})


if __name__ == "__main__":
    unittest.main()
