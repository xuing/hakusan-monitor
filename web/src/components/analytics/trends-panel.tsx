import { AreaChart } from "@tremor/react";
import { ChartPlaceholder } from "@/components/common/chart-placeholder";
import { Empty } from "@/components/common/empty";
import { SectionCard } from "@/components/common/section-card";
import { useApi } from "@/hooks/use-api";
import { useT } from "@/i18n";
import { api } from "@/lib/api";
import { CLUSTER_TIME_ZONE } from "@/lib/format";

const HOURS = 24;

export function TrendsPanel() {
  const t = useT();
  const { data, loading, error } = useApi(() => api.history(HOURS), HOURS, 60_000);
  const points = data?.points ?? [];

  const fmtTime = (ts: number) =>
    new Date(ts * 1000).toLocaleTimeString(undefined, {
      timeZone: CLUSTER_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
    });

  const utilData = points.map((p) => ({
    time: fmtTime(p.ts),
    [t("trend.cpuAlloc")]: Math.round(p.cpu_util * 100),
    [t("trend.gpuAlloc")]: Math.round(p.gpu_util * 100),
  }));
  const pendData = points.map((p) => ({ time: fmtTime(p.ts), [t("trend.pending")]: p.pending }));

  return (
    <SectionCard title={t("section.trend")} extra={t("trend.scope")}>
      {!data && loading ? (
        <ChartPlaceholder className="h-52" />
      ) : !data && error ? (
        <Empty>{t("common.fetchError")}</Empty>
      ) : points.length === 0 ? (
        <Empty>{t("trend.nodata")}</Empty>
      ) : (
        <div className="space-y-6">
          <AreaChart
            data={utilData}
            index="time"
            categories={[t("trend.cpuAlloc"), t("trend.gpuAlloc")]}
            colors={["blue", "violet"]}
            valueFormatter={(v) => `${v}%`}
            startEndOnly
            yAxisWidth={42}
            className="h-52"
          />
          <AreaChart
            data={pendData}
            index="time"
            categories={[t("trend.pending")]}
            colors={["amber"]}
            startEndOnly
            showLegend={false}
            yAxisWidth={42}
            className="h-44"
          />
        </div>
      )}
    </SectionCard>
  );
}
