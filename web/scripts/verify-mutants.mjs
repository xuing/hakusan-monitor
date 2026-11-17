#!/usr/bin/env node
// Mutation self-test for the start-verdict verification (npm run verify:mutants).
// Each mutant is one realistic break of the product code that a property
// must catch. It is applied to a throwaway copy of web/ in the system temp
// dir, and the copy's verify suite must then fail the named test. See
// .claude/skills/verify-start-verdict/SKILL.md.
//
// What it writes: only inside that temp dir, removed at the end. The copy
// gets its own node_modules directory whose entries are symlinks to
// web/node_modules/<package> (read only); the Vite/Vitest caches
// (.vite, .vite-temp, .vitest-cache) are left out, so Vite and Vitest create
// them inside the temp copy, not in web/node_modules.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const web = path.resolve(import.meta.dirname, "..");

/** [id, file under web/, exact text, replacement, test that must fail, what the break does] */
const MUTANTS = [
  ["M1", "src/lib/node-select.ts",
    "if (req.gpusPerNode > 0 && (node.gpus < req.gpusPerNode || (req.gpuType && req.gpuType !== node.gpuType))) return 0;",
    "if (req.gpusPerNode > 0 && (req.gpuType && req.gpuType !== node.gpuType)) return 0;",
    "P1 placement-fits", "usableCpus stops checking a node's free GPU count"],
  ["M2", "src/lib/queue.ts", "        room.gpus -= take.gpus;\n", "",
    "P2 claims-fit", "the queue play no longer uses up a node's GPUs as waiters start"],
  ["M3", "src/lib/queue.ts", "if (g <= 0 || u <= 0) continue;", "if (u <= 0) continue;",
    "P3 caps-hold", "the queue play ignores the QoS GrpJobs cap"],
  ["M4", "src/lib/queue.ts", "const here = rooms.filter((r) => r.partitions.has(p));",
    "const here = rooms.filter((r) => r.partitions.has(p) && r.gpus > 0);",
    "P4 lone-waiter-starts", "the queue play only looks at nodes with a free GPU"],
  ["M5", "src/lib/gpu-fit.ts", "return until !== undefined && endsBeforeBooking(until, endsAt);",
    "return until !== undefined && !endsBeforeBooking(until, endsAt);",
    "P5 shorter-never-worse", "the backfill-window test is flipped"],
  ["M6", "src/lib/cpu-probes.ts", "} else if (allowsMultiNode(cap, maxNodeCores(snap, partition))) {",
    "} else if (cores > maxNodeCores(snap, partition) / 2) {",
    "P6 smaller-never-worse", "small CPU requests are sent as -n 1 -c N, large ones as -n N"],
  ["M8", "src/lib/cpu-probes.ts", "const mem = largest(1, most, (memMb) =>",
    "const mem = largest(1, Math.floor(most / 2), (memMb) =>",
    "P6 smaller-never-worse", "the --mem slider's search stops at half the largest free memory"],
  ["M7", "src/lib/gpu-fit.ts",
    "return fit.fitNodes.some((row) => !bookings.has(row.node.name) && holdsNeed(fit, freeAfterClaims(row, claims)));",
    "return fit.fitNodes.some((row) => holdsNeed(fit, freeAfterClaims(row, claims)));",
    "P7 own-nodes-only", "a booked node counts as a clear GPU slot"],
  // the first run's findings, put back: each must stay caught
  ["M9", "src/lib/node-select.ts", "const want = req.maxNodes > 0 ? Math.max(min, ceiling) : min;",
    "const want = Number.isFinite(ceiling) ? Math.max(min, ceiling) : min;",
    "P6 smaller-never-worse", "F2: Slurm aims for the QoS / partition node limit as if the job gave -N's maximum"],
  ["M10", "src/lib/gpu-fit.ts", "for (const node of partitionNodes(nodes, partition)) {",
    "for (const node of nodes) {",
    "P7 own-nodes-only", "F3: a GPU partition's fit counts every node of the pool, its siblings' too"],
  ["M11", "src/lib/slurm.ts", "return Number.isFinite(sec) && sec > 0 ? startMs + sec * 1000 : undefined;",
    "return Number.isFinite(sec) ? startMs + sec * 1000 : undefined;",
    "P5 shorter-never-worse", "F1: no time limit (timeSec 0) reads as a job that ends now"],
];

const only = process.argv.slice(2);
const tmp = mkdtempSync(path.join(tmpdir(), "verify-mutants-"));
for (const f of ["src", "package.json", "vite.config.ts", "vitest.verify.config.ts", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json"]) {
  cpSync(path.join(web, f), path.join(tmp, f), { recursive: true });
}
// caches Vite / Vitest write under the nearest node_modules: keep them in the copy
const CACHES = new Set([".vite", ".vite-temp", ".vitest-cache", ".vitest", ".cache", ".tmp"]);
mkdirSync(path.join(tmp, "node_modules"));
for (const entry of readdirSync(path.join(web, "node_modules"))) {
  if (!CACHES.has(entry)) symlinkSync(path.join(web, "node_modules", entry), path.join(tmp, "node_modules", entry));
}

let bad = 0;
try {
  for (const [id, file, from, to, test, what] of MUTANTS) {
    if (only.length && !only.includes(id)) continue;
    const target = path.join(tmp, file);
    const original = readFileSync(path.join(web, file), "utf8");
    const hits = original.split(from).length - 1;
    if (hits !== 1) {
      console.log(id + " ANCHOR " + (hits ? "AMBIGUOUS" : "MISSING") + " in " + file + ": update this mutant to the current code");
      bad++;
      continue;
    }
    writeFileSync(target, original.replace(from, () => to));
    const report = path.join(tmp, "report-" + id + ".json");
    try {
      execFileSync("npx", ["vitest", "run", "--config", "vitest.verify.config.ts", "--reporter=json", "--outputFile=" + report],
        { cwd: tmp, stdio: "ignore", env: { ...process.env, VERIFY_SEED: process.env.VERIFY_SEED ?? "" } });
    } catch { /* a failing suite exits non-zero; the report says which test */ }
    writeFileSync(target, original);
    const results = JSON.parse(readFileSync(report, "utf8")).testResults.flatMap((r) => r.assertionResults);
    const hit = results.filter((r) => r.title.startsWith(test));
    const caught = hit.length > 0 && hit.every((r) => r.status === "failed");
    const others = results.filter((r) => r.status === "failed" && !r.title.startsWith(test)).map((r) => r.title.split(":")[0].split(" (")[0]);
    console.log(id + " " + (caught ? "caught " : "MISSED ") + "by " + test + (others.length ? " (also: " + [...new Set(others)].join(", ") + ")" : "") + " -- " + what);
    if (!caught) bad++;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (bad) {
  console.log(bad + " mutant(s) not caught or not applicable");
  process.exit(1);
}
console.log("every mutant caught");
