import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { connectLive } from "./live";
import type { Snapshot } from "@/types/snapshot";

vi.mock("./api", () => ({ api: { snapshot: vi.fn() }, validateSnapshot: (v: unknown) => v }));

class FakeEventSource {
  static latest: FakeEventSource;
  onmessage?: (e: { data: string }) => void;
  onerror?: () => void;
  constructor() { FakeEventSource.latest = this; }
  close() {}
  addEventListener() {}
}

describe("live transport handoff", () => {
  let dispose: (() => void) | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    vi.mocked(api.snapshot).mockReset();
  });
  afterEach(() => {
    dispose?.();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([false, true])("ignores late polling completion after SSE recovery (reject=%s)", async (reject) => {
    let resolve!: (s: Snapshot) => void;
    let fail!: (e: Error) => void;
    vi.mocked(api.snapshot).mockReturnValue(new Promise((yes, no) => { resolve = yes; fail = no; }));
    const onSnapshot = vi.fn(), onStatus = vi.fn(), onError = vi.fn();
    dispose = connectLive({ onSnapshot, onStatus, onError });
    const stream = FakeEventSource.latest;
    stream.onmessage?.({ data: '{"generated_at":1}' });
    stream.onerror?.();
    stream.onmessage?.({ data: '{"generated_at":3}' });
    if (reject) fail(new Error("late failure"));
    else resolve({ generated_at: 2 } as Snapshot);
    await Promise.resolve();
    expect(onSnapshot).toHaveBeenLastCalledWith({ generated_at: 3 });
    expect(onStatus).toHaveBeenLastCalledWith("live");
    expect(onError).toHaveBeenLastCalledWith(null);
  });

  it("does not overlap slow polls or publish after unsubscribe", async () => {
    let resolve!: (s: Snapshot) => void;
    vi.mocked(api.snapshot).mockReturnValue(new Promise((yes) => { resolve = yes; }));
    const onSnapshot = vi.fn();
    dispose = connectLive({ onSnapshot, onStatus: vi.fn() });
    FakeEventSource.latest.onerror?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.snapshot).toHaveBeenCalledTimes(1);
    dispose();
    resolve({ generated_at: 1 } as Snapshot);
    await Promise.resolve();
    expect(onSnapshot).not.toHaveBeenCalled();
  });
});
