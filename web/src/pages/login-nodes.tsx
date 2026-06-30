import { AreaChart } from "@tremor/react";
import { AlertTriangle, Cpu, HardDrive, Loader2, MemoryStick, Server } from "lucide-react";
import type { ReactNode } from "react";
import { Empty } from "@/components/common/empty";
import { Bar } from "@/components/common/bar";
import { HoverHint } from "@/components/common/hover-hint";
import { SectionCard } from "@/components/common/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useApi } from "@/hooks/use-api";
import { useT } from "@/i18n";
import { api } from "@/lib/api";
import { fmtDur, pct } from "@/lib/format";
import type { Tone } from "@/lib/slurm";
import type {
  LoginHistoryPoint,
  LoginNode,
  LoginProcess,
  LoginUser,
} from "@/types/snapshot";

const HOURS = 24;
const POLL_MS = 60_000;

const colors = ["blue", "emerald", "amber", "rose", "violet", "cyan"];

export default function LoginNodesPage() {
  const t = useT();
  const current = useApi(() => api.loginNodes(), "login-nodes", POLL_MS);
  const history = useApi(() => api.loginHistory(HOURS), HOURS, POLL_MS);
  const data = current.data;
  const nodes = data?.nodes ?? [];
  const okNodes = nodes.filter((n) => n.ok);
  const nodeIds = okNodes.map((n) => n.id);

  if (current.loading && !data) return <LoadingState />;
  if (current.error && !data) return <LoginErrorState message={current.error.message} />;

  return (
    <div className="space-y-4">
      {current.error && (
        <SectionCard>
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {current.error.message}
          </div>
        </SectionCard>
      )}

      {!data?.configured ? (
        <SectionCard title={t("login.title")}>
          <Empty>{t("login.notConfigured")}</Empty>
        </SectionCard>
      ) : nodes.length === 0 ? (
        <SectionCard title={t("login.title")}>
          <Empty>{data?.error || t("login.nodata")}</Empty>
        </SectionCard>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            {nodes.map((node) => (
              <NodePanel key={node.id} node={node} />
            ))}
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <HistoryPanel
              title={t("login.historyLoad")}
              points={history.data?.points ?? []}
              nodeIds={nodeIds}
              field="load_per_core"
              formatter={(v) => v.toFixed(2)}
            />
            <HistoryPanel
              title={t("login.historyMem")}
              points={history.data?.points ?? []}
              nodeIds={nodeIds}
              field="mem_used_ratio"
              scale={100}
              formatter={(v) => `${Math.round(v)}%`}
            />
            <HistoryPanel
              title={t("login.historyIowait")}
              points={history.data?.points ?? []}
              nodeIds={nodeIds}
              field="cpu_iowait"
              scale={100}
              formatter={(v) => `${Math.round(v)}%`}
            />
          </div>

          <SectionCard title={t("login.topUsers")}>
            <UsersTable users={data?.top_users ?? []} />
          </SectionCard>

          <div className="grid min-w-0 gap-4 xl:grid-cols-2">
            {nodes.map((node) => (
              <OffenderPanel key={node.id} node={node} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function NodePanel({ node }: { node: LoginNode }) {
  const t = useT();
  const mem = node.memory;
  const disks = [...(node.disks ?? [])].sort((a, b) => b.use_pct - a.use_pct);
  const loadPerCore = node.load?.per_core ?? 0;
  const busy = node.cpu?.busy;
  const cpuIowait = node.cpu?.iowait;
  const ioIowaitFromIostat = node.io?.iowait_pct != null;
  const ioIowait = ioIowaitFromIostat ? (node.io?.iowait_pct ?? 0) / 100 : cpuIowait;
  const dState = node.processes?.d_state ?? 0;
  const ioUtil = node.io?.max_util_pct == null ? null : node.io.max_util_pct / 100;
  const ioAwait = node.io?.max_await_ms ?? null;
  const ioQueue = node.io?.max_aqu_sz ?? null;
  // Visible line keeps only the two numbers that explain the headline I/O-wait %
  // (how busy the device is, how slow each request is); D-state and queue depth
  // are still there, just on hover, so nothing is actually lost — only deferred.
  const ioShort = node.io?.devices?.length
    ? `${ioIowaitFromIostat ? "iostat" : "/proc/stat"} · ${t("login.ioUtil")} ${ioUtil == null ? "—" : pct(ioUtil)} · ${t("login.ioAwait")} ${fmtMs(ioAwait)}`
    : t("login.ioNoData");
  const ioFull = node.io?.devices?.length
    ? [
        t(ioIowaitFromIostat ? "login.ioSourceIostat" : "login.ioSourceProcStat"),
        `${t("login.ioUtil")} ${ioUtil == null ? "—" : pct(ioUtil)}`,
        `${t("login.ioAwait")} ${fmtMs(ioAwait)}`,
        `${t("login.dstate")} ${dState}`,
        `${t("login.ioQueue")} ${fmtQueue(ioQueue)}`,
      ].join(" · ")
    : t("login.ioNoData");

  if (!node.ok) {
    return (
      <SectionCard title={node.id}>
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
          <div>
            <div className="text-sm font-medium text-destructive">{node.error || t("login.unavailable")}</div>
            <div className="mt-1 text-xs text-muted-foreground">{t("login.nodeRetry")}</div>
          </div>
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title={
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4" />
          <span>{node.id}</span>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Metric
            icon={<Cpu className="h-4 w-4" />}
            label={t("login.loadCore")}
            value={loadPerCore.toFixed(2)}
            detail={`${t("login.load1")} ${(node.load?.["1m"] ?? 0).toFixed(2)} · ${node.cores ?? 0} ${t("kpi.cores")}`}
            bar={Math.min(loadPerCore / 2, 1)}
            barTone={loadTone(loadPerCore)}
          />
          <Metric
            icon={<Cpu className="h-4 w-4" />}
            label={t("login.cpuBusy")}
            value={busy == null ? "—" : pct(busy)}
            detail={`/proc/stat ${t("login.iowait")} ${cpuIowait == null ? "—" : pct(cpuIowait)}`}
            bar={busy ?? 0}
            barTone={ratioTone(busy, 0.7, 0.9)}
          />
          <Metric
            icon={<MemoryStick className="h-4 w-4" />}
            label={t("kpi.memory")}
            value={pct(mem?.used_ratio)}
            detail={`${fmtBytes(mem?.available ?? 0)} ${t("kpi.free")} · ${t("login.swap")} ${pct(mem?.swap_ratio)}`}
            bar={mem?.used_ratio ?? 0}
            barTone={ratioTone(mem?.used_ratio, 0.8, 0.95)}
          />
          <Metric
            icon={<HardDrive className="h-4 w-4" />}
            label={t("login.diskPressure")}
            value={ioIowait == null ? "—" : pct(ioIowait)}
            detail={ioShort}
            detailTitle={ioFull}
            bar={ioIowait ?? 0}
            barTone={ratioTone(ioIowait, 0.1, 0.2)}
          />
        </div>

        <div className="space-y-1">
          <div className="flex items-baseline justify-between">
            <div className="text-xs font-medium text-muted-foreground">
              {t("login.diskSpaceRef")}
              <HoverHint text={t("login.diskScope")} />
            </div>
            <div className="text-[11px] text-muted-foreground">{disks.length}</div>
          </div>
          <Table containerClassName="max-h-56 rounded-lg border border-border subtle-scroll">
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead>{t("login.mount")}</TableHead>
                <TableHead>{t("login.used")}</TableHead>
                <TableHead>{t("login.available")}</TableHead>
                <TableHead>{t("login.filesystem")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {disks.map((d) => (
                <TableRow key={`${d.filesystem}-${d.mount}`}>
                  <TableCell className="font-medium">{d.mount}</TableCell>
                  <TableCell>{d.use_pct}%</TableCell>
                  <TableCell>{fmtBytes(d.available)}</TableCell>
                  <TableCell className="max-w-[12rem] truncate text-muted-foreground">{d.filesystem}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

      </div>
    </SectionCard>
  );
}

function Metric({
  icon,
  label,
  value,
  detail,
  detailTitle,
  bar,
  barTone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  detailTitle?: string;
  bar: number;
  barTone?: Tone;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className="text-lg font-semibold tabular-nums">{value}</div>
      </div>
      <Bar value={bar} tone={barTone} className="mt-3" />
      <div className="mt-2 truncate text-xs text-muted-foreground" title={detailTitle}>{detail}</div>
    </div>
  );
}

function ratioTone(value: number | null | undefined, warn: number, bad: number): Tone {
  if (value == null) return "neutral";
  const displayed = Math.round(value * 100) / 100;
  if (displayed >= bad) return "bad";
  if (displayed >= warn) return "warn";
  return "ok";
}

function loadTone(value: number): Tone {
  const displayed = Math.round(value * 100) / 100;
  if (displayed >= 2) return "bad";
  if (displayed >= 1) return "warn";
  return "ok";
}

function OffenderPanel({ node }: { node: LoginNode }) {
  const t = useT();
  if (!node.ok) return null;
  return (
    <SectionCard title={`${node.id} · ${t("login.processes")}`} className="min-w-0" bodyClassName="min-w-0 overflow-hidden">
      <div className="grid gap-4">
        <ProcessTable title={t("login.topCpu")} rows={node.processes?.top_cpu ?? []} />
        <ProcessTable title={t("login.topMemory")} rows={node.processes?.top_mem ?? []} />
      </div>
    </SectionCard>
  );
}

function ProcessTable({ title, rows }: { title: string; rows: LoginProcess[] }) {
  const t = useT();
  return (
    <div className="min-w-0">
      <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">{title}</div>
      {rows.length === 0 ? (
        <Empty className="py-4">{t("login.nodata")}</Empty>
      ) : (
        <Table className="min-w-[44rem] text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>{t("login.pid")}</TableHead>
              <TableHead>{t("col.user")}</TableHead>
              <TableHead>{t("col.state")}</TableHead>
              <TableHead>{t("dim.cpu")}</TableHead>
              <TableHead>{t("kpi.memory")}</TableHead>
              <TableHead>{t("login.rss")}</TableHead>
              <TableHead>{t("login.elapsed")}</TableHead>
              <TableHead>{t("login.command")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => (
              <TableRow key={`${p.pid}-${p.command}`}>
                <TableCell className="font-mono text-xs">{p.pid}</TableCell>
                <TableCell>{p.user}</TableCell>
                <TableCell>{p.stat}</TableCell>
                <TableCell className="tabular-nums">{p.cpu_pct.toFixed(1)}%</TableCell>
                <TableCell className="tabular-nums">{p.mem_pct.toFixed(1)}%</TableCell>
                <TableCell className="tabular-nums">{fmtBytes(p.rss)}</TableCell>
                <TableCell>{fmtDur(p.elapsed_s)}</TableCell>
                <TableCell className="max-w-[16rem] truncate font-mono text-xs">
                  {p.args || p.command}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function UsersTable({ users }: { users: LoginUser[] }) {
  const t = useT();
  if (!users.length) return <Empty>{t("login.nodata")}</Empty>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("col.user")}</TableHead>
          <TableHead>{t("login.totalCpu")}</TableHead>
          <TableHead>{t("kpi.memory")}</TableHead>
          <TableHead>{t("login.totalRss")}</TableHead>
          <TableHead>{t("login.count")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((u) => (
          <TableRow key={u.user}>
            <TableCell className="font-medium">{u.user}</TableCell>
            <TableCell className="tabular-nums">{u.cpu_pct.toFixed(1)}%</TableCell>
            <TableCell className="tabular-nums">{u.mem_pct.toFixed(1)}%</TableCell>
            <TableCell className="tabular-nums">{fmtBytes(u.rss)}</TableCell>
            <TableCell className="tabular-nums">{u.processes}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function HistoryPanel({
  title,
  points,
  nodeIds,
  field,
  scale = 1,
  formatter,
}: {
  title: string;
  points: LoginHistoryPoint[];
  nodeIds: string[];
  field: "load_per_core" | "mem_used_ratio" | "cpu_iowait";
  scale?: number;
  formatter: (value: number) => string;
}) {
  const t = useT();
  const data = historyRows(points, nodeIds, field, scale);
  return (
    <SectionCard title={title}>
      {data.length === 0 || nodeIds.length === 0 ? (
        <Empty>{t("trend.nodata")}</Empty>
      ) : (
        <AreaChart
          data={data}
          index="time"
          categories={nodeIds}
          colors={colors}
          valueFormatter={formatter}
          startEndOnly
          showAnimation
          yAxisWidth={44}
          className="h-56"
        />
      )}
    </SectionCard>
  );
}

function historyRows(
  points: LoginHistoryPoint[],
  nodeIds: string[],
  field: "load_per_core" | "mem_used_ratio" | "cpu_iowait",
  scale: number,
) {
  const byTs = new Map<number, Record<string, string | number>>();
  for (const p of points) {
    if (!nodeIds.includes(p.node_id)) continue;
    const row =
      byTs.get(p.ts) ??
      ({
        time: new Date(p.ts * 1000).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        }),
      } as Record<string, string | number>);
    row[p.node_id] = Number(((p[field] ?? 0) * scale).toFixed(2));
    byTs.set(p.ts, row);
  }
  return [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
}

function fmtBytes(bytes: number) {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TiB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
  return `${Math.round(bytes / 1024)} KiB`;
}

function fmtMs(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 100) return `${Math.round(value)}ms`;
  return `${value.toFixed(1)}ms`;
}

function fmtQueue(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return value >= 10 ? value.toFixed(0) : value.toFixed(2);
}

function LoadingState() {
  const t = useT();
  return (
    <div className="space-y-4">
      <SectionCard title={t("login.title")}>
        <div className="flex flex-wrap items-center gap-3">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <div>
            <div className="text-sm font-medium">{t("login.loadingTitle")}</div>
            <div className="mt-1 text-xs text-muted-foreground">{t("login.loadingDetail")}</div>
          </div>
        </div>
      </SectionCard>
      <LoadingSkeleton />
    </div>
  );
}

function LoginErrorState({ message }: { message: string }) {
  const t = useT();
  return (
    <div className="space-y-4">
      <SectionCard title={t("login.title")}>
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
          <div>
            <div className="text-sm font-medium text-destructive">{t("login.errorTitle")}</div>
            <div className="mt-1 text-xs text-muted-foreground">{t("login.errorDetail")}</div>
            {message && <div className="mt-2 rounded-md bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">{message}</div>}
          </div>
        </div>
      </SectionCard>
      <LoadingSkeleton />
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-80 rounded-xl" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}
