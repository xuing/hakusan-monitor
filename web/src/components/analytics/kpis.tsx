import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { poolLabel, useT } from "@/i18n";
import { pctText, poolColor, unitWord } from "@/lib/analytics-format";
import { nf } from "@/lib/format";
import type { AnalyticsMeta, AnalyticsView } from "@/types/analytics";
import { Dot } from "./parts";

/** The four headline numbers, each the summary of a card below. */
export function AnalyticsKpis({ view, meta }: { view: AnalyticsView; meta: AnalyticsMeta }) {
  const t = useT();
  const unit = unitWord(t, view);
  const util = view.weekly.util13;
  const daily = (n: number | null) => (n == null ? "—" : nf(Math.round(n)));
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Kpi label={t("an.kpi.util", { unit, n: util.weeks })} value={pctText(util.all)}>
        <span className="flex flex-wrap gap-x-3 gap-y-0.5">
          {view.pools.map((p, i) => util.pools[p.id] != null && (
            <span key={p.id} className="inline-flex items-center gap-1.5">
              <Dot color={poolColor(i)} />
              {poolLabel(t, p.id)} {pctText(util.pools[p.id])}
            </span>
          ))}
        </span>
      </Kpi>
      <Kpi label={t("an.kpi.start")} value={pctText(view.waits.start_1m)}>
        {t("an.kpi.startSub", { unit, p: pctText(view.waits.start_1d) })}
      </Kpi>
      <Kpi label={t("an.kpi.used")} value={pctText(view.limits.median)}>
        {t("an.kpi.usedSub", { p: pctText(view.limits.at_max) })}
      </Kpi>
      <Kpi label={t("an.kpi.users", { unit, n: meta.windowDays })} value={nf(view.users)}>
        {t("an.kpi.usersSub", { a: daily(view.submit.daily_weekday), b: daily(view.submit.daily_weekend) })}
      </Kpi>
    </div>
  );
}

function Kpi({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold leading-tight">{value}</div>
        <div className="mt-2 text-xs text-muted-foreground">{children}</div>
      </CardContent>
    </Card>
  );
}
