// Typed client for the backend JSON API. The live snapshot (with embedded raw
// nodes/jobs) arrives via SSE (see lib/live.ts); these are the on-demand extras.
import type {
  HistoryPoint,
  LoginHistoryPoint,
  LoginNodesResponse,
  Meta,
  Snapshot,
  UsagePattern,
} from "@/types/snapshot";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  snapshot: () => get<Snapshot>("/api/snapshot"),
  meta: () => get<Meta>("/api/meta"),
  history: (hours = 24) =>
    get<{ since: number; until: number; points: HistoryPoint[] }>(`/api/history?hours=${hours}`),
  usage: (days = 30) => get<UsagePattern>(`/api/usage?days=${days}`),
  loginNodes: () => get<LoginNodesResponse>("/api/login-nodes"),
  loginHistory: (hours = 24) =>
    get<{ since: number; until: number; points: LoginHistoryPoint[] }>(
      `/api/login-nodes/history?hours=${hours}`,
    ),
};
