import { describe, expect, it } from "vitest";
import { isChunkLoadError } from "./stale-build";

describe("isChunkLoadError", () => {
  it("recognises a lazy chunk the last deploy removed (Chrome, Safari, Firefox wording)", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: http://x/hakusan/assets/jobs-abc.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module"))).toBe(true);
  });

  it("leaves real render errors alone", () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
  });
});
