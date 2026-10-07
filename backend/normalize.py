"""Pure transforms: Slurm JSON  ->  compact Hakusan Monitor snapshot.

No I/O here so it stays unit-testable. Input is the node and job dicts
sources.py parses from Slurm's compact output, in the shapes of
`scontrol show nodes --json` and `squeue --json` (Slurm 25.05).
"""
from __future__ import annotations
import re
from collections import defaultdict, Counter

# GPU model names may contain dots (QoS seminar: gres/gpu:nvidia_rtx_pro_6000_
# blackwell_server_edition_1g.24gb) — a class without "." parsed them as 0.
_GRES_RE = re.compile(r"gpu:([A-Za-z0-9_.\-]+):(\d+)")


def num(v, default=0):
    """Unwrap Slurm's {set,infinite,number} objects (or pass through ints)."""
    if isinstance(v, dict):
        if v.get("infinite"):
            return None
        return v.get("number", default) if v.get("set", True) else default
    return v if v is not None else default


def parse_gres(s):
    """'gpu:nvidia_a40:2(S:0-1),gpu:h100-80c:1' -> {'nvidia_a40':2,'h100-80c':1}"""
    out = Counter()
    if not s or s in ("N/A", "(null)"):
        return out
    for m in _GRES_RE.finditer(s):
        out[m.group(1)] += int(m.group(2))
    return out


# ---- node state bucketing ----------------------------------------------------
def state_list(node):
    s = node.get("state")
    if isinstance(s, list):
        return [str(x).upper() for x in s]
    return [str(s).upper()] if s else []


def bucket_state(states):
    # Slurm ships composite states ("IDLE+PLANNED", "MIXED+DRAIN"), so flag
    # checks must run before base states or they are dead branches. Order:
    # outage flags, then maintenance/drain, then busy base states (a node
    # running jobs is "busy" even under a future reservation), then scheduler
    # holds — an idle node under RESERVED/PLANNED/FUTURE is NOT free capacity
    # and must never land in the "idle" bucket that feeds idle_nodes.
    s = set(states)
    if s & {"DOWN", "NOT_RESPONDING", "FAIL", "FAILING", "POWERED_DOWN"}:
        return "down"
    if s & {"DRAIN", "DRAINING", "MAINT", "MAINTENANCE"}:
        return "drain"
    if "ALLOCATED" in s:
        return "allocated"
    if "MIXED" in s:
        return "mixed"
    if s & {"RESERVED", "PLANNED", "FUTURE"}:
        return "reserved"
    if "IDLE" in s:
        return "idle"
    return "other"


# A node can accept ordinary user work only in an IDLE/MIXED base state and
# without a Slurm flag that removes it from scheduling. Keep this rule here as
# the single source of truth; the raw snapshot ships the result to the client.
# Slurm prints the maintenance flag as "MAINTENANCE" (slurm_protocol_defs.c);
# "MAINT" is kept for older releases. REBOOT_REQUESTED alone does not block:
# a plain `scontrol reboot` only makes the node a last choice
# (cons_tres job_test.c), the ASAP form adds DRAIN.
_BLOCKING_STATES = {
    "DOWN", "NOT_RESPONDING", "DRAIN", "DRAINING", "FAIL", "FAILING",
    "RESERVED", "PLANNED", "MAINT", "MAINTENANCE", "FUTURE", "UNKNOWN",
    "POWER_DOWN", "POWERING_DOWN", "POWERED_DOWN", "POWERING_UP",
    "REBOOT_ISSUED",
}


def is_schedulable(states):
    s = {str(state).upper() for state in states}
    return bool(s & {"IDLE", "MIXED"}) and not bool(s & _BLOCKING_STATES)


