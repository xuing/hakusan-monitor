// Mirrors the backend JSON schema (backend/normalize.py + server endpoints).

export type ResourceKind = "cpu" | "gpu";
export type PressureLevel = "low" | "moderate" | "high" | "critical";

export interface Totals {
  nodes: {
    total: number;
    available: number;
    down: number;
    by_state: Record<string, number>;
    gpu_total: number;
    gpu_free: number;
    cpu_total: number;
    cpu_free: number;
  };
  cpus: { total: number; alloc: number; free: number; util: number };
  memory: { total_mb: number; alloc_mb: number; util: number };
  gpus: {
    total: number;
    used: number;
    down: number;
    free: number;
    util: number;
    by_type: Record<string, { total: number; used: number; down: number; free: number }>;
  };
}

export interface Occupant {
  job_id: number | string;
  user: string;
  gpus: number;
  cpus: number;
  nodes: number;
  nodelist: string;
  time_left: string;
  end_time: string;
}

export interface PoolGpu {
  type: string;
  label: string;
  mem_gb: number | null;
  total: number;
  used: number;
  down: number;
  free: number;
  maint: boolean;
  util: number;
  next_free: NextFree | null;
}

export interface Pool {
  id: string;
  kind: ResourceKind;
  nodes: number;
  mem_per_node: number;
  nodes_state: Record<string, number>;
  idle_nodes: number;
  available_nodes: number;
  down_nodes: number;
  cpus_total: number;
  cpus_alloc: number;
  cores: { total: number; alloc: number; free: number; util: number };
  util: number;
  gpu: PoolGpu | null;
  partitions: string[];
  queue: { running: number; pending: number; releasing: { jobs: number; nodes: number } };
  avail: { units: number; unit: "gpu" | "cores"; can_now: boolean; idle_nodes: number };
}

export interface Partition {
  name: string;
  kind: ResourceKind;
  nodes: number;
  gpu_type: string | null;
  pool: string | null;
  cpus: { total: number; alloc: number; free: number; util: number };
  gpu: { total: number; used: number; down: number; free: number; util: number } | null;
  jobs: { running: number; pending: number };
  pending_reasons: Record<string, number>;
  pressure: number;
  level: PressureLevel;
  spec: { cores_per_node: number; mem_per_node: number; gpu_per_node: number };
  nodes_state: Record<string, number>;
  free_nodes: number;
  available_nodes: number;
  busy_nodes: number;
  releasing: { jobs: number; nodes: number };
}

export interface NextFree {
  at: string;
  left: string;
}

export interface GpuType {
  type: string;
  label: string;
  mem_gb: number | null;
  total: number;
  used: number;
  down: number;
  free: number;
  util: number;
  maint: boolean;
  next_free: NextFree | null;
}

export interface PendingJob {
  job_id: number | string;
  user: string;
  partition: string;
  gpu: string;
  cpus: number;
  reason: string;
  submit_time: number;
  start_est: string;
}

export interface Release {
  job_id: number | string;
  user: string;
  partition: string;
  pool: string | null;
  end_time: string;
  time_left: string;
  gpu_type: string | null;
  gpus: number;
  gpu: string;
  cpus: number;
}

export interface QueueData {
  running: number;
  pending: number;
  total: number;
  pending_reasons: Record<string, number>;
  by_partition: { partition: string; running: number; pending: number }[];
  top_pending: PendingJob[];
  releases: Release[];
  container_jobs: number;
}

export interface DownNode {
  name: string;
  state: string[];
  pool: string;
  reason: string;
}

export interface TopUser {
  user: string;
  running: number;
  cpus: number;
  gpus: number;
}

export interface Snapshot {
  cluster: string;
  slurm_version: string;
  totals: Totals;
  pools: Pool[];
  partitions: Partition[];
  gpus: GpuType[];
  queue: QueueData;
  nodes_down: DownNode[];
  top_users: TopUser[];
  /** raw data shipped in the same payload — tables/occupancy derive from this */
  nodes: RawNode[];
  jobs: RawJob[];
  part_pool: Record<string, string>;
  generated_at: number;
  age_s: number;
  source: string;
  stale: boolean;
  error?: string;
}

export interface ContainerInfo {
  runtime: string;
  version: string;
  has_docker: boolean;
  login_module: string | null;
  compute_module: string;
  examples: string[];
}

export interface Meta {
  cluster: string;
  slurm_version: string;
  source: string;
  interval: number;
  container: ContainerInfo;
  docs: Record<string, string>;
  partitions: { name: string; kind: string }[];
  store: {
    samples: number;
    hours: number;
    retain_days: number;
    first_ts: number | null;
    last_ts: number | null;
  };
}

export interface RawNode {
  name: string;
  pool: string; // hardware pool id, tagged by the backend (see normalize.node_pool)
  state: string[];
  partitions: string[];
  cpus: number;
  alloc_cpus: number;
  cpu_load: string;
  real_memory: number;
  alloc_memory: number;
  free_mem: number;
  gres: string;
  gres_used: string;
  features: string;
  alloc_tres: string;
  cfg_tres: string;
  boot_time: string;
  reason: string;
}

export interface RawJob {
  job_id: number | string;
  user_name: string;
  account: string;
  partition: string;
  job_state: string;
  state_reason: string;
  node_count: number;
  cpus: number;
  gpus: number;
  tres_req_str: string;
  container: string;
  submit_time: number;
  end_time: string;
  start_est: string;
  time_left: string;
  name: string;
  qos: string;
  nodelist: string;
  time_used: string;
  time_limit: string;
}

export interface HistoryPoint {
  ts: number;
  cpu_util: number;
  gpu_util: number;
  mem_util: number;
  running: number;
  pending: number;
  nodes_avail: number;
  nodes_down: number;
}

export interface UsageHour {
  hour: number;
  cpu: number;
  gpu: number;
  pending: number;
  samples: number;
}

export interface UsageWeekday {
  weekday: number;
  cpu: number;
  gpu: number;
  pending: number;
  samples: number;
}

export interface UsageCell {
  weekday: number;
  hour: number;
  gpu: number;
  cpu: number;
  samples: number;
}

export interface UsagePattern {
  days: number;
  by_hour: UsageHour[];
  by_weekday: UsageWeekday[];
  heatmap: UsageCell[];
  busiest_hour: UsageHour | null;
  quietest_hour: UsageHour | null;
  total_hours: number;
}
