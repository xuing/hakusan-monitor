/// <reference types="node" />

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("GPU availability layout", () => {
  it("keeps the count and GPU unit on the same line", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/dashboard/resource-pools.tsx"),
      "utf8",
    );
    const countClasses = source.match(
      /<b className=\{cn\("([^"]+)", gpuSegmentTextClass\(segment\.kind\)\)\}>/,
    )?.[1].split(" ");

    expect(countClasses).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap"]));
  });
});
