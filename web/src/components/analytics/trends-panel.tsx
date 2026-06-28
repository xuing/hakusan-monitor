import { AreaChart } from "@tremor/react";
import { Empty } from "@/components/common/empty";
import { SectionCard } from "@/components/common/section-card";
import { useApi } from "@/hooks/use-api";
import { useT } from "@/i18n";
import { api } from "@/lib/api";

const HOURS = 24;

export function TrendsPanel() {
  const t = useT();
  const { data } = useApi(() => api.history(HOURS), HOURS, 60_000);
  const points = data?.points ?? [];

  const fmtTime = (ts: number) =>
    new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  const utilData = points.map((p) => ({
    time: fmtTime(p.ts),
    [t("trend.cpu")]: Math.round(p.cpu_util * 100),
    [t("trend.gpu")]: Math.round(p.gpu_util * 100),
  }));
  const pendData = points.map((p) => ({ time: fmtTime(p.ts), [t("trend.pending")]: p.pending }));

  return (
    <SectionCard title={t("section.trend")}>
      {points.length === 0 ? (
        <Empty>{t("trend.nodata")}</Empty>
      ) : (
        <div className="space-y-6">
          <AreaChart
            data={utilData}
            index="time"
            categories={[t("trend.cpu"), t("trend.gpu")]}
            colors={["blue", "violet"]}
            valueFormatter={(v) => `${v}%`}
            startEndOnly
            showAnimation
            yAxisWidth={42}
            className="h-52"
          />
          <AreaChart
            data={pendData}
            index="time"
            categories={[t("trend.pending")]}
            colors={["amber"]}
            startEndOnly
            showAnimation
            showLegend={false}
            yAxisWidth={42}
            className="h-44"
          />
        </div>
      )}
    </SectionCard>
  );
}
