/// <reference types="node" />

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const MIN_PX = 13;
const MIN_REM = MIN_PX / 16;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:css|ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("product typography floor", () => {
  it("does not bypass text-xs with arbitrary font sizes below 13px", () => {
    const offenders: string[] = [];
    const arbitrarySize = /text-\[(\d+(?:\.\d+)?)(px|rem)\]/g;

    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(arbitrarySize)) {
        const size = Number(match[1]);
        const belowFloor = match[2] === "px" ? size < MIN_PX : size < MIN_REM;
        if (belowFloor) offenders.push(`${relative(SRC, file)}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
