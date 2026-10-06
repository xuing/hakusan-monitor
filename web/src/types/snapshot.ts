// Mirrors the backend JSON schema (backend/normalize.py + server endpoints).

type ResourceKind = "cpu" | "gpu";

export interface Occupant {
  job_id: number | string;
  user: string;
  partition: string;
  gpus: number;
  cpus: number;
  mem_mb: number;
  nodes: number;
  nodelist: string;
  time_left: string;
  time_limit: string;
  end_time: string;
}

export interface PoolGpu {
  type: string;
  label: string;
  mem_gb: number | null;
  total: number;
  used: number;
  down: number;
  reserved?: number;
  free: number;
  maint: boolean;
  util: number;
  next_free: NextFree | null;
}

export interface Pool {
  id: string;
  kind: ResourceKind;
  /** partition the starter command uses (site file, else Slurm's default) */
  sample_partition?: string | null;
  nodes: number;
  mem_per_node: number;
  nodes_state: Record<string, number>;
  idle_nodes: number;
  available_nodes: number;
  down_nodes: number;
  cores: { total: number; alloc: number; free: number; unavailable?: number; util: number };
  util: number;
  gpu: PoolGpu | null;
  partitions: string[];
  queue: { running: number; pending: number };
}

export interface Partition {
  name: string;
  kind: ResourceKind;
  nodes: number;
  pool: string | null;
  cpus: { total: number; alloc: number; free: number; unavailable?: number; util: number };
  gpu: { total: number; used: number; down: number; reserved?: number; free: number; util: number } | null;
  /** a job queued to several partitions counts in each */
  jobs: { running: number; pending: number };
  spec: { cores_per_node: number; mem_per_node: number; gpu_per_node: number };
  nodes_state: Record<string, number>;
  /** in service, with a free GPU (GPU partitions) or a free core */
  available_nodes: number;
}

export interface NextFree {
  at: string;
  left: string;
  /** GPUs released at this earliest end time (additive for legacy snapshots). */
  gpus?: number;
}