def idle_gpu_bucket(states):
    """Where a node's idle GPUs go when no job can take them now.

    "down": an operator took the node out (needs_attention). "reserved": the
    scheduler holds the node for a queued job (PLANNED/RESERVED/...).
    "short": every core is allocated (ALLOCATED means CPUAlloc = CPUEfctv,
    api/node_info.c), so the GPU waits for a core. None: free. Keep in sync
    with the frontend's nodeIsSchedulerHeld (web/src/lib/derive.ts).
    """
    if is_schedulable(states):
        return None
    if needs_attention(states):
        return "down"
    s = {str(state).upper() for state in states}
    if s & _BLOCKING_STATES:
        return "reserved"
    return "short" if "ALLOCATED" in s else None


def needs_attention(states):
    s = {str(state).upper() for state in states}
    return bool(s & {
        "DOWN", "NOT_RESPONDING", "DRAIN", "DRAINING", "FAIL", "FAILING",
        "MAINT", "MAINTENANCE", "POWER_DOWN", "POWERING_DOWN", "POWERED_DOWN",
        # a rebooting node is an outage in progress, not a scheduler hold —
        # keep this in sync with the frontend's backfill-candidate exclusions
        "REBOOT_ISSUED",
    })


def mask_user(u, mask):
    if not mask or not u:
        return u
    return (u[:2] + "***") if len(u) > 2 else "***"


def cluster_nodes(nodes_json):
    """Only nodes some Slurm partition reaches: hardware scontrol lists but no
    partition schedules (on Hakusan, the H100 MIG VM hosts) is not part of
    this cluster for anyone submitting here."""
    nodes = (nodes_json or {}).get("nodes", []) or []
    return {**(nodes_json or {}), "nodes": [nd for nd in nodes if nd.get("partitions")]}


def outside_nodes(nodes_json, pool_of, site):
    """What cluster_nodes() leaves out, per hardware pool: {pool, label,
    nodes, gpus}. The page names it so the hardware is not simply missing.
    pool_of maps every node name to its pool (Site.assign_pools)."""
    groups = {}
    for nd in (nodes_json or {}).get("nodes", []) or []:
        if nd.get("partitions"):
            continue
        pool = pool_of.get(nd.get("name", ""), "other")
        g = groups.setdefault(pool, {"pool": pool, "label": "", "nodes": 0, "gpus": 0})
        g["nodes"] += 1
        for gtype, n in parse_gres(nd.get("gres")).items():
            g["gpus"] += n
            g["label"] = site.gpu_info(gtype)["label"]
    return sorted(groups.values(), key=lambda g: g["pool"])


