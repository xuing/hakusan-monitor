// /api/analytics — job-history aggregates (backend/analytics.py). Shares are
// 0–1 and, except resource-hours, weight every user equally.

export type AnalyticsKind = "gpu" | "cpu";

interface AnalyticsPool {
  id: string;
  label: string;
  units: number | null;   // GPUs (gpu view) or cores (cpu view)
  nodes: number | null;
  down: number;           // GPUs down (gpu view) or nodes down (cpu view)
}

export interface WaitPartition {
  name: string;
  pool: string;
  users: number;
  jobs: number;
  unit_hours: number;
  buckets: number[];      // <1m, 1m–1h, 1–6h, 6–24h, ≥1d
  p50: number | null;     // seconds
  p90: number | null;
  max_units: number | null;
  max_cores: number | null;
  wall_min: number | null;
}

export interface AnalyticsView {
  kind: AnalyticsKind;
  unit: "gpu" | "core";
  since: number;
  until: number;
  pools: AnalyticsPool[];
  users: number;
  submissions: number;
  whole_node_partitions: string[];
  submit: {
    cells: number[][];          // [weekday Mon..Sun][hour] people submitting per hour
    by_hour: number[];
    by_weekday: number[];       // people submitting per day
    weeks: number;
    daily_weekday: number | null;
    daily_weekend: number | null;
  };
  free: {
    since: number | null;
    metric: "gpu" | "node";
    pools: { id: string; weekday: (number | null)[]; weekend: (number | null)[]; mean: number | null }[];
  };
  waits: {
    users: number;
    start_1m: number | null;
    start_1h: number | null;
    start_1d: number | null;
    partitions: WaitPartition[];
  };
  limits: {
    users: number;
    bins: number[];             // used/requested: <5%, 5–10, 10–25, 25–50, 50–75, 75–99, ≥99%
    median: number | null;
    at_max: number | null;
    top: { minutes: number; share: number }[];
  };
  limit_start: {
    bounds: number[];           // --time minutes: ≤60, ≤360, ≤1440, ≤4320, more
    pools: { id: string; share: (number | null)[]; users: number[] }[];
  };
  shapes: {
    bounds: number[];           // units per job: gpu [1, 2] / cpu [1, 16, 64, 256]
    pools: {
      id: string;
      users: number;
      buckets: number[];
      cpus_per_unit?: (number | null)[];   // [median, p90] cores per GPU
      mem_gb_per_unit: (number | null)[];  // [median, p90] GB per GPU / per core
    }[];
  };
  interactive: {
    pools: {
      id: string;
      sessions: number;
      users: number;
      end: number[];            // ran into the limit, user left, cancelled
      end_hours: number[];
      share_submit: number | null;
      share_hours: number | null;
      cap_min: number | null;
    }[];
  };
  runtime: { bounds: number[]; jobs: number[]; hours: number[] };
  outcomes: {
    pools: { id: string; users: number; states: number[]; fail_fast: number | null }[];
  };
  concentration: {
    users: number;
    unit_hours: number;
    groups: { from: number; to: number; share: number; rest?: boolean }[];
    half: number | null;
  };
  weekly: {
    starts: number[];
    partial: boolean;
    util: Record<string, (number | null)[]>;
    users: number[];
    new_users: { month: string; users: number }[];
    util13: { all: number | null; pools: Record<string, number | null>; weeks: number };
  };
}

export interface AnalyticsPayload {
  status: "ready" | "backfilling" | "idle" | "unavailable";
  generated_at?: number;
  fetched_at?: number;
  window_days?: number;
  history_since?: number | null;
  history_truncated?: boolean;
  outages?: [string, string][];
  priority?: { type?: string; scheduler?: string; weights?: Record<string, number> };
  thresholds?: { partition_users: number; cell_users: number };
  gpu?: AnalyticsView;
  cpu?: AnalyticsView;
  collecting?: boolean;
  progress?: { from: number; to: number; since: number } | null;
  error?: string | null;
}

/** Payload-level facts every card may cite. */
export interface AnalyticsMeta {
  windowDays: number;
  partitionUsers: number;
  cellUsers: number;
  scheduler: string;
  fairShare: number;
  outages: [string, string][];
  historySince: number | null;
}
