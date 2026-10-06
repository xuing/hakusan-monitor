import { Fragment, useMemo, useState } from "react";
import { Cpu, Gpu } from "lucide-react";
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
      {/* the switch changes every card on a long page: it stays under the top
          bar while scrolling, so the other view is one click from anywhere */}
      <div
        className="sticky z-10 -mx-4 -mt-2 flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/85"
        style={{ top: "var(--topbar-h, 0px)" }}
      >
        <Segmented
          size="lg"
          ariaLabel={t("an.view.label")}
          value={kind}
          // the scroll position stays: both views have the same cards in the
          // same order, so a switch compares the card you are looking at
          onChange={(next) => setParams(next === "gpu" ? {} : { view: next }, { replace: true })}
          options={[
            { value: "gpu", label: <><Gpu aria-hidden className="h-4 w-4" />{t("an.unit.gpu")}</> },
            { value: "cpu", label: <><Cpu aria-hidden className="h-4 w-4" />{t("an.unit.cpu")}</> },
          ]}
        />
        {meta?.historySince && (
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {t("an.source", { since: dayLabel(meta.historySince, true) })}
          </span>
        )}
      </div>
      {/* phones: the source line below the pinned bar, which stays one row */}
      {meta?.historySince && (
        <span className="-mt-2 text-xs text-muted-foreground sm:hidden">
          {t("an.source", { since: dayLabel(meta.historySince, true) })}
        </span>
      )}
      {body}
    </div>
  );
}
