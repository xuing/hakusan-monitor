import { Fragment, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import "@/components/analytics/analytics.css";
import { AnalyticsKpis } from "@/components/analytics/kpis";
import { InteractiveSessions, JobShapes, LimitAccuracy, LimitVsStart } from "@/components/analytics/request-cards";
import { FreeHours, SubmitRhythm } from "@/components/analytics/time-cards";
import {
  ActiveUsers,
  BatchOutcomes,
  RuntimeSplit,
  UsageConcentration,
  WeeklyAllocation,
} from "@/components/analytics/trend-cards";
import { PartitionWaits } from "@/components/analytics/wait-card";
import { ChartPlaceholder } from "@/components/common/chart-placeholder";
import { Empty } from "@/components/common/empty";
import { Segmented } from "@/components/common/segmented";
import { useApi } from "@/hooks/use-api";
import { useT } from "@/i18n";
import { api } from "@/lib/api";
import { dayLabel, unitWord } from "@/lib/analytics-format";
import type { AnalyticsKind, AnalyticsMeta, AnalyticsPayload } from "@/types/analytics";

function metaOf(data: AnalyticsPayload): AnalyticsMeta {
  return {
    windowDays: data.window_days ?? 90,
    partitionUsers: data.thresholds?.partition_users ?? 0,
    cellUsers: data.thresholds?.cell_users ?? 0,
    scheduler: data.priority?.scheduler ?? "",
    fairShare: data.priority?.weights?.FairShare ?? 0,
    outages: data.outages ?? [],
    historySince: data.history_since ?? null,
  };
}

export default function AnalyticsPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const kind: AnalyticsKind = params.get("view") === "cpu" ? "cpu" : "gpu";
  // poll quickly until the first payload is ready, then every 5 minutes
  const [ready, setReady] = useState(false);
  const { data, loading, error } = useApi(
    () => api.analytics().then((d) => { setReady(d.status === "ready"); return d; }),
    null,
    ready ? 5 * 60_000 : 15_000,
  );
  const meta = useMemo(() => (data ? metaOf(data) : null), [data]);
  const view = data?.status === "ready" ? data[kind] : undefined;

  let body;
  if (!data && loading) {
    body = (
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartPlaceholder className="h-80" />
        <ChartPlaceholder className="h-80" />
      </div>
    );
  } else if (!data) {
    body = <Empty>{error ? t("common.fetchError") : t("an.waiting")}</Empty>;
  } else if (data.status !== "ready" || !view || !meta) {
    body = (
      <Empty>
        {data.status === "unavailable"
          ? t("an.unavailable")
          : data.status === "backfilling" && data.progress
            ? t("an.collecting", { date: dayLabel(data.progress.to, true) })
            : t("an.waiting")}
      </Empty>
    );
  } else if (!view.users) {
    body = <Empty>{t("an.noJobs", { unit: unitWord(t, view), n: meta.windowDays })}</Empty>;
  } else {
    body = (
      // keyed by view: switching GPU/CPU remounts the cards, so no hover or
      // selection state from one view can point into the other's data
      <Fragment key={kind}>
        <AnalyticsKpis view={view} meta={meta} />
        <div className="grid gap-4 xl:grid-cols-2">
          <SubmitRhythm view={view} meta={meta} />
          <FreeHours view={view} />
        </div>
        <PartitionWaits view={view} meta={meta} />
        <div className="grid gap-4 xl:grid-cols-2">
          <LimitAccuracy view={view} />
          <LimitVsStart view={view} meta={meta} />
        </div>
        <div className="grid gap-4 lg:grid-cols-2 min-[1360px]:grid-cols-3">
          <JobShapes view={view} meta={meta} />
          <InteractiveSessions view={view} meta={meta} />
          <div className="lg:col-span-2 min-[1360px]:col-span-1">
            <RuntimeSplit view={view} meta={meta} />
          </div>
        </div>
        <div className="grid gap-4 xl:grid-cols-3">
          <WeeklyAllocation className="xl:col-span-2" view={view} meta={meta} />
          <UsageConcentration view={view} meta={meta} />
        </div>
        <div className="grid gap-4 xl:grid-cols-3">
          <ActiveUsers className="xl:col-span-2" view={view} meta={meta} />
          <BatchOutcomes view={view} meta={meta} />
        </div>
      </Fragment>
    );
  }

  return (
    <div className="analytics-root grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          ariaLabel={t("an.view.label")}
          value={kind}
          onChange={(next) => setParams(next === "gpu" ? {} : { view: next }, { replace: true })}
          options={[
            { value: "gpu", label: t("an.unit.gpu") },
            { value: "cpu", label: t("an.unit.cpu") },
          ]}
        />
        {meta?.historySince && (
          <span className="text-xs text-muted-foreground">
            {t("an.source", { since: dayLabel(meta.historySince, true) })}
          </span>
        )}
      </div>
      {body}
    </div>
  );
}
