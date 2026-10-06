#!/usr/bin/env python3
"""Capture the evidence web/src/lib/node-select.test.ts checks the node
selection against: in ONE ssh call, the nodes' free cores and memory, the
switch tree, each partition's DefMemPerCPU, and `sbatch --test-only` answers
for a set of request shapes ("Job N to start at T using P processors on nodes
X in partition Y"). --test-only submits nothing; it asks slurmctld which nodes
it would pick. Nothing user-identifying is read.

Usage: python3 scripts/capture_placement_fixture.py [user@host]
       (default: the first HM_SSH_HOST in .env)
Writes web/src/lib/node-select.fixtures.ts.
"""
import json, os, re, shlex, subprocess, sys, time

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.join(ROOT, "backend"))
from sources import parse_nodes, parse_topology  # noqa: E402

# (partition, extra sbatch flags): shapes Slurm places differently —
# spread over fragments, whole tasks (-c), fixed tasks per node, node
# minimums, memory-bound cores, single-node cores, GPUs
PROBES = [
    ("SMALL", "-n 64"), ("SMALL", "-n 128"), ("SMALL", "-n 200"), ("SMALL", "-n 32 -c 2"),
    ("SMALL", "-n 24 -c 4"), ("SMALL", "-N 3 -n 48"), ("SMALL", "-N 2 --ntasks-per-node=16"),
    ("SMALL", "-n 64 --mem-per-cpu=12000"), ("DEF", "-n 1 -c 16"), ("DEF", "-n 1 -c 8"),
    ("DEF", "-n 1 -c 40"), ("DEF", "-n 4"), ("LONG", "-n 1 -c 16"),
    ("GPU-1", ""), ("GPU-1", "-n 2 -c 26 --gres=gpu:2"), ("GPU-1A", ""),
]
MARK = "@@HM@@"


def host():
    if len(sys.argv) > 1:
        return sys.argv[1]
    for line in open(os.path.join(ROOT, ".env")):
        if line.startswith("HM_SSH_HOST="):
            return line.split("=", 1)[1].strip().split(",")[0]
    sys.exit("no host: pass user@host or set HM_SSH_HOST in .env")


def main():
    probes = "; ".join(
        f"echo {shlex.quote(p + '|' + flags)}; timeout 10s sbatch --test-only -p {p} {flags} --wrap=hostname 2>&1"
        for p, flags in PROBES)
    cmd = (f"scontrol -o show nodes; echo {MARK}; scontrol show topology; echo {MARK}; "
           f"scontrol -o show partition; echo {MARK}; {probes}")
    t0 = time.time()
    out = subprocess.run(["ssh", "-o", "BatchMode=yes", host(), cmd], capture_output=True, text=True,
                         timeout=180).stdout
    nodes_txt, topo_txt, part_txt, probe_txt = (out.split(MARK) + [""] * 4)[:4]
    nodes = [{k: n[k] for k in ("name", "state", "partitions", "cpus", "alloc_cpus", "real_memory",
                                "alloc_memory", "gres", "gres_used")}
             for n in parse_nodes(nodes_txt)["nodes"]]
    def_mem = {}
    for line in part_txt.splitlines():
        name = re.search(r"PartitionName=(\S+)", line)
        mem = re.search(r"DefMemPerCPU=(\d+)", line)
        if name and mem:
            def_mem[name.group(1)] = int(mem.group(1))
    answers, current = [], None
    for line in probe_txt.splitlines():
        if "|" in line and not line.startswith("sbatch") and "Job " not in line:
            part, flags = line.split("|", 1)
            current = {"partition": part, "flags": flags, "answer": ""}
            answers.append(current)
        elif current is not None and line.strip():
            current["answer"] = (current["answer"] + " " + line.strip()).strip()
    for a in answers:
        m = re.search(r"using (\d+) processors on nodes (\S+)", a["answer"])
        a["processors"] = int(m.group(1)) if m else 0
        a["nodes"] = m.group(2) if m else ""
    data = {"captured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(t0)),
            "nodes": nodes, "topology": parse_topology(topo_txt), "def_mem_per_cpu": def_mem,
            "probes": answers}
    path = os.path.join(ROOT, "web", "src", "lib", "node-select.fixtures.ts")
    with open(path, "w") as f:
        f.write("// Captured by scripts/capture_placement_fixture.py — node state, switch tree\n"
                "// and `sbatch --test-only` answers from one ssh call. Do not edit by hand.\n"
                "export const CAPTURE = {\n"
                f"  captured_at: {json.dumps(data['captured_at'])},\n"
                f"  def_mem_per_cpu: {json.dumps(data['def_mem_per_cpu'])},\n"
                "  topology: [\n" + "".join(f"    {json.dumps(t)},\n" for t in data["topology"]) + "  ],\n"
                "  probes: [\n" + "".join(f"    {json.dumps(a, ensure_ascii=False)},\n" for a in data["probes"]) + "  ],\n"
                "  nodes: [\n" + "".join(f"    {json.dumps(n)},\n" for n in data["nodes"]) + "  ],\n"
                "};\n")
    print(f"{len(nodes)} nodes, {len(data['topology'])} switches, "
          f"{sum(1 for a in answers if a['nodes'])}/{len(answers)} probes placed -> {path}")
    for a in answers:
        print(f"  {a['partition']:7} {a['flags']:32} {a['processors']:4} {a['nodes'] or a['answer'][:80]}")


if __name__ == "__main__":
    main()
