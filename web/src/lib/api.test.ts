import { describe, expect, it } from "vitest";
import { validateSnapshot } from "./api";

const compatibleSnapshot = {
  totals: {},
  pools: [],
  partitions: [],
  nodes: [],
  jobs: [],
  generated_at: 1,
};

describe("validateSnapshot", () => {
  it("accepts the immediately preceding unversioned snapshot during a rolling restart", () => {
    expect(validateSnapshot(compatibleSnapshot).schema_version).toBe(1);
  });

  it("accepts schema v1", () => {
    expect(validateSnapshot({ ...compatibleSnapshot, schema_version: 1 }).schema_version).toBe(1);
  });

  it("rejects unknown versions and malformed payloads", () => {
    expect(() => validateSnapshot({ ...compatibleSnapshot, schema_version: 2 })).toThrow();
    expect(() => validateSnapshot({ ...compatibleSnapshot, nodes: null })).toThrow();
  });
});
