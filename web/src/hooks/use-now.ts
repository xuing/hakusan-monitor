import { useSyncExternalStore } from "react";

// One clock for every component that shows or judges against "now": it ticks
// every 30 s while anything listens, so render stays pure (no Date.now()
// during render) and all readers agree on the same instant.
const TICK_MS = 30_000;
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  if (!listeners.size) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) clearInterval(timer);
  };
}

/** The current time (ms), refreshed every 30 s. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now, () => now);
}
