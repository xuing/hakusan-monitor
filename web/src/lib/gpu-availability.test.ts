import { describe, expect, it } from "vitest";
import { gpuAvailabilitySegments, type GpuAvailabilitySegmentInput } from "./gpu-availability";

const base = {
  unreservedFree: 0,
  schedulable: 0,
  reserved: 0,
  down: 0,
  hasClearSlot: false,
  constrainedContested: false,
  shortCpu: false,
  shortMemory: false,
} satisfies GpuAvailabilitySegmentInput;

describe("GPU availability breakdown", () => {
  it("splits the A40-style total into memory-blocked and reserved peers", () => {
    expect(gpuAvailabilitySegments({
      ...base,
      unreservedFree: 6,
      reserved: 1,
      shortMemory: true,
    })).toEqual([
      { kind: "memory", count: 6 },
      { kind: "reserved", count: 1 },
    ]);
  });

  it("separates immediately usable GPUs from constrained and reserved GPUs", () => {
    expect(gpuAvailabilitySegments({
      ...base,
      unreservedFree: 6,
      schedulable: 2,
      reserved: 1,
      hasClearSlot: true,
      shortCpu: true,
    })).toEqual([
      { kind: "ready", count: 2 },
      { kind: "cpu", count: 4 },
      { kind: "reserved", count: 1 },
    ]);
  });

  it("marks otherwise schedulable GPUs as contested when queued work owns the slots", () => {
    expect(gpuAvailabilitySegments({
      ...base,
      unreservedFree: 2,
      schedulable: 2,
      hasClearSlot: false,
    })).toEqual([{ kind: "contested", count: 2 }]);
  });

  it("keeps queue contention ahead of a memory workaround when a waiter owns the constrained slot", () => {
    expect(gpuAvailabilitySegments({
      ...base,
      unreservedFree: 5,
      schedulable: 2,
      reserved: 1,
      constrainedContested: true,
    })).toEqual([
      { kind: "contested", count: 5 },
      { kind: "reserved", count: 1 },
    ]);
  });

  it("keeps reserved-only, down-only, and fully occupied pools explicit", () => {
    expect(gpuAvailabilitySegments({ ...base, reserved: 2 }))
      .toEqual([{ kind: "reserved", count: 2 }]);
    expect(gpuAvailabilitySegments({ ...base, down: 1 }))
      .toEqual([{ kind: "down", count: 1 }]);
    expect(gpuAvailabilitySegments(base))
      .toEqual([{ kind: "full", count: 0 }]);
  });
});
