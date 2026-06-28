import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { connectLive, type LiveStatus } from "@/lib/live";
import type { Snapshot } from "@/types/snapshot";

interface LiveValue {
  snap: Snapshot | null;
  status: LiveStatus;
}

const LiveContext = createContext<LiveValue>({ snap: null, status: "offline" });

/** Opens a single live connection for the whole app. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<LiveStatus>("offline");

  useEffect(
    () => connectLive({ onSnapshot: setSnap, onStatus: setStatus }),
    [],
  );

  return <LiveContext.Provider value={{ snap, status }}>{children}</LiveContext.Provider>;
}

export const useLive = (): LiveValue => useContext(LiveContext);
