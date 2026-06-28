import { Empty } from "@/components/common/empty";
import { SectionCard } from "@/components/common/section-card";
import { useApi } from "@/hooks/use-api";
import { useT, type TFn } from "@/i18n";
import type { TranslationKey } from "@/i18n/en";
import { api } from "@/lib/api";
import { pct } from "@/lib/format";
import { heatColor } from "@/lib/slurm";
import type { UsageCell, UsageHour } from "@/types/snapshot";

const DAYS = 30;
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon … Sun

export function UsagePanel() {
  const t = useT();
  const { data } = useApi(() => api.usage(DAYS), DAYS, 5 * 60_000);

  return (
    <SectionCard title={t("section.usage")} extra={t("usage.lead", { n: DAYS })}>
      {!data || data.total_hours === 0 ? (
        <Empty>{t("usage.nodata")}</Empty>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap gap-3">
            <PeakStat label={t("usage.busiest")} hour={data.busiest_hour} tone="text-bad-fg" t={t} />
            <PeakStat label={t("usage.quietest")} hour={data.quietest_hour} tone="text-ok-fg" t={t} />
          </div>

          <h3 className="mb-2 text-xs text-muted-foreground">
            {t("usage.byhour")} · {t("usage.gpu")}
          </h3>
          <ByHour data={data.by_hour} />

          <h3 className="mb-2 mt-6 text-xs text-muted-foreground">{t("usage.heatmap")}</h3>
          <Heatmap cells={data.heatmap} t={t} />

          <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
            {t("usage.quietest")}
            <div className="flex gap-0.5">
              {[0, 0.25, 0.5, 0.75, 1].map((v) => (
                <span key={v} className="h-2.5 w-4 rounded-sm" style={{ background: heatColor(v) }} />
              ))}
            </div>
            {t("usage.busiest")}
          </div>
        </>
      )}
    </SectionCard>
  );
}

function PeakStat({ label, hour, tone, t }: { label: string; hour: UsageHour | null; tone: string; t: TFn }) {
  return (
    <div className="rounded-lg border border-border bg-muted/40 px-4 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 font-mono text-base ${tone}`}>
        {hour ? `${String(hour.hour).padStart(2, "0")}:00 · ${t("usage.gpu")} ${pct(hour.gpu)}` : "—"}
      </div>
    </div>
  );
}

function ByHour({ data }: { data: UsageHour[] }) {
  const max = Math.max(0.01, ...data.map((d) => d.gpu));
  return (
    <div>
      <div className="grid h-24 items-end gap-1" style={{ gridTemplateColumns: "repeat(24,1fr)" }}>
        {data.map((h) => (
          <div
            key={h.hour}
            title={`${h.hour}:00 · GPU ${pct(h.gpu)}`}
            className="rounded-sm"
            style={{ height: `${Math.max(4, (h.gpu / max) * 100)}%`, background: heatColor(h.gpu) }}
          />
        ))}
      </div>
      <div className="mt-1 grid gap-1 text-[9px] text-muted-foreground" style={{ gridTemplateColumns: "repeat(24,1fr)" }}>
        {data.map((h) => (
          <span key={h.hour} className="text-center">
            {h.hour % 3 === 0 ? h.hour : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

function Heatmap({ cells, t }: { cells: UsageCell[]; t: TFn }) {
  const grid = new Map<string, number>();
  for (const c of cells) grid.set(`${c.weekday}-${c.hour}`, c.gpu);
  const cols = "2rem repeat(24, minmax(14px, 1fr))";

  return (
    <div className="space-y-1 overflow-x-auto">
      {WEEK_ORDER.map((d) => (
        <div key={d} className="grid items-center gap-1" style={{ gridTemplateColumns: cols }}>
          <span className="text-[11px] text-muted-foreground">{t(`weekday.${d}` as TranslationKey)}</span>
          {Array.from({ length: 24 }, (_, h) => {
            const v = grid.get(`${d}-${h}`);
            return (
              <div
                key={h}
                title={v != null ? `${t(`weekday.${d}` as TranslationKey)} ${h}:00 · ${pct(v)}` : ""}
                className="aspect-square rounded-sm"
                style={{ background: v != null ? heatColor(v) : "hsl(var(--muted))" }}
              />
            );
          })}
        </div>
      ))}
      <div className="grid gap-1 text-[9px] text-muted-foreground" style={{ gridTemplateColumns: cols }}>
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
