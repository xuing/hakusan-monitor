import { useEffect, useState } from "react";
import { useLive } from "@/hooks/use-live";
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
  const [, tick] = useState(0);

  // re-render every second so "updated …" stays current
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const age = snap ? secondsSince(snap.generated_at) : null;

  return (
    <div className="flex items-center gap-2.5 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1">
        <span className={cn("h-2 w-2 rounded-full", DOT[status], status === "live" && "animate-pulse-dot")} />
        {t(`live.${status}`)}
      </span>
      {age !== null && (
        <span className="hidden sm:inline">
          {t("updated")} {agoText(t, age)}
        </span>
      )}
    </div>
  );
}
