// Live snapshot stream: Server-Sent Events with a polling fallback.
import type { Snapshot } from "@/types/snapshot";
import { api } from "./api";

export type LiveStatus = "live" | "polling" | "reconnecting" | "offline";

interface LiveHandlers {
  onSnapshot: (s: Snapshot) => void;
  onStatus: (s: LiveStatus) => void;
}

/** Subscribe to live snapshots. Returns an unsubscribe function. */
export function connectLive({ onSnapshot, onStatus }: LiveHandlers): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let gotData = false;

  const stopPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const startPolling = () => {
    if (pollTimer || closed) return;
    const tick = async () => {
      try {
        const snap = await api.snapshot();
        if (closed) return;
        onStatus("polling");
        onSnapshot(snap);
      } catch {
        if (!closed) onStatus("offline");
      }
    };
    void tick();
    pollTimer = setInterval(() => void tick(), 15000);
  };

  if (typeof EventSource === "undefined") {
    startPolling();
  } else {
    es = new EventSource("/api/stream");
    es.onmessage = (e) => {
      if (closed) return;
      gotData = true;
      stopPolling(); // SSE is back — drop the safety-net poller
      onStatus("live");
      try {
        onSnapshot(JSON.parse(e.data) as Snapshot);
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => {
      if (closed) return;
      onStatus(gotData ? "reconnecting" : "offline");
      // Poll regardless: EventSource never recovers from non-200 responses
      // (e.g. the server's SSE connection cap), so without this the page would
      // sit on "reconnecting" forever while /api/snapshot works fine.
      if (!gotData) es?.close();
      startPolling();
    };
  }

  return () => {
    closed = true;
    es?.close();
    if (pollTimer) clearInterval(pollTimer);
  };
}
