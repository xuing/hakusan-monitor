import { describe, expect, it } from "vitest";
import { readHash, writeHash } from "./hash-params";

describe("hash params", () => {
  it("reads with or without the leading #", () => {
    expect(readHash("#pool=a100").get("pool")).toBe("a100");
    expect(readHash("pool=a100").get("pool")).toBe("a100");
    expect(readHash("").get("pool")).toBeNull();
  });

  it("repeats a key per value, so values keep their commas", () => {
    const hash = writeHash("", { partition: ["GPU-1,GPU-S", "GPU-L"] });
    expect(readHash(hash).getAll("partition")).toEqual(["GPU-1,GPU-S", "GPU-L"]);
  });

  it("removes empty values and keeps unrelated keys", () => {
    expect(writeHash("#pool=a100&q=x", { q: "" })).toBe("#pool=a100");
    expect(writeHash("#pool=a100", { pool: null })).toBe("");
    expect(writeHash("#pool=a100", { state: [] })).toBe("#pool=a100");
  });

  it("encodes text that is not URL-safe", () => {
    const hash = writeHash("", { q: "gpu 1&2" });
    expect(readHash(hash).get("q")).toBe("gpu 1&2");
  });
});
