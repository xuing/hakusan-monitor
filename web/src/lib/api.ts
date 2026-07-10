// Typed client for the backend JSON API. The live snapshot (with embedded raw
// nodes/jobs) arrives via SSE (see lib/live.ts); these are the on-demand extras.
import type {
  HistoryPoint,
  LoginHistoryPoint,
  LoginNodesResponse,
  Meta,
  Snapshot,
  UsagePattern,
  VisitStats,
} from "@/types/snapshot";

async function get<T>(path: string, validate?: (value: unknown) => T): Promise<T> {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  const value: unknown = await res.json();
  return validate ? validate(value) : value as T;
}

export const api = {
  snapshot: () => get<Snapshot>("/api/snapshot", validateSnapshot),
  meta: () => get<Meta>("/api/meta"),
  history: (hours = 24) =>
    get<{ since: number; until: number; points: HistoryPoint[] }>(`/api/history?hours=${hours}`),
  usage: (days = 30) => get<UsagePattern>(`/api/usage?days=${days}`),
  visits: (days = 30) => get<VisitStats>(`/api/visits?days=${days}`),
  loginNodes: () => get<LoginNodesResponse>("/api/login-nodes"),
  loginHistory: (hours = 24) =>
    get<{ since: number; until: number; points: LoginHistoryPoint[] }>(
      `/api/login-nodes/history?hours=${hours}`,
    ),
};

export function validateSnapshot(value: unknown): Snapshot {
  // Rolling deployments write the static frontend before systemd restarts the
  // backend. The immediately preceding snapshot shape had no explicit version
  // marker, but is otherwise v1-compatible; accepting that one legacy shape
  // prevents a transient blank dashboard during the hand-off.
  if (!isRecord(value)
      || (value.schema_version !== undefined && value.schema_version !== 1)
      || !isRecord(value.totals)
      || !Array.isArray(value.pools)
      || !Array.isArray(value.partitions)
      || !Array.isArray(value.nodes)
      || !Array.isArray(value.jobs)
      || typeof value.generated_at !== "number") {
    throw new Error("/api/snapshot → unsupported or malformed schema");
  }
  return { ...value, schema_version: 1 } as unknown as Snapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
