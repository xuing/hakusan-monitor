import { describe, expect, it } from "vitest";
import { compressHostlist, groupDownNodes } from "./down-groups";

// nodes_down on hakusan, 2026-10-05
const DOWN = [
  ...Array.from({ length: 8 }, (_, i) => ({ name: `spcc-cld-g${String(i + 1).padStart(2, "0")}`, state: ["DOWN", "NOT_RESPONDING"], pool: "h100-20c", reason: "Not responding [slurm@2026-04-07T20:38:57]" })),
  ...Array.from({ length: 4 }, (_, i) => ({ name: `spcc-cld-g${String(i + 9).padStart(2, "0")}`, state: ["DOWN", "NOT_RESPONDING"], pool: "h100-20c", reason: "Not responding [slurm@2026-06-24T10:24:00]" })),
  { name: "spcc-cld-gl02", state: ["IDLE", "DRAIN"], pool: "h100-80", reason: "Maintenance [root@2026-08-20T15:17:00]" },
];

describe("groupDownNodes", () => {
  it("one entry per cause, the earliest stamp as its start", () => {
    const groups = groupDownNodes(DOWN, new Set(["h100-20c"]));
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ pool: "h100-20c", reason: "Not responding", by: "slurm", since: "2026-04-07T20:38:57", tone: "maint" });
    expect(groups[0].nodes).toHaveLength(12);
    expect(groups[1]).toMatchObject({ pool: "h100-80", reason: "Maintenance", by: "root", tone: "maint" });
  });

  it("a failed node outside an offline pool is a fault", () => {
    expect(groupDownNodes(DOWN.slice(0, 1), new Set())[0].tone).toBe("fault");
  });
});

describe("compressHostlist", () => {
  it("writes consecutive numbers as Slurm ranges", () => {
    expect(compressHostlist(DOWN.slice(0, 12).map((n) => n.name))).toBe("spcc-cld-g[01-12]");
    expect(compressHostlist(["lcpcc-001", "lcpcc-002", "lcpcc-005"])).toBe("lcpcc-[001-002,005]");
    expect(compressHostlist(["spcc-cld-gl02"])).toBe("spcc-cld-gl02");
  });
});
