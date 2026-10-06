"""Write web/src/lib/queue.fixtures.ts from a saved /api/snapshot: the GPU pools' nodes,
running and pending jobs and partition policy, user names replaced by u01, u02, ...

    curl -s localhost:8787/api/snapshot > snap.json
    python3 scripts/capture_queue_fixture.py snap.json web/src/lib/queue.fixtures.ts

Tests pin exact job ids from the capture, so re-capturing means re-checking them.
"""
import json, sys
snap = json.load(open(sys.argv[1]))
out = sys.argv[2]
pools = {"a40", "a100", "h100-80"}
parts = sorted(p for p, pool in snap["part_pool"].items() if pool in pools)
nodes = [n for n in snap["nodes"] if n["pool"] in pools]
jobs = [j for j in snap["jobs"]
        if any(p in parts for p in str(j["partition"]).split(","))
        and str(j["job_state"]).upper() in ("RUNNING", "PENDING")]
users = {}
def anon(u):
    if u not in users:
        users[u] = f"u{len(users) + 1:02d}"
    return users[u]
for j in sorted(jobs, key=lambda j: (str(j["job_state"]), str(j["job_id"]))):
    anon(j["user_name"])
pol = snap["policy"]
policy = {
    "partition_caps": {p: pol["partition_caps"].get(p, {}) for p in parts},
    "partition_policies": {p: pol["partition_policies"].get(p, {}) for p in parts},
    "partition_defaults": {p: {k: v for k, v in (pol["partition_defaults"].get(p) or {}).items()
                               if k in ("cores", "gpus_per_node", "def_mem_per_cpu_mb", "interactive_time_min")} for p in parts},
    "partitions": {p: {"qos": pol["partitions"][p]["qos"]} for p in parts},
}
pool_rows = [{k: p[k] for k in ("id", "kind", "nodes", "mem_per_node", "down_nodes", "available_nodes", "idle_nodes", "cores", "gpu", "partitions", "queue")}
             for p in snap["pools"] if p["id"] in pools]
part_rows = [{k: p[k] for k in ("name", "kind", "nodes", "pool", "gpu", "jobs", "spec", "nodes_state", "free_nodes", "available_nodes")}
             for p in snap["partitions"] if p["name"] in parts]
def node_row(n):
    return [n["name"], n["pool"], "+".join(n["state"]), ",".join(n["partitions"]), n["cpus"], n["alloc_cpus"],
            n["real_memory"], n["alloc_memory"], n["gres"], n["gres_used"], bool(n["schedulable"])]
def job_row(j):
    return [str(j["job_id"]), anon(j["user_name"]), j["partition"], j["job_state"], j["state_reason"] or "",
            j["node_count"], j["cpus"], j["gpus"], j.get("min_memory_mb") or 0, j["submit_time"],
            j.get("start_est") or "", j.get("sched_nodes") or "", j.get("priority") or 0, j.get("time_limit") or "",
            j.get("nodelist") or "", j.get("end_time") or ""]
lines = []
w = lines.append
w("/**")
w(" * The GPU side of hakusan's queue, as /api/snapshot showed it on 2026-10-06")
w(" * at 22:44 JST — nodes, running and pending jobs of the a40, a100 and")
w(" * h100-80 pools, with their partitions' QoS caps. User names are replaced")
w(" * by u01, u02, … ; nothing else is edited.")
w(" *")
w(" * Captured with: curl -s localhost:8787/api/snapshot > snap.json")
w(" *                python3 scripts/capture_queue_fixture.py snap.json web/src/lib/queue.fixtures.ts")
w(" *")
w(" * What it holds (the reason it was kept):")
w(" *  - five jobs of one user queued to GPU-1,GPU-1A,GPU-S whose Reason is")
w(" *    QOSGrpJobsLimit (GPU-S 10/10) while squeue's SchedNodes books each on an")
w(" *    A40 node at the next A40 release — the waiters isLimitBlocked dropped;")
w(" *  - GPU-S waiters behind a full GrpJobs cap, GPU-1A waiters behind their")
w(" *    owners' MaxJobsPerUser, dependencies, holds, a DependencyNeverSatisfied.")
w(" */")
w('import type { Partition, PolicySnapshot, Pool, RawJob, RawNode, Snapshot } from "@/types/snapshot";')
w("")
w(f'export const GENERATED_AT = {snap["generated_at"]};')
w("")
w(f"export const PART_POOL: Record<string, string> = {json.dumps({p: snap['part_pool'][p] for p in parts})};")
w("")
w(f"export const POOLS = {json.dumps(pool_rows, indent=2)} as unknown as Pool[];")
w("")
w(f"export const PARTITIONS = {json.dumps(part_rows, indent=2)} as unknown as Partition[];")
w("")
w(f"export const POLICY = {json.dumps(policy, indent=2)} as unknown as PolicySnapshot;")
w("")
w("type NodeRow = [string, string, string, string, number, number, number, number, string, string, boolean];")
w("// name, pool, state, partitions, cpus, alloc_cpus, real_memory, alloc_memory, gres, gres_used, schedulable")
w("const NODE_ROWS: NodeRow[] = [")
for n in sorted(nodes, key=lambda n: n["name"]):
    w("  " + json.dumps(node_row(n)) + ",")
w("];")
w("")
w("export const NODES: RawNode[] = NODE_ROWS.map(([name, pool, state, partitions, cpus, alloc_cpus, real_memory, alloc_memory, gres, gres_used, schedulable]) => ({")
w('  name, pool, state: state.split("+"), partitions: partitions.split(","), cpus, alloc_cpus, real_memory, alloc_memory,')
w('  gres, gres_used, schedulable, state_bucket: "", cpu_load: "", free_mem: 0, features: "", alloc_tres: "", cfg_tres: "",')
w('  boot_time: "", reason: "",')
w("}));")
w("")
w("type JobRow = [string, string, string, string, string, number, number, number, number, number, string, string, number, string, string, string];")
w("// job_id, user, partition, state, reason, node_count, cpus, gpus, min_memory_mb, submit_time, start_est, sched_nodes, priority, time_limit, nodelist, end_time")
w("const JOB_ROWS: JobRow[] = [")
for j in sorted(jobs, key=lambda j: (str(j["job_state"]), -(j.get("priority") or 0), str(j["job_id"]))):
    w("  " + json.dumps(job_row(j), ensure_ascii=False) + ",")
w("];")
w("")
w("export const JOBS: RawJob[] = JOB_ROWS.map(([job_id, user_name, partition, job_state, state_reason, node_count, cpus, gpus,")
w("  min_memory_mb, submit_time, start_est, sched_nodes, priority, time_limit, nodelist, end_time]) => ({")
w("  job_id, user_name, partition, job_state, state_reason, node_count, cpus, gpus, min_memory_mb, submit_time, start_est,")
w('  sched_nodes, priority, time_limit, nodelist, end_time, account: "", tres_req_str: "", container: "", time_left: "",')
w('  name: "", qos: "", time_used: "",')
w("}));")
w("")
w("/** The capture as a snapshot (the fields the verdicts read). */")
w("export const SNAPSHOT = {")
w("  jobs: JOBS, nodes: NODES, pools: POOLS, partitions: PARTITIONS, policy: POLICY, part_pool: PART_POOL,")
w("  generated_at: GENERATED_AT, licenses: [], cpu_submit_probes: [],")
w("} as unknown as Snapshot;")
open(out, "w").write("\n".join(lines) + "\n")
print(len(nodes), "nodes", len(jobs), "jobs", len(users), "users")
