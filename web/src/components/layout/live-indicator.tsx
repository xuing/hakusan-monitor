import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { useLive } from "@/hooks/live-context";
import { api } from "@/lib/api";
import { useT, type TFn } from "@/i18n";
import type { LiveStatus } from "@/lib/live";
import { secondsSince } from "@/lib/format";
import { cn } from "@/lib/utils";

const DOT: Record<LiveStatus, string> = {
  live: "bg-ok",
  polling: "bg-info",
  reconnecting: "bg-warn",
  offline: "bg-bad",
};

function agoText(t: TFn, sec: number): string {
  if (sec < 5) return t("ago.now");
  if (sec < 60) return t("ago.sec", { n: Math.round(sec) });
  if (sec < 3600) return t("ago.min", { n: Math.round(sec / 60) });
  return t("ago.hour", { n: Math.round(sec / 3600) });
}

export function LiveIndicator() {
  const { status, snap } = useLive();
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  // "refresh now": when the click was (until the new sample arrives), and
  // until when the server said to wait
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [blockedUntil, setBlockedUntil] = useState(0);

  // re-render every second so "updated …" and the refresh cooldown stay current
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // pending until a sample that started after the click arrives (2 min at most)
  const pending = pendingSince !== null
    && !(snap && snap.generated_at >= Math.floor(pendingSince / 1000))
    && now - pendingSince < 120_000;
  // +1 s: generated_at is whole seconds, the server times the gap exactly
  const minGap = (snap?.refresh_min_interval ?? 15) + 1;
  const wait = snap
    ? Math.ceil(Math.max(0, minGap - (now / 1000 - snap.generated_at), (blockedUntil - now) / 1000))
    : 0;
  const refresh = async () => {
    setPendingSince(Date.now());
    try {
      const r = await api.refresh();
      if (!r.accepted && !r.queued) {
        setPendingSince(null);
        setBlockedUntil(Date.now() + r.retry_after * 1000);
      }
    } catch {
      setPendingSince(null);
    }
  };
  const refreshLabel = pending ? t("live.refreshing") : wait > 0 ? t("live.refreshWait", { n: wait }) : t("live.refresh");

  const age = snap ? secondsSince(snap.generated_at) : null;
  const stale = Boolean(snap?.stale || snap?.error);
  const label = stale ? t("live.stale") : t(`live.${status}`);
  const dot = stale ? "bg-warn" : DOT[status];
  const updated = stale ? t("live.staleUpdated") : t("updated");

  return (
    <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1",
          stale && "border-warn/35 bg-warn-soft text-warn-fg",
        )}
        title={stale ? snap?.error : undefined}
      >
        <span className={cn("h-2 w-2 rounded-full", dot, status === "live" && !stale && "animate-pulse-dot")} />
        {label}
      </span>
      {age !== null && (
        // data age is the key trust signal on a 300s-sampling dashboard — keep
        // it visible on phones too (it's short enough to fit)
        <span className={cn("whitespace-nowrap", stale && "text-warn-fg")}>
          {/* phones: the age alone, so it stays on one line beside the refresh button */}
          <span className="hidden sm:inline">{updated} </span>{agoText(t, age)}
          {stale && (snap?.fail_count ?? 0) > 0 && <> · {t("live.retryCount", { n: snap!.fail_count! })}</>}
        </span>
      )}
      {snap && (
        <button
          type="button"
          onClick={refresh}
          disabled={pending || wait > 0}
          title={refreshLabel}
          aria-label={refreshLabel}
          className="-ml-1 rounded-full p-1 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:text-muted-foreground"
        >
          <RotateCw aria-hidden className={cn("h-3.5 w-3.5", pending && "animate-spin")} />
        </button>
      )}
    </div>
  );
}
