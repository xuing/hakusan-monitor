"""What the dashboard calls this cluster's hardware, and the site's own copy.

Nothing here is required. Without a site file the dashboard reads everything
from Slurm: GPU nodes are grouped by GPU model, CPU nodes by core count and
memory, partitions keep `scontrol show partition` order, and the name is
Slurm's ClusterName. HM_SITE points at a JSON file (sites/hakusan.json is a
complete example) that names the pools, labels GPU models, orders partitions
and adds site links and text. Unknown keys are ignored.
"""
from __future__ import annotations
import json
import math
import re

try:
    from normalize import parse_gres, num
except ImportError:  # imported as backend.site_config (tests)
    from backend.normalize import parse_gres, num

LANGS = ("en", "zh", "ja")
_VENDOR = re.compile(r"^(nvidia|amd|intel)[_-]", re.I)


def load(path):
    """Site from a JSON file; an empty path gives the all-automatic site."""
    if not path:
        return Site()
    with open(path, encoding="utf-8") as f:
        return Site(json.load(f))


def _slug(text):
    return re.sub(r"[^a-z0-9.]+", "-", str(text).lower()).strip("-") or "gpu"


def gpu_pool_id(gtype):
    """'nvidia_a40' -> 'a40', 'h100-80c' -> 'h100-80c'."""
    return _slug(_VENDOR.sub("", gtype))


def gpu_label(gtype):
    """Readable name for a gres type nobody configured: 'nvidia_a40' -> 'A40',
    'nvidia_rtx_pro_6000' -> 'RTX PRO 6000'."""
    return _VENDOR.sub("", gtype).replace("_", " ").upper() or "GPU"


def _mem_bucket_gb(real_memory_mb):
    """Node memory rounded up to 16 GiB, so nodes whose RealMemory differs by a
    few MB (BIOS, firmware) stay in one group. RealMemory sits a little under
    the installed size, so rounding up names it: 515306 MB -> 512."""
    return int(math.ceil((real_memory_mb or 0) / 1024 / 16) * 16)


class Site:
    def __init__(self, cfg=None):
        cfg = dict(cfg or {})
        self.cfg = cfg
        pools = [p for p in cfg.get("pools") or [] if p.get("id")]
        self.rules = [(p["id"], re.compile(p["nodes"])) for p in pools if p.get("nodes")]
        self.pool_order = [p["id"] for p in pools]
        self.pool_labels = {p["id"]: p["label"] for p in pools if p.get("label")}
        self.sample_partitions = {p["id"]: p["sample_partition"] for p in pools
                                  if p.get("sample_partition")}
        self.gpus = dict(cfg.get("gpus") or {})
        self.partition_order = list(cfg.get("partition_order") or [])
        self.cpu_probe_order = list(cfg.get("cpu_probe_order") or [])
        self.job_submit_lua = cfg.get("job_submit_lua") or ""

    # ---- GPUs ---------------------------------------------------------------
    def gpu_info(self, gtype):
        g = self.gpus.get(gtype) or {}
        return {"label": g.get("label") or gpu_label(gtype or "GPU"), "mem_gb": g.get("mem_gb")}

    def gpu_rank(self, gtype):
        order = list(self.gpus)
        return (order.index(gtype), "") if gtype in order else (len(order), gtype)

    # ---- pools --------------------------------------------------------------
    def assign_pools(self, nodes):
        """{node name: pool id} for every node, in a partition or not.

        A configured rule (first regex that matches the node name) wins. Other
        GPU nodes go to a pool per GPU model ("a100"), other CPU nodes to one
        per node shape ("cpu-64c-256g"). An automatic id depends only on the
        node itself, never on what else is in the cluster: ids are stored with
        the history, so new hardware must not rename an existing pool. One
        that collides with a configured pool id gets an "-auto" suffix rather
        than silently joining that pool.
        """
        out = {}
        configured = set(self.pool_order)
        for nd in nodes or []:
            name = nd.get("name") or ""
            if not name:
                continue
            pid = next((pid for pid, rx in self.rules if rx.search(name)), None)
            if pid:
                out[name] = pid
                continue
            gres = parse_gres(nd.get("gres"))
            if gres:
                pid = gpu_pool_id(gres.most_common(1)[0][0])
            else:
                cores = num(nd.get("cpus")) or 0
                pid = f"cpu-{cores}c-{_mem_bucket_gb(num(nd.get('real_memory')))}g"
            out[name] = f"{pid}-auto" if pid in configured else pid
        return out

    def pool_rank(self, pool):
        """Sort key: configured pools in file order, then GPU pools, then CPU
        pools with the most nodes first."""
        pid = pool["id"]
        if pid in self.pool_order:
            return (0, self.pool_order.index(pid), "")
        if pool.get("kind") == "gpu":
            return (1, 0, (pool.get("gpu") or {}).get("label") or pid)
        return (2, -(pool.get("nodes") or 0), pid)

    def sample_partition(self, pool, policy, shared=()):
        """The partition a pool's starter command uses: the configured one,
        else one that reaches only this pool's nodes (a partition spanning
        several pools could place the job on other hardware) — Slurm's
        default partition first, then display order."""
        parts = pool.get("partitions") or []
        pick = self.sample_partitions.get(pool["id"])
        if pick in parts:
            return pick
        live = (policy or {}).get("partitions") or {}
        order = self.display_order(policy)
        return min(parts, key=lambda p: (p in shared, not (live.get(p) or {}).get("default"),
                                         order.index(p) if p in order else len(order), p),
                   default=None)

    # ---- partitions -----------------------------------------------------------
    def display_order(self, policy):
        """Configured partition order, else the order slurm.conf lists them in."""
        if self.partition_order:
            return self.partition_order
        return list(((policy or {}).get("partitions") or {}).keys())

    def probe_order(self, policy):
        return self.cpu_probe_order or self.display_order(policy)

    # ---- what the browser gets ----------------------------------------------
    def cluster_name(self, policy):
        return self.cfg.get("cluster") or (policy or {}).get("cluster_name") or "slurm"

    def public(self, policy):
        """/api/site: names, links, page switches, partition order and the
        site's own strings (merged over the built-in ones per language)."""
        cluster = self.cluster_name(policy)
        strings = {lang: dict(((self.cfg.get("strings") or {}).get(lang)) or {}) for lang in LANGS}
        for pid, label in self.pool_labels.items():
            for lang in LANGS:
                text = (label.get(lang) or label.get("en")) if isinstance(label, dict) else label
                if text:
                    strings[lang].setdefault(f"pool.{pid}", text)
        return {
            "cluster": cluster,
            "name": self.cfg.get("name") or cluster[:1].upper() + cluster[1:],
            "org": self.cfg.get("org") or "",
            "links": dict(self.cfg.get("links") or {}),
            "pages": {"slurm_guide": bool((self.cfg.get("pages") or {}).get("slurm_guide"))},
            # partition the Containers page's interactive example uses (none: Slurm's default)
            "container_shell_partition": (self.cfg.get("containers") or {}).get("shell_partition") or "",
            "partition_order": self.display_order(policy),
            "strings": strings,
        }