interface PendingJob {
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

interface QueueData {
  running: number;
  pending: number;
  pending_reasons: Record<string, number>;
  top_pending: PendingJob[];
  longest_pending_by_partition?: PendingJob[];
  releases: Release[];
  container_jobs: number;
}

export interface CpuSubmitProbe {
  partition: string;
  /** true placed, false Slurm rejected the request, null no answer (timeout) */
  ok: boolean | null;
  start_time: string;
  start_epoch: number;
  processors: number;
  nodes: string;
  raw: string;
  rc?: number;
}

export interface DynamicPartitionCap {
  minCores?: number;
  maxCores?: number;
  maxMemGb?: number;
  minGpus?: number;
  maxGpus?: number;
  maxNodes?: number;
  wall?: string;
}

export interface DynamicPartitionPolicy {
  grpJobs?: number;
  maxJobsPerUser?: number;
  maxSubmitPerUser?: number;
}

/** What a flagless request actually asks Slurm for. NOT the QoS cap. Read
 *  from the cluster's job_submit.lua (backend/lua_policy.py) plus `scontrol
 *  show partition`; where scripts/check_cluster_policy.py has measured the
 *  partition with a held job, the measured values win (`measured`). */
export interface PartitionDefaults {
  /** cores the submit plugin puts on a request with no -n/-c */
  cores?: number;
  /** tasks the plugin pins (a bare -c multiplies by this) */
  tasks?: number;
  /** partition DefMemPerCPU, in MB (read live from `scontrol show partition`) */
  def_mem_per_cpu_mb?: number;
  max_mem_per_cpu_mb?: number;
  def_mem_per_node_mb?: number;
  max_mem_per_node_mb?: number;
  /** the Lua's own pn_min_memory default (MB) — Slurm does NOT apply it,
   *  DefMemPerCPU wins; kept so the UI can show the discrepancy */
  lua_mem_per_node_mb?: number;
  /** GPUs per node the plugin adds on GPU partitions (TresPerNode=gres/gpu:N) */
  gpus_per_node?: number;
  /** false = the plugin overwrites any --gres/--gpus-per-node with gpus_per_node */
  gpu_request_respected?: boolean;
  /** walltime (minutes) the plugin forces on salloc/srun jobs; absent = -t honoured */
  interactive_time_min?: number;
  /** the branch rejects jobs without -L */
  requires_license?: boolean;
  /** the -L the plugin fills in when none is given ("ms_castep@lmgr:1") */
  default_license?: string;
  /** true when the verification script confirmed cores/memory with a held job */
  measured?: boolean;
}

/** Raw facts parsed from one partition branch of job_submit.lua. */
export interface LuaPartitionFacts {
  line?: number;
  default_tasks?: number;
  default_cpus?: number;
  default_cpus_per_task?: number;
  default_mem_per_node_mb?: number;
  default_gpus_per_node?: number;
  /** job_desc fields the branch consults before applying its GPU default */
  gpu_request_fields?: string[];
  gpu_request_respected?: boolean;
  interactive_time_min?: number;
  requires_license?: boolean;
  /** the -L the plugin fills in when none is given ("ms_castep@lmgr:1") */
  default_license?: string;
}

export interface LuaVersion {
  name: string;
  mtime: number;
  size: number;
  current: boolean;
}

export interface PolicyLua {
  path?: string;
  sha?: string;
  mtime?: number;
  versions?: LuaVersion[];
  partitions?: Record<string, LuaPartitionFacts>;
  parsed?: boolean;
}

/** Snapshot-sized summary of the last scripts/check_cluster_policy.py run. */
export interface PolicyCheckSummary {
  checked_at?: number;
  lua_sha?: string;
  ok?: boolean;
  mismatches?: string[];
}

export interface PolicySnapshot {
  generated_at: number;
  interval: number;
  /** `scontrol show topology` (topology/tree): switches with hostlists */
  topology?: { name: string; level: number; nodes: string; switches: string }[];
  partition_caps: Record<string, DynamicPartitionCap>;
  partition_policies: Record<string, DynamicPartitionPolicy>;
  partition_defaults?: Record<string, PartitionDefaults>;
  /** per-partition provenance; every cap now comes from the live sacctmgr QoS */
  cap_origin?: Record<string, "live">;
  qos?: Record<string, unknown>;
  /** `scontrol show partition` facts per partition; `qos` is the partition
   *  QoS whose GrpJobs / MaxJobsPerUser the queue model counts */
  partitions?: Record<string, { qos?: string }>;
  lua?: PolicyLua;
  check?: PolicyCheckSummary | null;
}

/** One partition's verification result (held-job probe vs. our reading). */
export interface PolicyCheckPartition {
  expected?: { cpus?: number; mem_per_cpu_mb?: number; gpus_per_node?: number };
  measured?: { cpus?: number; tasks?: number; cpus_per_task?: number; gpus_per_node?: number; mem_per_cpu_mb?: number };
  gres2_gpus_per_node?: number;
  gpu_request_honoured?: boolean;
  notes?: string[];
  diffs?: string[];
  ok?: boolean;
}

export interface PolicyCheckReport {
  checked_at?: number;
  host?: string;
  lua_path?: string;
  lua_sha?: string;
  probe_jobs_left?: number;
  partitions?: Record<string, PolicyCheckPartition>;
  skipped?: Record<string, string>;
  /** largest value of every quick-request field, probed as held jobs */
  boundary?: {
    checked: number;
    problems: { partition: string; field: string; value: string; args: string; issues: string[] }[];
    skipped?: string;
    probe_jobs_left?: number | null;
  };
}

/** GET /api/policy-source — the raw cluster texts the policy block is read from. */
export interface PolicySource {
  fetched_at: number;
  interval: number;
  lua_text: string;
  qos_text: string;
  partitions_text: string;
  lua: PolicyLua;
  check: PolicyCheckReport | null;
}

export interface DownNode {
  name: string;
  state: string[];
  pool: string;
  reason: string;
}

export interface Snapshot {
  schema_version: 1;
  cluster: string;
  slurm_version: string;
  pools: Pool[];
  partitions: Partition[];
  queue: QueueData;
  /** cluster licenses (`scontrol show lic`): the names -L must use */
  licenses?: ClusterLicense[];
  /** hardware scontrol lists but no partition schedules, per pool */
  outside_nodes?: { pool: string; label: string; nodes: number; gpus: number }[];
  /** the web build the server serves (lib/stale-build.ts) */
  build?: string;
  /** the site's partition order, else slurm.conf's */
  partition_order?: string[];
  cpu_submit_probes?: CpuSubmitProbe[];
  cpu_submit_probes_generated_at?: number;
  cpu_submit_probe_interval?: number;
  /** seconds between two "refresh now" samples, for everyone together */
  refresh_min_interval?: number;
  policy?: PolicySnapshot;
  nodes_down: DownNode[];
  /** raw data shipped in the same payload — tables/occupancy derive from this */
  nodes: RawNode[];
  jobs: RawJob[];
  part_pool: Record<string, string>;
  generated_at: number;
  age_s: number;
  source: string;
  stale: boolean;
  error?: string;
  /** consecutive failed sample cycles (0 when healthy) */
  fail_count?: number;
  last_fail_at?: number;
}

export interface ContainerInfo {
  runtime: string;
  version: string;
  command?: string;
}

export interface Meta {
  cluster: string;
  slurm_version: string;
  source: string;
  interval: number;
  login_nodes?: {
    configured: boolean;
    interval: number;
    top_n: number;
    show_args: boolean;
  };
  /** null until `singularity --version` answered on the cluster */
  container: ContainerInfo | null;
  policy?: PolicySnapshot | null;
  partitions: { name: string; kind: string }[];
  store: {
    samples: number;
    retain_days: number;
    login_retain_days?: number;
    visit_retain_days?: number;
    schema_version?: number;
    first_ts: number | null;
    last_ts: number | null;
  };
}

export interface RawNode {
  name: string;
  pool: string; // hardware pool id, tagged by the backend (see site_config.Site.assign_pools)
  state_bucket: string;
  schedulable: boolean;
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
  gpu_type?: string;
  tres_req_str: string;
  min_memory?: string;
  min_memory_mb?: number;
  container: string;
  submit_time: number;
  end_time: string;
  start_est: string;
  time_left: string;
  name: string;
  qos: string;
  nodelist: string;
  /** backfill scheduler's planned placement for a pending job (hostlist) */
  sched_nodes?: string;
  /** nodes explicitly required by --nodelist; these are mandatory, not a preference */
  req_nodes?: string;
  /** nodes explicitly made ineligible by --exclude */
  exc_nodes?: string;
  /** the request's shape, as Slurm's node selection reads it (0 = not given) */
  tasks?: number;
  tasks_per_node?: number;
  cpus_per_task?: number;
  min_cpus_node?: number;
  max_nodes?: number;
  /** --mem-per-cpu or --mem per node (MB); one is 0 */
  mem_per_cpu_mb?: number;
  mem_per_node_mb?: number;
  time_used: string;
  /** Slurm priority (squeue %Q); comparable across partitions here */
  priority?: number;
  time_limit: string;
}

export interface LoginProcess {
  pid: number;
  user: string;
  stat: string;
  cpu_pct: number;
  mem_pct: number;
  rss: number;
  elapsed_s: number;
  command: string;
  args: string;
}

export interface LoginDisk {
  filesystem: string;
  size: number;
  used: number;
  available: number;
  use_pct: number;
  mount: string;
  inodes_total?: number;
  inodes_used?: number;
  inodes_free?: number;
  inode_use_pct?: number;
}

export interface LoginIoDevice {
  name: string;
  util_pct: number | null;
  await_ms: number | null;
  aqu_sz: number | null;
  read_kbps: number;
  write_kbps: number;
  discard_kbps: number;
  io_kbps: number;
}

export interface LoginIo {
  source: string;
  available: boolean;
  sample_s: number;
  devices: LoginIoDevice[];
  iowait_pct: number | null;
  max_util_pct: number | null;
  max_await_ms: number | null;
  max_aqu_sz: number | null;
}

export interface LoginUser {
  user: string;
  cpu_pct: number;
  mem_pct: number;
  rss: number;
  processes: number;
}

export interface LoginNode {
  id: string;
  target: string;
  hostname?: string;
  ok: boolean;
  sampled_at: number;
  error?: string;
  fail_count?: number;
  cores?: number;
  load?: { "1m": number; "5m": number; "15m": number; per_core: number };
  cpu?: { busy: number | null; iowait: number | null };
  memory?: {
    total: number;
    available: number;
    used: number;
    used_ratio: number;
    swap_total: number;
    swap_used: number;
    swap_ratio: number;
  };
  disks?: LoginDisk[];
  io?: LoginIo;
  processes?: {
    top_cpu: LoginProcess[];
    top_mem: LoginProcess[];
    d_state: number;
  };
  users?: LoginUser[];
}

export interface LoginNodesResponse {
  generated_at: number;
  age_s: number;
  interval: number;
  configured: boolean;
  stale: boolean;
  warming_up?: boolean;
  error?: string;
  nodes: LoginNode[];
  top_users: LoginUser[];
}

export interface LoginHistoryPoint {
  ts: number;
  node_id: string;
  load1: number;
  load_per_core: number;
  cpu_busy: number | null;
  cpu_iowait: number | null;
  mem_used_ratio: number;
  swap_used_ratio: number;
  disk_used_max: number;
  inode_used_max: number;
  d_state: number;
}

export interface VisitDay {
  day: string;
  visitors: number;
  hits: number;
}

export interface VisitStats {
  days: number;
  daily: VisitDay[];
  today: { visitors: number; hits: number };
  window: { visitors: number; hits: number };
  total: { visitors: number; hits: number; since: string | null };
}

export interface ClusterLicense {
  /** "ms_castep@lmgr" */
  name: string;
  total: number;
  used: number;
  free: number;
}
