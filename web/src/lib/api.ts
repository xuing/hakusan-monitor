// Typed client for the backend JSON API. The live snapshot (with embedded raw
// nodes/jobs) arrives via SSE (see lib/live.ts); these are the on-demand extras.
import type {
  LoginHistoryPoint,
  LoginNodesResponse,
  Meta,
  PolicySource,
  Snapshot,
  VisitStats,
} from "@/types/snapshot";
import type { AnalyticsPayload } from "@/types/analytics";
import { withBase } from "@/lib/base-path";

async function get<T>(path: string, validate?: (value: unknown) => T): Promise<T> {
  const res = await fetch(withBase(path), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  const value: unknown = await res.json();
  return validate ? validate(value) : value as T;
}

export interface RefreshResult {
  accepted: boolean;
  /** seconds until the next refresh is allowed (when not accepted) */
  retry_after: number;
  /** someone already asked; that sample arrives over the stream */
  queued?: boolean;
}

export const api = {
  /** Ask for a sample now; the server allows one per refresh_min_interval. */
  refresh: async (): Promise<RefreshResult> => {
    const res = await fetch(withBase("/api/refresh"), { method: "POST", headers: { Accept: "application/json" } });
    if (res.status !== 202 && res.status !== 429) throw new Error(`/api/refresh → ${res.status}`);
    return await res.json() as RefreshResult;
  },
  snapshot: () => get<Snapshot>("/api/snapshot", validateSnapshot),
  meta: () => get<Meta>("/api/meta"),
  analytics: () => get<AnalyticsPayload>("/api/analytics"),
  visits: (days = 30) => get<VisitStats>(`/api/visits?days=${days}`),
  loginNodes: () => get<LoginNodesResponse>("/api/login-nodes"),
  /** raw job_submit.lua / sacctmgr / scontrol texts + verification report (large; on demand) */
  policySource: () => get<PolicySource>("/api/policy-source"),
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
