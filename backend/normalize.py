"""Pure transforms: Slurm JSON  ->  compact Hakusan Monitor snapshot.

No I/O here so it stays unit-testable. Input is already-parsed dicts from
`scontrol show nodes --json` and `squeue --json` (Slurm 25.05 schema).
"""
from __future__ import annotations
import re
from collections import defaultdict, Counter

# ---- GPU type catalog (label + approx per-GPU memory, GB) --------------------
GPU_CATALOG = {
    "nvidia_a40":  {"label": "A40",       "mem_gb": 48},
    "nvidia_a100": {"label": "A100",      "mem_gb": 40},
    "h100-80c":    {"label": "H100 80GB", "mem_gb": 80},
    "h100-20c":    {"label": "H100 MIG 20GB", "mem_gb": 20},
}
GPU_ORDER = ["nvidia_a40", "nvidia_a100", "h100-80c", "h100-20c"]

_GRES_RE = re.compile(r"gpu:([A-Za-z0-9_\-]+):(\d+)")
_TRES_GPU_RE = re.compile(r"gres/gpu:?([A-Za-z0-9_\-]*)=(\d+)")


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


def parse_tres_gpu(s):
    """Total GPUs requested from a tres_req_str, plus a short label."""
    if not s:
        return 0, ""
    total = 0
    parts = []
    for m in _TRES_GPU_RE.finditer(s):
        typ, n = m.group(1), int(m.group(2))
        total += n
        label = GPU_CATALOG.get(typ, {}).get("label", typ or "gpu")
        parts.append(f"{label}×{n}")
    return total, ", ".join(parts)


# ---- node state bucketing ----------------------------------------------------
def state_list(node):
    s = node.get("state")
    if isinstance(s, list):
        return [str(x).upper() for x in s]
    return [str(s).upper()] if s else []


def bucket_state(states):
    s = set(states)
    if s & {"DOWN", "NOT_RESPONDING"}:
        return "down"
    if "DRAIN" in s and not (s & {"ALLOCATED", "MIXED"}):
        return "drain"
    if "ALLOCATED" in s:
        return "allocated"
    if "MIXED" in s:
        return "mixed"
    if "IDLE" in s:
        return "idle"
    if "RESERVED" in s:
        return "reserved"
    return "other"


def node_pool(name):
    if name.startswith("lcpcc-"):
        return "cpu"
    if name.startswith("spcc-a40g"):
        return "a40"
    if name.startswith("spcc-a100g"):
        return "a100"
    if name.startswith("spcc-cld-gl"):
        return "h100-80"
    if name.startswith("spcc-cld-lm"):
        return "lm"
    if name.startswith("spcc-cld-g"):
        return "h100-20c"
    if name.startswith("spcc-cld-"):
        return "vm-cpu"
    return "other"


POOL_KIND = {"cpu": "cpu", "vm-cpu": "cpu", "lm": "cpu",
             "a40": "gpu", "a100": "gpu", "h100-80": "gpu", "h100-20c": "gpu"}


def mask_user(u, mask):
    if not mask or not u:
        return u
    return (u[:2] + "***") if len(u) > 2 else "***"


def pressure_level(p):
    if p >= 0.9:
        return "critical"
    if p >= 0.75:
        return "high"
    if p >= 0.5:
        return "moderate"
    return "low"


RELEASE_SOON_S = 2 * 3600   # a running job "releases soon" if it ends within 2h


def parse_duration(s):
    """Slurm time-left -> seconds. Handles MM:SS, H:MM:SS, D-HH:MM:SS. None if unset."""
    if not s or (":" not in s and "-" not in s):
        return None
    try:
        days = 0
        if "-" in s:
            d, s = s.split("-", 1)
            days = int(d)
        parts = [int(x) for x in s.split(":")]
        while len(parts) < 3:
            parts.insert(0, 0)
        return days * 86400 + parts[-3] * 3600 + parts[-2] * 60 + parts[-1]
    except Exception:
        return None


