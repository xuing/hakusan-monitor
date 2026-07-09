import { useMemo, useState } from "react";
import { ChartPlaceholder } from "@/components/common/chart-placeholder";
import { Empty } from "@/components/common/empty";
import { HoverHint } from "@/components/common/hover-hint";
import { SectionCard } from "@/components/common/section-card";
import { useApi } from "@/hooks/use-api";
import { useT, type TFn } from "@/i18n";
import type { TranslationKey } from "@/i18n/en";
import { api } from "@/lib/api";
import { CLUSTER_TIME_ZONE, pct } from "@/lib/format";
import { heatColor } from "@/lib/slurm";
import { cn } from "@/lib/utils";
import type { UsageCell, UsageHour } from "@/types/snapshot";

const DAYS = 30;
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon … Sun
const LOW_SAMPLE_COUNT = 3;

type UsageMetric = "gpu" | "cpu" | "pending";

const METRICS: UsageMetric[] = ["gpu", "cpu", "pending"];

export function UsagePanel() {
  const t = useT();
  const [metric, setMetric] = useState<UsageMetric>("gpu");
  const { data, loading, error } = useApi(() => api.usage(DAYS), DAYS, 5 * 60_000);

  const stats = useMemo(() => {
    const rows = data?.by_hour.filter((h) => h.samples > 0) ?? [];
    const ranked = rows.length ? rows : [];
    return {
      high: ranked.reduce<UsageHour | null>((best, row) => (
        !best || metricValue(row, metric) > metricValue(best, metric) ? row : best
      ), null),
      low: ranked.reduce<UsageHour | null>((best, row) => (
        !best || metricValue(row, metric) < metricValue(best, metric) ? row : best
      ), null),
    };
  }, [data?.by_hour, metric]);

  const maxPending = Math.max(1, ...(data?.by_hour ?? []).map((h) => h.pending));
  const hasSparseData = Boolean(data && data.total_hours < 24);

  return (
    <SectionCard
      title={
        <span>
          {t("section.usage")}
          <HoverHint text={t("usage.scope")} className="ml-0.5" />
        </span>
      }
      extra={data ? coverageText(data, t) : t("usage.lead", { n: DAYS })}
    >
      {!data && loading ? (
        <ChartPlaceholder className="h-64" />
      ) : !data && error ? (
        <Empty>{t("common.fetchError")}</Empty>
      ) : !data || data.total_hours === 0 ? (
        <Empty>{t("usage.nodata")}</Empty>
      ) : (
        <div className="space-y-4">
          {hasSparseData && <div className="text-xs text-warn-fg">{t("usage.lowConfidence")}</div>}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex rounded-md border border-border bg-background p-0.5">
              {METRICS.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setMetric(item)}
                  className={cn(
                    "rounded-[4px] px-2.5 py-1 text-xs transition-colors",
                    metric === item
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {metricLabel(item, t)}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">{dateRangeText(data.since, data.until, data.timezone)}</span>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <PeakStat label={t("usage.busiest")} hour={stats.high} metric={metric} tone="text-bad-fg" t={t} />
            <PeakStat label={t("usage.quietest")} hour={stats.low} metric={metric} tone="text-ok-fg" t={t} />
          </div>

          <div>
            <h3 className="mb-2 text-xs text-muted-foreground">
              {t("usage.byhour")} · {metricLabel(metric, t)}
            </h3>
            <ByHour data={data.by_hour} metric={metric} maxPending={maxPending} t={t} />
          </div>

          <div>
            <h3 className="mb-2 text-xs text-muted-foreground">
              {t("usage.heatmap", { metric: metricLabel(metric, t) })}
            </h3>
            <Heatmap cells={data.heatmap} metric={metric} maxPending={maxPending} t={t} />
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {t("usage.quietest")}
            <div className="flex gap-0.5">
              {[0, 0.25, 0.5, 0.75, 1].map((v) => (
                <span key={v} className="h-2.5 w-4 rounded-sm" style={{ background: heatColor(v) }} />
              ))}
            </div>
            {t("usage.busiest")}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function PeakStat({
  label,
  hour,
  metric,
  tone,
  t,
}: {
  label: string;
  hour: UsageHour | null;
  metric: UsageMetric;
  tone: string;
  t: TFn;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/35 px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 font-mono text-base ${tone}`}>
        {hour ? `${String(hour.hour).padStart(2, "0")}:00 · ${formatMetric(metricValue(hour, metric), metric)}` : "—"}
      </div>
      {hour && <div className="mt-0.5 text-xs text-muted-foreground">{t("usage.samples", { n: hour.samples })}</div>}
    </div>
  );
}

function ByHour({
  data,
  metric,
  maxPending,
  t,
}: {
  data: UsageHour[];
  metric: UsageMetric;
  maxPending: number;
  t: TFn;
}) {
  const sampledLevels = data.filter((h) => h.samples > 0).map((h) => metricLevel(metricValue(h, metric), metric, maxPending));
  const minLevel = Math.min(...sampledLevels);
  const maxLevel = Math.max(...sampledLevels);
  return (
    <div>
      <div className="grid h-24 items-end gap-1" style={{ gridTemplateColumns: "repeat(24,1fr)" }}>
        {data.map((h) => {
          const value = metricValue(h, metric);
          const level = metricLevel(value, metric, maxPending);
          const height = h.samples ? barHeight(level, minLevel, maxLevel) : 0;
          return (
            <div
              key={h.hour}
              title={tooltip(`${h.hour}:00`, value, metric, h.samples, t)}
              className={cn("rounded-sm", h.samples > 0 && h.samples < LOW_SAMPLE_COUNT && "opacity-45")}
              style={{ height: `${height}%`, background: h.samples ? heatColor(level) : "hsl(var(--muted))" }}
            />
          );
        })}
      </div>
      <div className="mt-1 grid gap-1 text-xs text-muted-foreground" style={{ gridTemplateColumns: "repeat(24,1fr)" }}>
        {data.map((h) => (
          <span key={h.hour} className="text-center">
            {h.hour % 3 === 0 ? h.hour : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

function barHeight(level: number, minLevel: number, maxLevel: number) {
  const spread = maxLevel - minLevel;
  if (!Number.isFinite(spread) || spread < 0.03) return Math.max(4, level * 100);
  return 18 + ((level - minLevel) / spread) * 82;
}

function Heatmap({
  cells,
  metric,
  maxPending,
  t,
}: {
  cells: UsageCell[];
  metric: UsageMetric;
  maxPending: number;
  t: TFn;
}) {
  const grid = new Map<string, UsageCell>();
  for (const c of cells) grid.set(`${c.weekday}-${c.hour}`, c);
  const cols = "2rem repeat(24, minmax(14px, 1fr))";

  return (
    <div className="space-y-1 overflow-x-auto">
      {WEEK_ORDER.map((d) => (
        <div key={d} className="grid items-center gap-1" style={{ gridTemplateColumns: cols }}>
          <span className="text-xs text-muted-foreground">{t(`weekday.${d}` as TranslationKey)}</span>
          {Array.from({ length: 24 }, (_, h) => {
            const cell = grid.get(`${d}-${h}`);
            const value = cell ? metricValue(cell, metric) : 0;
            const level = metricLevel(value, metric, maxPending);
            return (
              <div
                key={h}
                title={cell ? tooltip(`${t(`weekday.${d}` as TranslationKey)} ${h}:00`, value, metric, cell.samples, t) : ""}
                className={cn("aspect-square rounded-sm", cell && cell.samples < LOW_SAMPLE_COUNT && "opacity-45")}
                style={{ background: cell ? heatColor(level) : "hsl(var(--muted))" }}
              />
            );
          })}
        </div>
      ))}
      <div className="grid gap-1 text-xs text-muted-foreground" style={{ gridTemplateColumns: cols }}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="text-center">
            {h % 3 === 0 ? h : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

function metricValue(row: UsageHour | UsageCell, metric: UsageMetric) {
  return metric === "pending" ? row.pending : metric === "cpu" ? row.cpu : row.gpu;
}

function metricLevel(value: number, metric: UsageMetric, maxPending: number) {
  if (metric === "pending") return Math.max(0, Math.min(1, value / maxPending));
  return Math.max(0, Math.min(1, value));
}

function metricLabel(metric: UsageMetric, t: TFn) {
  if (metric === "cpu") return t("usage.cpuAlloc");
  if (metric === "pending") return t("usage.pending");
  return t("usage.gpuAlloc");
}

function formatMetric(value: number, metric: UsageMetric) {
  return metric === "pending" ? value.toFixed(1) : pct(value);
}

function tooltip(prefix: string, value: number, metric: UsageMetric, samples: number, t: TFn) {
  const low = samples > 0 && samples < LOW_SAMPLE_COUNT ? ` · ${t("usage.lowSample")}` : "";
  return `${prefix} · ${formatMetric(value, metric)} · ${t("usage.samples", { n: samples })}${low}`;
}

function coverageText(data: { days: number; total_hours: number; total_samples: number }, t: TFn) {
  return t("usage.coverage", {
    n: data.days,
    hours: data.total_hours,
    samples: data.total_samples,
  });
}

function dateRangeText(since: number, until: number, timezone?: string) {
  // hour buckets are computed in the backend's zone — label with what it reports
  const tzLabel = timezone && timezone !== "localtime" ? timezone : CLUSTER_TIME_ZONE;
  if (!since || !until) return tzLabel;
  const fmt = (ts: number) =>
    new Date(ts * 1000).toLocaleString(undefined, {
      timeZone: CLUSTER_TIME_ZONE,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  return `${fmt(since)} - ${fmt(until)} · ${tzLabel}`;
}
