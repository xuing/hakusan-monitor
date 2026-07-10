import { useEffect, useState, type ReactNode } from "react";
import { connectLive, type LiveStatus } from "@/lib/live";
import type { Snapshot } from "@/types/snapshot";
import { LiveContext } from "./live-context";

/** Opens a single live connection for the whole app. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<LiveStatus>("reconnecting");
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(
    () => connectLive({ onSnapshot: setSnap, onStatus: setStatus, onError: setError }),
    [attempt],
  );

  const retry = () => {
    setError(null);
    setStatus("reconnecting");
    setAttempt((n) => n + 1);
  };
  return <LiveContext.Provider value={{ snap, status, error, retry }}>{children}</LiveContext.Provider>;
}
