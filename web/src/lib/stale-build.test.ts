import { afterEach, describe, expect, it, vi } from "vitest";
import { isChunkLoadError } from "./stale-build";

/** A tab running build AAA, with the few browser globals stale-build reads. */
async function tab({ hidden = false, reloadedFor = "" } = {}) {
  vi.resetModules();
  const store = new Map<string, string>(reloadedFor ? [["hm_reload_for_build", reloadedFor]] : []);
  const reload = vi.fn();
  const doc = { hidden, querySelector: () => ({ src: "https://host/hakusan/assets/index-AAA.js" }), addEventListener: vi.fn() };
  vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
  vi.stubGlobal("window", { addEventListener: vi.fn(), location: { reload } });
  vi.stubGlobal("document", doc);
  const { noticeBuild } = await import("./stale-build");
  return { noticeBuild, reload, doc };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("reloading onto a new deploy", () => {
  it("reloads a hidden tab at once, and only for another build", async () => {
    const same = await tab({ hidden: true });
    same.noticeBuild("AAA");
    same.noticeBuild("");
    same.noticeBuild(undefined);
    expect(same.reload).not.toHaveBeenCalled();
    const other = await tab({ hidden: true });
    other.noticeBuild("BBB");
    expect(other.reload).toHaveBeenCalledTimes(1);
  });

  it("waits for a visible tab to sit 2 min without input", async () => {
    vi.useFakeTimers();
    const t = await tab();
    t.noticeBuild("BBB");
    vi.advanceTimersByTime(105_000);
    expect(t.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(15_000);
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload twice for the same build", async () => {
    const t = await tab({ hidden: true, reloadedFor: "BBB" });
    t.noticeBuild("BBB");
    expect(t.reload).not.toHaveBeenCalled();
  });
});

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
