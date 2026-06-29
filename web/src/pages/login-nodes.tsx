import { AreaChart } from "@tremor/react";
import { AlertTriangle, Cpu, HardDrive, Loader2, MemoryStick, Server } from "lucide-react";
import type { ReactNode } from "react";
import { Empty } from "@/components/common/empty";
import { Bar } from "@/components/common/bar";
import { SectionCard } from "@/components/common/section-card";
import { Badge } from "@/components/ui/badge";
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
import type { TranslationKey } from "@/i18n";
import { api } from "@/lib/api";
import { fmtDur, pct } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  LoginHistoryPoint,
  LoginNode,
  LoginProcess,
  LoginUser,
  PressureLevel,
} from "@/types/snapshot";

const HOURS = 24;
const POLL_MS = 60_000;

const levelClass: Record<PressureLevel, string> = {
  low: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  moderate: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  high: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  critical: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
};

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

          <div className="grid gap-4 xl:grid-cols-2">
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
  const pressure = node.pressure ?? { level: "low" as PressureLevel, score: 0, reasons: [] };
  const mem = node.memory;
  const disks = [...(node.disks ?? [])].sort((a, b) => b.use_pct - a.use_pct);
  const busy = node.cpu?.busy;
  const cpuIowait = node.cpu?.iowait;
  const ioIowait = node.io?.iowait_pct == null ? cpuIowait : node.io.iowait_pct / 100;
  const dState = node.processes?.d_state ?? 0;
  const ioUtil = node.io?.max_util_pct == null ? null : node.io.max_util_pct / 100;
  const ioAwait = node.io?.max_await_ms ?? null;
  const advisoryUtil = ioUtil == null ? 0 : Math.min(ioUtil, 0.5);
  const diskPressure = Math.max(ioIowait ?? 0, advisoryUtil, Math.min(dState / 10, 1));
  const ioDetail = node.io?.devices?.length
    ? `${t("login.ioUtil")} ${ioUtil == null ? "—" : pct(ioUtil)} · ${t("login.ioAwait")} ${fmtMs(ioAwait)}`
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
      extra={
        <Badge variant="outline" className={cn("capitalize", levelClass[pressure.level])}>
          {t(`level.${pressure.level}` as TranslationKey)}
        </Badge>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Metric
            icon={<Cpu className="h-4 w-4" />}
            label={t("login.loadCore")}
            value={(node.load?.per_core ?? 0).toFixed(2)}
            detail={`${t("login.load1")} ${(node.load?.["1m"] ?? 0).toFixed(2)} · ${node.cores ?? 0} ${t("kpi.cores")}`}
            bar={Math.min((node.load?.per_core ?? 0) / 2, 1)}
          />
          <Metric
            icon={<Cpu className="h-4 w-4" />}
            label={t("login.cpuBusy")}
            value={busy == null ? "—" : pct(busy)}
            detail={`${t("login.iowait")} ${cpuIowait == null ? "—" : pct(cpuIowait)}`}
            bar={busy ?? 0}
          />
          <Metric
            icon={<MemoryStick className="h-4 w-4" />}
            label={t("kpi.memory")}
            value={pct(mem?.used_ratio)}
            detail={`${fmtBytes(mem?.available ?? 0)} ${t("kpi.free")} · ${t("login.swap")} ${pct(mem?.swap_ratio)}`}
            bar={mem?.used_ratio ?? 0}
          />
          <Metric
            icon={<HardDrive className="h-4 w-4" />}
            label={t("login.diskPressure")}
            value={ioIowait == null ? "—" : pct(ioIowait)}
            detail={ioDetail}
            bar={diskPressure}
          />
        </div>

        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">{t("login.diskSpaceRef")}</div>
          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("login.mount")}</TableHead>
                  <TableHead>{t("login.used")}</TableHead>
                  <TableHead>{t("login.available")}</TableHead>
                  <TableHead>{t("login.filesystem")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {disks.slice(0, 4).map((d) => (
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
          <div className="text-[11px] text-muted-foreground">{t("login.diskScope")}</div>
        </div>

        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">{t("login.reasons")}</div>
          {pressure.reasons.length ? (
            <div className="flex flex-wrap gap-2">
              {pressure.reasons.map((reason) => (
                <Badge key={reason} variant="secondary" className="font-normal">
                  {reason}
                </Badge>
              ))}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">{t("login.noPressure")}</div>
          )}
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
  bar,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  bar: number;
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
      <Bar value={bar} className="mt-3" />
      <div className="mt-2 truncate text-xs text-muted-foreground">{detail}</div>
    </div>
  );
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
  field: "load_per_core" | "mem_used_ratio";
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
  field: "load_per_core" | "mem_used_ratio",
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
