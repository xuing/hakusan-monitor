import { createContext, useContext } from "react";
import type { LiveStatus } from "@/lib/live";
import type { Snapshot } from "@/types/snapshot";

export interface LiveValue {
  snap: Snapshot | null;
  status: LiveStatus;
  error: Error | null;
  retry: () => void;
}

export const LiveContext = createContext<LiveValue>({
  snap: null,
  status: "reconnecting",
  error: null,
  retry: () => {},
});

export const useLive = (): LiveValue => useContext(LiveContext);
