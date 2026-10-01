/**
 * Entry point for scripts/check_cluster_policy.py: writes boundaryCommands()
 * for a live snapshot so the daily check probes exactly what the UI offers.
 * Skipped in normal test runs (no HM_BOUNDARY_OUT).
 *   HM_BOUNDARY_SNAPSHOT=snap.json HM_BOUNDARY_OUT=out.json npx vitest run src/lib/boundary.emit.test.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { boundaryCommands } from "./request-limits";

it.skipIf(!process.env.HM_BOUNDARY_OUT)("emit boundary commands", () => {
  const snap = JSON.parse(readFileSync(process.env.HM_BOUNDARY_SNAPSHOT as string, "utf8"));
  writeFileSync(process.env.HM_BOUNDARY_OUT as string, JSON.stringify(boundaryCommands(snap)));
});
