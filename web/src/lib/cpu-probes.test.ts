import { describe, expect, it } from "vitest";
import { cpuProbeState } from "./cpu-probes";
import type { CpuSubmitProbe } from "@/types/snapshot";

const probe = (startEpoch: number): CpuSubmitProbe => ({
  partition: "SMALL",
  ok: true,
  start_time: "2026-07-10T10:00:00",
  start_epoch: startEpoch,
  processors: 256,
  nodes: "lcpcc-[001-003]",
  raw: "ok",
});

describe("cpuProbeState", () => {
  it("does not let a queued result turn into now as observation time advances", () => {
    expect(cpuProbeState(probe(2_000), 1_000, 1_050, 1_200)).toBe("queued");
    expect(cpuProbeState(probe(2_000), 1_000, 1_900, 1_200)).toBe("queued");
  });

  it("expires a previously-now result", () => {
    expect(cpuProbeState(probe(1_050), 1_000, 1_100, 1_200)).toBe("now");
    expect(cpuProbeState(probe(1_050), 1_000, 2_201, 1_200)).toBe("unknown");
  });
});
