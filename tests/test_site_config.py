import os
import unittest

from backend import site_config
from backend.normalize import normalize
from backend.sources import build_policy_snapshot, cpu_test_partitions, parse_singularity_version

HAKUSAN_PATH = os.path.join(os.path.dirname(__file__), "..", "sites", "hakusan.json")


def node(name, cpus, mem_mb, gres="", partitions=("p",)):
    return {"name": name, "cpus": cpus, "real_memory": mem_mb, "gres": gres,
            "gres_used": "", "alloc_cpus": 0, "alloc_memory": 0,
            "state": ["IDLE"], "partitions": list(partitions)}


class AutoPoolTests(unittest.TestCase):
    """No site file: pools come from the nodes themselves."""

    def test_cpu_pools_are_named_by_node_shape(self):
        site = site_config.Site()
        pools = site.assign_pools([node("c1", 64, 257000), node("c2", 64, 256900)])
        self.assertEqual(pools, {"c1": "cpu-64c-256g", "c2": "cpu-64c-256g"})

    def test_new_hardware_does_not_rename_an_existing_pool(self):
        # ids go into the history, so they depend only on the node itself
        site = site_config.Site()
        before = site.assign_pools([node("c1", 64, 257000)])
        after = site.assign_pools([node("c1", 64, 257000), node("m1", 128, 2060000)])
        self.assertEqual(before["c1"], after["c1"])

    def test_gpu_nodes_group_by_model_and_cpu_nodes_by_shape(self):
        site = site_config.Site()
        pools = site.assign_pools([
            node("g1", 32, 500000, "gpu:nvidia_a100:4(S:0-1)"),
            node("g2", 32, 500000, "gpu:nvidia_l40s:2"),
            node("c2", 128, 515000), node("m1", 128, 2060000),
        ])
        self.assertEqual(pools["g1"], "a100")
        self.assertEqual(pools["g2"], "l40s")
        self.assertEqual(pools["c2"], "cpu-128c-512g")
        self.assertEqual(pools["m1"], "cpu-128c-2016g")

    def test_unmatched_nodes_never_join_a_configured_pool(self):
        site = site_config.Site({"pools": [{"id": "a100", "nodes": "^gpu"},
                                           {"id": "cpu-64c-256g", "nodes": "^cn"}]})
        pools = site.assign_pools([node("gpu1", 32, 500000, "gpu:nvidia_a100:4"),
                                   node("x1", 32, 500000, "gpu:nvidia_a100:4"),
                                   node("cn1", 64, 257000), node("y1", 64, 257000)])
        self.assertEqual(pools, {"gpu1": "a100", "x1": "a100-auto",
                                 "cn1": "cpu-64c-256g", "y1": "cpu-64c-256g-auto"})

    def test_snapshot_without_site_file(self):
        snap = normalize({"nodes": [node("g1", 32, 500000, "gpu:nvidia_a100:4", ["gpu"]),
                                    node("c1", 64, 257000, partitions=["cpu"])]},
                         {"jobs": []}, site=site_config.Site())
        self.assertEqual([p["id"] for p in snap["pools"]], ["a100", "cpu-64c-256g"])
        gpu = snap["pools"][0]
        self.assertEqual(gpu["kind"], "gpu")
        self.assertEqual(gpu["gpu"]["label"], "A100")
        self.assertIsNone(gpu["gpu"]["mem_gb"])   # unknown unless the site file says

    def test_sample_partition_prefers_slurm_default(self):
        site = site_config.Site()
        policy = {"partitions": {"short": {}, "normal": {"default": True}}}
        self.assertEqual(site.sample_partition({"id": "cpu", "partitions": ["normal", "short"]}, policy), "normal")
        self.assertEqual(site.sample_partition({"id": "cpu", "partitions": ["short", "x"]}, policy), "short")

    def test_sample_partition_avoids_one_spanning_other_pools(self):
        # a default partition over every node could start the job on other hardware
        site = site_config.Site()
        policy = {"partitions": {"all": {"default": True}, "gpu": {}}}
        pool = {"id": "a100", "partitions": ["all", "gpu"]}
        self.assertEqual(site.sample_partition(pool, policy, shared={"all"}), "gpu")
        self.assertEqual(site.sample_partition({"id": "cpu", "partitions": ["all"]}, policy, shared={"all"}), "all")

    def test_partition_order_follows_slurm_conf(self):
        policy = build_policy_snapshot("", "PartitionName=b Nodes=n1\nPartitionName=a Nodes=n2\n"
                                           "ClusterName = mycluster", 0, 1)
        site = site_config.Site()
        self.assertEqual(site.display_order(policy), ["b", "a"])
        self.assertEqual(site.cluster_name(policy), "mycluster")
        self.assertEqual(site.public(policy)["name"], "Mycluster")


class HakusanSiteTests(unittest.TestCase):
    def test_rules_reproduce_the_hakusan_pools(self):
        site = site_config.load(HAKUSAN_PATH)
        names = {"lcpcc-001": "cpu", "spcc-a40g01": "a40", "spcc-a100g10": "a100",
                 "spcc-cld-gl01": "h100-80", "spcc-cld-g01": "h100-20c",
                 "spcc-cld-lm01": "lm", "spcc-cld-05": "vm-cpu"}
        pools = site.assign_pools([node(n, 32, 1000) for n in names])
        self.assertEqual(pools, names)

    def test_public_labels_cover_every_language(self):
        out = site_config.load(HAKUSAN_PATH).public(None)
        self.assertEqual(out["strings"]["zh"]["pool.vm-cpu"], "VM-CPU (云)")
        self.assertEqual(out["strings"]["ja"]["pool.a40"], "A40")
        self.assertTrue(out["pages"]["slurm_guide"])


class ProbeAndRuntimeTests(unittest.TestCase):
    def test_without_a_submit_plugin_every_cpu_partition_is_probed(self):
        parts = cpu_test_partitions({"lua": {"parsed": False}}, {"cpu", "gpu", "long"}, {"gpu"}, ["long"])
        self.assertEqual(parts, ["long", "cpu"])

    def test_runtime_name_from_version_line(self):
        self.assertEqual(parse_singularity_version("singularity-ce version 4.3.7-noble\n"),
                         {"runtime": "SingularityCE", "version": "4.3.7-noble"})
        self.assertEqual(parse_singularity_version("apptainer version 1.3.4"),
                         {"runtime": "Apptainer", "version": "1.3.4"})


if __name__ == "__main__":
    unittest.main()
