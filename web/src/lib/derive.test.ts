import { describe, expect, it } from "vitest";
import { unschedulableCores } from "@/lib/derive";
import type { RawNode } from "@/types/snapshot";

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
