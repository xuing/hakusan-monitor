import { describe, expect, it } from "vitest";
import { poolNodeStates, unschedulableCores } from "@/lib/derive";
import type { RawNode, Snapshot } from "@/types/snapshot";

const node = (name: string, state: string[], alloc: number, schedulable: boolean): RawNode =>
  ({ name, pool: "cpu", state, cpus: 256, alloc_cpus: alloc, schedulable }) as unknown as RawNode;

describe("unschedulableCores", () => {
  it("splits idle cores the free count leaves out into held and down", () => {
    const held = unschedulableCores([
      node("a", ["MIXED"], 200, true),                // schedulable: its 56 are free, not here
      node("b", ["MIXED", "PLANNED"], 243, false),    // held for a queued job
      node("c", ["IDLE", "DRAIN"], 0, false),         // taken out by an operator
      node("d", ["ALLOCATED"], 256, false),           // full: nothing idle
    ], "cpu");
    expect(held).toEqual({ reserved: 13, down: 256 });
  });
});

describe("poolNodeStates", () => {
  it("sorts every node by what it offers now", () => {
    const snap = { nodes: [
      node("idle", ["IDLE"], 0, true),
      node("part", ["MIXED"], 64, true),            // the large-memory node: 64 of 256 cores used here
      node("held", ["MIXED", "PLANNED"], 243, false),
      node("full", ["ALLOCATED"], 256, false),
      node("down", ["IDLE", "DRAIN"], 0, false),
    ] } as unknown as Snapshot;
    expect(poolNodeStates(snap, "cpu")).toEqual({ idle: 1, partial: 1, held: 1, full: 1, down: 1 });
  });
});
