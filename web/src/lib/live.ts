// Live snapshot stream: Server-Sent Events with a polling fallback.
import type { Snapshot } from "@/types/snapshot";
import { api, validateSnapshot } from "./api";

export type LiveStatus = "live" | "polling" | "reconnecting" | "offline";

interface LiveHandlers {
  onSnapshot: (s: Snapshot) => void;
  onStatus: (s: LiveStatus) => void;
  onError?: (error: Error | null) => void;
}

/** Subscribe to live snapshots. Returns an unsubscribe function. */
export function connectLive({ onSnapshot, onStatus, onError }: LiveHandlers): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let lastBeat = Date.now(); // last proof the stream is alive (snapshot or ping)
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
        onError?.(null);
        onStatus("polling");
        onSnapshot(snap);
      } catch (error) {
        if (!closed) {
          onError?.(error instanceof Error ? error : new Error("Snapshot request failed"));
          onStatus("offline");
        }
      }
    };
    void tick();
    pollTimer = setInterval(() => void tick(), 15000);
  };

  const connect = () => {
    if (closed) return;
    es?.close();
    lastBeat = Date.now();
    es = new EventSource("/api/stream");
    es.onmessage = (e) => {
      if (closed) return;
      lastBeat = Date.now();
      try {
        const snap = validateSnapshot(JSON.parse(e.data));
        gotData = true;
        onError?.(null);
        stopPolling(); // SSE is back — drop the safety-net poller
        onStatus("live");
        onSnapshot(snap);
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error("Malformed live frame"));
        onStatus(gotData ? "reconnecting" : "offline");
        startPolling();
      }
    };
    // Server heartbeat (15 s). Snapshots only arrive on new samples (minutes
    // apart), so this is the only way to tell "quiet but alive" from "dead".
    es.addEventListener("ping", () => {
      lastBeat = Date.now();
    });
    es.onerror = () => {
      if (closed) return;
      onError?.(new Error("Live stream unavailable"));
      onStatus(gotData ? "reconnecting" : "offline");
      // Poll regardless: EventSource never recovers from non-200 responses
      // (e.g. the server's SSE connection cap), so without this the page would
      // sit on "reconnecting" forever while /api/snapshot works fine.
      if (!gotData) es?.close();
      startPolling();
    };
  };

  const wake = () => {
    // Coming back from sleep / regaining network: don't wait for the watchdog.
    if (closed || !es) return;
    if (document.visibilityState !== "hidden" && Date.now() - lastBeat > 20_000) connect();
  };

  if (typeof EventSource === "undefined") {
    startPolling();
  } else {
    connect();
    // A silently dead socket (laptop sleep, wifi switch, NAT timeout) fires no
    // error event — the page would just freeze on old data. Three missed
    // heartbeats means the stream is gone: rebuild it (the server replays the
    // latest snapshot on connect) and poll to cover the gap.
    watchdog = setInterval(() => {
      if (closed || !es) return;
      if (Date.now() - lastBeat > 45_000) {
        onStatus(gotData ? "reconnecting" : "offline");
        startPolling();
        connect();
      }
    }, 10_000);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
  }

  return () => {
    closed = true;
    es?.close();
    if (pollTimer) clearInterval(pollTimer);
    if (watchdog) clearInterval(watchdog);
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("online", wake);
  };
}