def normalize(nodes_json, squeue_json, *, site, pool_of=None, cluster="slurm",
              slurm_version="", mask_users=False):
    """site: site_config.Site (pool rules, GPU labels, orders). pool_of:
    {node name: pool id}, computed from the nodes when not given."""
    nodes = (nodes_json or {}).get("nodes", []) or []
    if pool_of is None:
        pool_of = site.assign_pools(nodes)
    jobs = (squeue_json or {}).get("jobs", []) or []

    # The compact scontrol source normally emits one row per node, but name is
    # the physical identity and therefore the normalization invariant. Last row
    # wins so a later, fresher observation replaces an earlier duplicate.
    by_name = {}
    for nd in nodes:
        name = nd.get("name", "")
        if not name:
            continue
        by_name[name] = nd
    nodes = list(by_name.values())

    # ---- per-node pass -------------------------------------------------------
    pools = {}            # id -> accumulator
    part_nodes = defaultdict(list)
    nodes_down = []

    for nd in nodes:
        name = nd.get("name", "")
        if not name:
            continue
        states = state_list(nd)
        b = bucket_state(states)
        cpus = num(nd.get("cpus")) or 0
        acpu = num(nd.get("alloc_cpus")) or 0
        rmem = num(nd.get("real_memory")) or 0

        g_tot = parse_gres(nd.get("gres"))
        g_use = parse_gres(nd.get("gres_used"))
        node_up = is_schedulable(states)
        gpu_bucket_name = idle_gpu_bucket(states)

        pid = pool_of.get(name, "other")
        pa = pools.setdefault(pid, dict(id=pid, kind="cpu",
                                        nodes=0, cpus_total=0, cpus_alloc=0, other_cores=0,
                                        mem_per_node=0, states=Counter(),
                                        gpu_total=Counter(), gpu_used=Counter(),
                                        gpu_down=Counter(), gpu_reserved=Counter(), gpu_short=Counter(),
                                        available_nodes=0,
                                        down_nodes=0,
                                        parts=set()))
        pa["nodes"] += 1
        pa["cpus_total"] += cpus
        pa["cpus_alloc"] += acpu
        pa["mem_per_node"] = max(pa["mem_per_node"], rmem)
        pa["states"][b] += 1
        pa["gpu_total"] += g_tot
        pa["gpu_used"] += g_use
        if g_tot:
            pa["kind"] = "gpu"
        if node_up:
            if g_tot and (sum(g_tot.values()) - sum(g_use.values())) > 0:
                pa["available_nodes"] += 1
            elif not g_tot and (cpus - acpu) > 0:
                pa["available_nodes"] += 1
        if gpu_bucket_name:
            gpu_bucket = pa[f"gpu_{gpu_bucket_name}"]
            gpu_bucket += Counter({k: max(v - g_use.get(k, 0), 0)
                                   for k, v in g_tot.items()})
        if not node_up:
            pa["other_cores"] += cpus - acpu
        if needs_attention(states):
            pa["down_nodes"] += 1

        for p in (nd.get("partitions") or []):
            part_nodes[p].append((nd, b, cpus, acpu, g_tot, g_use))
            pa["parts"].add(p)

        if needs_attention(states):
            nodes_down.append({"name": name, "state": states,
                               "pool": pid, "reason": nd.get("reason") or ""})

    # partition -> dominant GPU type (GPU jobs report only a count, not a type)
    # partition -> hardware pool (its nodes' pool)
    part_gpu_type = {}
    part_pool = {}
    for p, members in part_nodes.items():
        c = Counter()
        poolc = Counter()
        for m in members:
            c.update(m[4])
            poolc[pool_of.get(m[0].get("name", ""), "other")] += 1
        if c:
            part_gpu_type[p] = c.most_common(1)[0][0]
        if poolc:
            part_pool[p] = poolc.most_common(1)[0][0]

    # ---- queue pass ----------------------------------------------------------
    run_by_part = Counter()
    pend_by_part = Counter()
    pend_reasons = Counter()
    running = pending = container_jobs = 0
    pending_jobs = []
    longest_pending_by_part = {}
    releases = []                # running jobs that will free resources, by end time
    next_free = {}               # gpu type -> soonest {at, left, gpus} release
    pool_run = Counter()
    pool_pend = Counter()

    def gpu_label(gtype, n):
        lbl = site.gpu_info(gtype)["label"] if gtype else "GPU"
        return f"{lbl}×{n}"

    for j in jobs:
        st = j.get("job_state")
        st = st[0] if isinstance(st, list) and st else st
        parts = [p for p in str(j.get("partition", "")).split(",") if p]
        if st == "RUNNING":
            running += 1
            left = j.get("time_left") or ""
            for p in parts:
                run_by_part[p] += 1
            for pool in {part_pool.get(p) for p in parts if p in part_pool}:
                pool_run[pool] += 1
            u = j.get("user_name", "")
            end = j.get("end_time") or ""
            if end:
                gp = num(j.get("gpus")) or 0
                gtype = part_gpu_type.get(parts[0]) if (gp and parts) else None
                releases.append({
                    "job_id": num(j.get("job_id")),
                    "user": mask_user(u, mask_users),
                    "partition": parts[0] if parts else "",
                    "pool": part_pool.get(parts[0]) if parts else None,
                    "end_time": end, "time_left": left,
                    "gpu_type": gtype, "gpus": gp,
                    "gpu": gpu_label(gtype, gp) if gp else "",
                    "cpus": num(j.get("cpus")) or 0,
                })
                if gp and gtype:
                    current = next_free.get(gtype)
                    if current is None or end < current["at"]:
                        next_free[gtype] = {"at": end, "left": left, "gpus": gp}
                    elif end == current["at"]:
                        current["gpus"] += gp
        elif st == "PENDING":
            pending += 1
            reason = j.get("state_reason") or "None"
            pend_reasons[reason] += 1
            for p in parts:
                pend_by_part[p] += 1
            for pool in {part_pool.get(p) for p in parts if p in part_pool}:
                pool_pend[pool] += 1
            gp = j.get("gpus", 0)
            pending_parts = parts or [""]
            pending_records = []
            for p in pending_parts:
                gtype = part_gpu_type.get(p) if gp else None
                record = {
                    "job_id": num(j.get("job_id")),
                    "user": mask_user(j.get("user_name", ""), mask_users),
                    "partition": p,
                    "gpu": gpu_label(gtype, gp) if gp else "",
                    "cpus": num(j.get("cpus")),
                    "reason": reason,
                    "submit_time": num(j.get("submit_time")),
                    "start_est": j.get("start_est") or "",
                }
                pending_records.append(record)
                current = longest_pending_by_part.get(p)
                if current is None or pending_sort_key(record) < pending_sort_key(current):
                    longest_pending_by_part[p] = record
            pending_jobs.append(pending_records[0])
        if j.get("container"):
            container_jobs += 1

    # ---- partitions ----------------------------------------------------------
    partitions = []
    for p, members in part_nodes.items():
        ct = sum(m[2] for m in members)
        ca = sum(m[3] for m in members)
        gt = sum(sum(m[4].values()) for m in members)
        gu = sum(sum(m[5].values()) for m in members)
        kind = "gpu" if gt > 0 else "cpu"
        gpu_down_part = sum(
            max(sum(g_tot.values()) - sum(g_use.values()), 0)
            for nd_m, _b, _cpus, _acpu, g_tot, g_use in members
            if idle_gpu_bucket(state_list(nd_m)) == "down"
        )
        gpu_reserved_part = sum(
            max(sum(g_tot.values()) - sum(g_use.values()), 0)
            for nd_m, _b, _cpus, _acpu, g_tot, g_use in members
            if idle_gpu_bucket(state_list(nd_m)) == "reserved"
        )
        gpu_short_part = sum(
            max(sum(g_tot.values()) - sum(g_use.values()), 0)
            for nd_m, _b, _cpus, _acpu, g_tot, g_use in members
            if idle_gpu_bucket(state_list(nd_m)) == "short"
        )
        cpu_util = (ca / ct) if ct else 0.0
        gpu_util = (gu / gt) if gt else 0.0
        states = Counter(m[1] for m in members)              # bucketed node states
        other_c = sum(
            cpus - acpu for nd_m, _b, cpus, acpu, _g_tot, _g_use in members
            if not is_schedulable(state_list(nd_m))
        )
        available_nodes = sum(
            1 for nd_m, b, cpus, acpu, g_tot, g_use in members
            if is_schedulable(state_list(nd_m)) and (
                (sum(g_tot.values()) - sum(g_use.values())) > 0 if kind == "gpu" else (cpus - acpu) > 0
            )
        )
        partitions.append({
            "name": p, "kind": kind, "nodes": len(members),
            # unavailable: unallocated cores on down/drained/held nodes, so
            # total = alloc + free + unavailable reconciles
            "cpus": {"total": ct, "alloc": ca, "free": max(ct - ca - other_c, 0),
                     "unavailable": other_c, "util": round(cpu_util, 3)},
            "gpu": ({"total": gt, "used": gu, "down": gpu_down_part,
                     "reserved": gpu_reserved_part, "short": gpu_short_part,
                     "free": max(gt - gu - gpu_down_part - gpu_reserved_part - gpu_short_part, 0),
                     "util": round(gpu_util, 3)} if gt else None),
            "pool": part_pool.get(p),
            "jobs": {"running": run_by_part.get(p, 0), "pending": pend_by_part.get(p, 0)},
            # per-node spec (nodes in a partition are homogeneous) + live availability
            "spec": {
                "cores_per_node": max((m[2] for m in members), default=0),
                "mem_per_node": max((num(m[0].get("real_memory")) or 0 for m in members), default=0),
                "gpu_per_node": max((sum(m[4].values()) for m in members), default=0),
            },
            "nodes_state": dict(states),
            "available_nodes": available_nodes,
        })
    partitions.sort(key=lambda x: x["name"])

    # ---- pools (the primary resource view) -----------------------------------
    pool_out = []
    for pid, pa in pools.items():
        gt = sum(pa["gpu_total"].values())
        gu = sum(pa["gpu_used"].values())
        gd = sum(pa["gpu_down"].values())
        gr = sum(pa["gpu_reserved"].values())
        gs = sum(pa["gpu_short"].values())
        st = pa["states"]
        ctot, calloc = pa["cpus_total"], pa["cpus_alloc"]
        is_gpu = pa["kind"] == "gpu"
        gpu = None
        if gt:
            gtype = pa["gpu_total"].most_common(1)[0][0]
            cat = site.gpu_info(gtype)
            free_g = max(gt - gu - gd - gr - gs, 0)
            gpu = {"type": gtype, "label": cat["label"], "mem_gb": cat["mem_gb"],
                   "total": gt, "used": gu, "down": gd, "reserved": gr, "short": gs,
                   "free": free_g,
                   "maint": gd >= gt, "util": round(gu / gt, 3),
                   "next_free": next_free.get(gtype) if gd < gt else None}
        free_cores = max(ctot - calloc - pa["other_cores"], 0)   # idle, runnable cores
        util = gpu["util"] if (is_gpu and gpu) else (calloc / ctot if ctot else 0.0)
        pool_out.append({
            "id": pid, "kind": pa["kind"], "nodes": pa["nodes"],
            "mem_per_node": pa["mem_per_node"],
            "nodes_state": dict(st),
            "idle_nodes": st.get("idle", 0),
            "available_nodes": pa["available_nodes"],
            "down_nodes": pa["down_nodes"],
            "cores": {"total": ctot, "alloc": calloc, "free": free_cores,
                      "unavailable": pa["other_cores"],
                      "util": round(calloc / ctot, 3) if ctot else 0.0},
            "util": round(util, 3),
            "gpu": gpu,
            "partitions": sorted(pa["parts"]),
            "queue": {"running": pool_run.get(pid, 0), "pending": pool_pend.get(pid, 0)},
        })
    pool_out.sort(key=site.pool_rank)

    # ---- pending preview -------------------------------------------------------
    pending_jobs.sort(key=pending_sort_key)
    top_pending = pending_jobs[:12]
    longest_pending = sorted(longest_pending_by_part.values(), key=lambda x: x["partition"])
    # soonest-ending running jobs (ISO end-time strings sort chronologically)
    releases.sort(key=lambda x: x["end_time"])
    top_releases = releases[:14]

    return {
        "schema_version": 1,
        "cluster": cluster,
        "slurm_version": slurm_version,
        "pools": pool_out,
        "partitions": partitions,
        "queue": {
            "running": running, "pending": pending,
            "pending_reasons": dict(pend_reasons),
            "top_pending": top_pending,
            "longest_pending_by_partition": longest_pending,
            "releases": top_releases,
            "container_jobs": container_jobs,
        },
        "nodes_down": nodes_down,
        "part_pool": part_pool,    # partition -> pool id (lets the client group raw jobs)
    }


def pending_sort_key(job):
    submit = job.get("submit_time") or 2**63
    return submit, str(job.get("job_id", ""))
