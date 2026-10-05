"""Read hakusan's job_submit.lua into per-partition facts.

The submit plugin rewrites every new job before it is queued: it fills in a
task/CPU/memory/GPU default when the user left one out, and pins the time
limit of interactive jobs (no batch script: salloc / bare srun). Those rules
are visible only in the Lua source (/app/slurm/job_submit.lua, world-readable
on the login nodes), so the dashboard reads them from there instead of
carrying its own copy.

The parser is deliberately literal. It strips comments first — the file's
comments disagree with its code ("-- 12 hours" above `max_time = 2880`) and a
whole commented-out block sits at the top — then reads only plain
assignments inside each `job_desc.partition == "NAME"` branch. Anything it
cannot read stays absent; scripts/check_cluster_policy.py then verifies the
reading against what Slurm actually does with a held job.
"""
from __future__ import annotations

import re

_HEADER = re.compile(r'(?:\bif|\belseif)\s*\(?\s*job_desc\.partition\s*==\s*"([^"]+)"\s*\)?\s*then')
_ASSIGN = re.compile(r"job_desc\.(num_tasks|min_cpus|cpus_per_task|pn_min_memory|time_limit)\s*=\s*(\d+)")
_GRES = re.compile(r'job_desc\.gres\s*=\s*"([^"]*)"')
_GPU_CHECK = re.compile(r"job_desc\.(gres|gpus|gpus_per_node|tres_per_node|tres_per_job|tres_per_task)\s*~=\s*nil")
_INTERACTIVE = re.compile(r"job_desc\.script\s*==\s*nil")
_MAX_TIME = re.compile(r"\blocal\s+max_time\s*=\s*(\d+)")
_LICENSE = re.compile(r"job_desc\.licenses\s*==\s*nil")
# the `if (job_desc.licenses == nil ...) then ... end` block: it either
# rejects the job (MatStudio) or fills a default (MS_Castep & co.)
_LICENSE_BLOCK = re.compile(r"if\s*\(\s*job_desc\.licenses\s*==\s*nil[^\n]*?then(.*?)\n\s*end\b", re.S)
_LICENSE_DEFAULT = re.compile(r'job_desc\.licenses\s*=\s*"([^"]+)"')
_GPU_COUNT = re.compile(r"gpu(?::[^:,]+)?:(\d+)")


def strip_lua_comments(text: str) -> str:
    """Drop `--[[ ... ]]` blocks and `-- ...` line comments (strings in this
    file never contain "--", so a plain scan is enough)."""
    text = re.sub(r"--\[(=*)\[.*?\]\1\]", "", text, flags=re.S)
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines())


def parse_job_submit_lua(text: str) -> dict:
    """{partition: facts} for every partition branch in slurm_job_submit().

    facts keys (absent when the branch does not set them):
      default_tasks / default_cpus / default_cpus_per_task — set when -n / -c
          are left out (the plugin pins NumTasks, so a bare -c multiplies)
      default_mem_per_node_mb — pn_min_memory default (may be pre-empted by the
          partition's DefMemPerCPU; the check script measures which wins)
      default_gpus_per_node — GPUs set by `job_desc.gres = "gpu:N"`
      gpu_request_fields — job_desc fields consulted before that default is
          applied; when "gres" is not among them a user's --gres is overwritten
      gpu_request_respected — False when the default replaces --gres requests
      interactive_time_min — forced time limit for jobs without a batch script
      requires_license — the branch rejects jobs without -L
      default_license — the -L the branch fills in when there is none
          ("ms_castep@lmgr:1"); the name may not exist on the cluster
    """
    if not text:
        return {}
    code = strip_lua_comments(text)
    func_end = code.find("function slurm_job_modify")
    if func_end != -1:
        code = code[:func_end]
    heads = list(_HEADER.finditer(code))
    out = {}
    for i, m in enumerate(heads):
        body = code[m.end(): heads[i + 1].start() if i + 1 < len(heads) else len(code)]
        out[m.group(1)] = _branch_facts(body, code[: m.start()].count("\n") + 1)
    return out


def _branch_facts(body: str, line: int) -> dict:
    facts: dict = {"line": line}
    interactive_at = None
    im = _INTERACTIVE.search(body)
    if im:
        interactive_at = im.start()
    for m in _ASSIGN.finditer(body):
        key, val = m.group(1), int(m.group(2))
        if interactive_at is not None and m.start() > interactive_at:
            continue  # inside the interactive branch; handled below
        if key == "num_tasks":
            facts["default_tasks"] = val
        elif key == "min_cpus":
            facts["default_cpus"] = val
        elif key == "cpus_per_task":
            facts["default_cpus_per_task"] = val
        elif key == "pn_min_memory":
            facts["default_mem_per_node_mb"] = val
    gres = _GRES.search(body)
    if gres:
        gm = _GPU_COUNT.search(gres.group(1))
        facts["default_gpus_per_node"] = int(gm.group(1)) if gm else 1
        checked = sorted(set(_GPU_CHECK.findall(body[: gres.start()])))
        facts["gpu_request_fields"] = checked
        # In Slurm's Lua API --gres/--gpus-per-node arrive in job_desc.gres
        # (tres_per_node); job_desc.gpus / gpus_per_node are not fields it
        # fills. Without a gres/tres check every GPU request is overwritten.
        facts["gpu_request_respected"] = bool(
            set(checked) & {"gres", "tres_per_node", "tres_per_job", "tres_per_task"})
    if interactive_at is not None:
        tail = body[interactive_at:]
        mt = _MAX_TIME.search(tail)
        tl = re.search(r"job_desc\.time_limit\s*=\s*(\d+)", tail)
        if mt:
            facts["interactive_time_min"] = int(mt.group(1))
        elif tl:
            facts["interactive_time_min"] = int(tl.group(1))
    if _LICENSE.search(body):
        block = _LICENSE_BLOCK.search(body)
        default = _LICENSE_DEFAULT.search(block.group(1)) if block else None
        if default:
            facts["default_license"] = default.group(1)
        # a default that is filled in is not a requirement; anything else
        # (an explicit reject, or a block we cannot read) is
        if not default or re.search(r"return\s+slurm\.ERROR", block.group(1)):
            facts["requires_license"] = True
    return facts