def normalize(nodes_json, squeue_json, *, cluster="hakusan", slurm_version="",
              mask_users=False):
    nodes = (nodes_json or {}).get("nodes", []) or []
    jobs = (squeue_json or {}).get("jobs", []) or []

    # ---- per-node pass -------------------------------------------------------
    tot_cpu = alloc_cpu = 0
    other_cpu = 0          # cores on down/drained nodes — present but NOT runnable
    tot_mem = alloc_mem = 0
    by_state = Counter()
    gpu_nodes_total = gpu_nodes_free = 0   # GPU nodes / with a free GPU
    cpu_nodes_total = cpu_nodes_free = 0   # CPU nodes / with free cores
    gpu_total = Counter()
    gpu_used = Counter()
    gpu_down = Counter()   # GPUs on down/drained nodes (present but unusable)
    pools = {}            # id -> accumulator
    part_nodes = defaultdict(list)
    nodes_down = []

    for nd in nodes:
        name = nd.get("name", "")
        if not name:
            continue
        states = state_list(nd)
        b = bucket_state(states)
        by_state[b] += 1
        cpus = num(nd.get("cpus")) or 0
        acpu = num(nd.get("alloc_cpus")) or 0
        rmem = num(nd.get("real_memory")) or 0
        amem = num(nd.get("alloc_memory")) or 0
        tot_cpu += cpus
        alloc_cpu += acpu
        tot_mem += rmem
        alloc_mem += amem

        g_tot = parse_gres(nd.get("gres"))
        g_use = parse_gres(nd.get("gres_used"))
        for k, v in g_tot.items():
            gpu_total[k] += v
        for k, v in g_use.items():
            gpu_used[k] += v
        if b in ("down", "drain"):
            for k, v in g_tot.items():
                gpu_down[k] += v

        # node-level availability (a node is "free" if up and has spare capacity)
        node_up = b not in ("down", "drain")
        if g_tot:
            gpu_nodes_total += 1
            if node_up and (sum(g_tot.values()) - sum(g_use.values())) > 0:
                gpu_nodes_free += 1
        else:
            cpu_nodes_total += 1
            if node_up and (cpus - acpu) > 0:
                cpu_nodes_free += 1

        pid = node_pool(name)
        pa = pools.setdefault(pid, dict(id=pid, kind=POOL_KIND.get(pid, "cpu"),
                                        nodes=0, cpus_total=0, cpus_alloc=0, other_cores=0,
                                        mem_per_node=0, states=Counter(),
                                        gpu_total=Counter(), gpu_used=Counter(),
                                        gpu_down=Counter(), available_nodes=0,
                                        parts=set()))
        pa["nodes"] += 1
        pa["cpus_total"] += cpus
        pa["cpus_alloc"] += acpu
        pa["mem_per_node"] = max(pa["mem_per_node"], rmem)
        pa["states"][b] += 1
        pa["gpu_total"] += g_tot
        pa["gpu_used"] += g_use
        if node_up:
            if g_tot and (sum(g_tot.values()) - sum(g_use.values())) > 0:
                pa["available_nodes"] += 1
            elif not g_tot and (cpus - acpu) > 0:
                pa["available_nodes"] += 1
        if b in ("down", "drain"):
            pa["gpu_down"] += g_tot
            pa["other_cores"] += cpus - acpu
            other_cpu += cpus - acpu

        for p in (nd.get("partitions") or []):
            part_nodes[p].append((nd, b, cpus, acpu, g_tot, g_use))
            pa["parts"].add(p)

        if b in ("down", "drain") or (states and "DRAIN" in set(states)):
            nodes_down.append({"name": name, "state": states,
                               "pool": pid, "reason": nd.get("reason") or ""})

    gpu_total_n = sum(gpu_total.values())
    gpu_used_n = sum(gpu_used.values())
    gpu_down_n = sum(gpu_down.values())

    # partition -> dominant GPU type (GPU jobs report only a count, not a type)
    # partition -> hardware pool (its nodes' pool)
    part_gpu_type = {}
    part_pool = {}
    for p, members in part_nodes.items():
        c = Counter()
        poolc = Counter()
        for m in members:
            c.update(m[4])
            poolc[node_pool(m[0].get("name", ""))] += 1
        if c:
            part_gpu_type[p] = c.most_common(1)[0][0]
        if poolc:
            part_pool[p] = poolc.most_common(1)[0][0]

    # ---- queue pass ----------------------------------------------------------
    run_by_part = Counter()
    pend_by_part = Counter()
    pend_reason_by_part = defaultdict(Counter)
    pend_reasons = Counter()
    running = pending = container_jobs = 0
    user_run = defaultdict(lambda: {"running": 0, "cpus": 0, "gpus": 0})
    pending_jobs = []
    longest_pending_by_part = {}
    releases = []                # running jobs that will free resources, by end time
    next_free = {}               # gpu type -> soonest {at, left} a card frees
    releasing = defaultdict(lambda: {"jobs": 0, "nodes": 0})  # per-partition, within 2h
    pool_run = Counter()
    pool_pend = Counter()
    pool_releasing = defaultdict(lambda: {"jobs": 0, "nodes": 0})  # per-pool, within 2h

    def gpu_label(gtype, n):
        lbl = GPU_CATALOG.get(gtype, {}).get("label", gtype or "GPU")
        return f"{lbl}×{n}"

    for j in jobs:
        st = j.get("job_state")
        st = st[0] if isinstance(st, list) and st else st
        parts = [p for p in str(j.get("partition", "")).split(",") if p]
        if st == "RUNNING":
            running += 1
            left = j.get("time_left") or ""
            soon = parse_duration(left)
            soon = soon is not None and soon <= RELEASE_SOON_S
            nc = num(j.get("node_count")) or 0
            for p in parts:
                run_by_part[p] += 1
                if soon:
                    releasing[p]["jobs"] += 1
                    releasing[p]["nodes"] += nc
            for pool in {part_pool.get(p) for p in parts if p in part_pool}:
                pool_run[pool] += 1
                if soon:
                    pool_releasing[pool]["jobs"] += 1
                    pool_releasing[pool]["nodes"] += nc
            u = j.get("user_name", "")
            gpus_req, _ = parse_tres_gpu(j.get("tres_req_str"))
            ur = user_run[u]
            ur["running"] += 1
            ur["cpus"] += num(j.get("cpus")) or 0
            ur["gpus"] += gpus_req
            end = j.get("end_time") or ""
            if end:
                gp = j.get("gpus", 0)
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
                if gp and gtype and (gtype not in next_free or end < next_free[gtype]["at"]):
                    next_free[gtype] = {"at": end, "left": left}
        elif st == "PENDING":
            pending += 1
            reason = j.get("state_reason") or "None"
            pend_reasons[reason] += 1
            for p in parts:
                pend_by_part[p] += 1
                pend_reason_by_part[p][reason] += 1
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
        gpu_down_part = sum(sum(m[4].values()) for m in members if m[1] in ("down", "drain"))
        cpu_util = (ca / ct) if ct else 0.0
        gpu_util = (gu / gt) if gt else 0.0
        util = gpu_util if kind == "gpu" else cpu_util
        r = run_by_part.get(p, 0)
        pd = pend_by_part.get(p, 0)
        queue_ratio = min(pd / (r + 1), 1.0)
        pressure = round(0.6 * util + 0.4 * queue_ratio, 3)
        states = Counter(m[1] for m in members)              # bucketed node states
        other_c = sum(m[2] - m[3] for m in members if m[1] in ("down", "drain"))
        available_nodes = sum(
            1 for _, b, cpus, acpu, g_tot, g_use in members
            if b not in ("down", "drain") and (
                (sum(g_tot.values()) - sum(g_use.values())) > 0 if kind == "gpu" else (cpus - acpu) > 0
            )
        )
        partitions.append({
            "name": p, "kind": kind, "nodes": len(members),
            "gpu_type": part_gpu_type.get(p) if kind == "gpu" else None,
            "cpus": {"total": ct, "alloc": ca, "free": max(ct - ca - other_c, 0),
                     "util": round(cpu_util, 3)},
            "gpu": ({"total": gt, "used": gu, "down": gpu_down_part,
                     "free": max(gt - gu - gpu_down_part, 0),
                     "util": round(gpu_util, 3)} if gt else None),
            "pool": part_pool.get(p),
            "jobs": {"running": r, "pending": pd},
            "pending_reasons": dict(pend_reason_by_part.get(p, {})),
            "pressure": pressure, "level": pressure_level(pressure),
            # per-node spec (nodes in a partition are homogeneous) + live availability
            "spec": {
                "cores_per_node": max((m[2] for m in members), default=0),
                "mem_per_node": max((m[0].get("real_memory", 0) for m in members), default=0),
                "gpu_per_node": max((sum(m[4].values()) for m in members), default=0),
            },
            "nodes_state": dict(states),
            "free_nodes": states.get("idle", 0),
            "available_nodes": available_nodes,
            "busy_nodes": states.get("allocated", 0) + states.get("mixed", 0),
            "releasing": dict(releasing.get(p, {"jobs": 0, "nodes": 0})),
        })
    # busiest first
    partitions.sort(key=lambda x: (-x["pressure"], -x["jobs"]["pending"], x["name"]))

    # ---- pools (the primary resource view) -----------------------------------
    POOL_ORDER = {"a40": 0, "a100": 1, "h100-80": 2, "h100-20c": 3,
                  "cpu": 4, "vm-cpu": 5, "lm": 6}
    pool_out = []
    for pid, pa in pools.items():
        gt = sum(pa["gpu_total"].values())
        gu = sum(pa["gpu_used"].values())
        gd = sum(pa["gpu_down"].values())
        st = pa["states"]
        ctot, calloc = pa["cpus_total"], pa["cpus_alloc"]
        is_gpu = pa["kind"] == "gpu"
        gpu = None
        if gt:
            gtype = pa["gpu_total"].most_common(1)[0][0]
            cat = GPU_CATALOG.get(gtype, {"label": gtype, "mem_gb": None})
            free_g = max(gt - gu - gd, 0)
            gpu = {"type": gtype, "label": cat["label"], "mem_gb": cat["mem_gb"],
                   "total": gt, "used": gu, "down": gd, "free": free_g,
                   "maint": gd >= gt, "util": round(gu / gt, 3),
                   "next_free": next_free.get(gtype) if gd < gt else None}
        free_cores = max(ctot - calloc - pa["other_cores"], 0)   # idle, runnable cores
        util = gpu["util"] if (is_gpu and gpu) else (calloc / ctot if ctot else 0.0)
        avail = (gpu["free"] if gpu else 0) if is_gpu else free_cores
        pool_out.append({
            "id": pid, "kind": pa["kind"], "nodes": pa["nodes"],
            "mem_per_node": pa["mem_per_node"],
            "nodes_state": dict(st),
            "idle_nodes": st.get("idle", 0),
            "available_nodes": pa["available_nodes"],
            "down_nodes": st.get("down", 0) + st.get("drain", 0),
            "cpus_total": ctot, "cpus_alloc": calloc,
            "cores": {"total": ctot, "alloc": calloc, "free": free_cores,
                      "util": round(calloc / ctot, 3) if ctot else 0.0},
            "util": round(util, 3),
            "gpu": gpu,
            "partitions": sorted(pa["parts"]),
            "queue": {"running": pool_run.get(pid, 0), "pending": pool_pend.get(pid, 0),
                      "releasing": dict(pool_releasing.get(pid, {"jobs": 0, "nodes": 0}))},
            "avail": {"units": avail, "unit": "gpu" if is_gpu else "cores",
                      "can_now": avail > 0, "idle_nodes": st.get("idle", 0)},
        })
    pool_out.sort(key=lambda x: POOL_ORDER.get(x["id"], 99))

    # ---- gpu board -----------------------------------------------------------
    gpus = []
    for t in GPU_ORDER + [k for k in gpu_total if k not in GPU_ORDER]:
        if gpu_total.get(t):
            cat = GPU_CATALOG.get(t, {"label": t, "mem_gb": None})
            tt, uu, dd = gpu_total[t], gpu_used.get(t, 0), gpu_down.get(t, 0)
            gpus.append({"type": t, "label": cat["label"], "mem_gb": cat["mem_gb"],
                         "total": tt, "used": uu, "down": dd,
                         "free": max(tt - uu - dd, 0),     # usable & idle right now
                         "util": round(uu / tt, 3) if tt else 0.0,
                         "maint": dd >= tt,                # whole type is offline
                         "next_free": next_free.get(t) if dd < tt else None})

    # ---- top users / pending preview ----------------------------------------
    top_users = sorted(
        ({"user": mask_user(u, mask_users), **v} for u, v in user_run.items()),
        key=lambda x: (-x["running"], -x["gpus"], -x["cpus"]))[:8]
    pending_jobs.sort(key=pending_sort_key)
    top_pending = pending_jobs[:12]
    longest_pending = sorted(longest_pending_by_part.values(), key=lambda x: x["partition"])
    # soonest-ending running jobs (ISO end-time strings sort chronologically)
    releases.sort(key=lambda x: x["end_time"])
    top_releases = releases[:14]

    avail = by_state.get("idle", 0) + by_state.get("mixed", 0)
    down = by_state.get("down", 0) + by_state.get("drain", 0)

    return {
        "cluster": cluster,
        "slurm_version": slurm_version,
        "totals": {
            "nodes": {"total": sum(by_state.values()), "available": avail,
                      "down": down, "by_state": dict(by_state),
                      "gpu_total": gpu_nodes_total, "gpu_free": gpu_nodes_free,
                      "cpu_total": cpu_nodes_total, "cpu_free": cpu_nodes_free},
            "cpus": {"total": tot_cpu, "alloc": alloc_cpu,
                     "free": max(tot_cpu - alloc_cpu - other_cpu, 0),
                     "util": round(alloc_cpu / tot_cpu, 3) if tot_cpu else 0.0},
            "memory": {"total_mb": tot_mem, "alloc_mb": alloc_mem,
                       "util": round(alloc_mem / tot_mem, 3) if tot_mem else 0.0},
            "gpus": {"total": gpu_total_n, "used": gpu_used_n,
                     "down": gpu_down_n,
                     "free": max(gpu_total_n - gpu_used_n - gpu_down_n, 0),
                     "util": round(gpu_used_n / gpu_total_n, 3) if gpu_total_n else 0.0,
                     "by_type": {k: {"total": gpu_total[k],
                                      "used": gpu_used.get(k, 0),
                                      "down": gpu_down.get(k, 0),
                                      "free": max(gpu_total[k] - gpu_used.get(k, 0) - gpu_down.get(k, 0), 0)}
                                 for k in gpu_total}},
        },
        "pools": pool_out,
        "partitions": partitions,
        "gpus": gpus,
        "queue": {
            "running": running, "pending": pending, "total": running + pending,
            "pending_reasons": dict(pend_reasons),
            "by_partition": [{"partition": p, "running": run_by_part.get(p, 0),
                              "pending": pend_by_part.get(p, 0)}
                             for p in sorted(set(run_by_part) | set(pend_by_part))],
            "top_pending": top_pending,
            "longest_pending_by_partition": longest_pending,
            "releases": top_releases,
            "container_jobs": container_jobs,
        },
        "nodes_down": nodes_down,
        "top_users": top_users,
        "part_pool": part_pool,    # partition -> pool id (lets the client group raw jobs)
    }


def pending_sort_key(job):
    submit = job.get("submit_time") or 2**63
    return submit, str(job.get("job_id", ""))
