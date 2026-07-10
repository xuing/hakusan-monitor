import { AlertTriangle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/common/section-card";
import { useLive } from "@/hooks/live-context";
import { useT } from "@/i18n";

export function LivePending({ fallback }: { fallback: ReactNode }) {
  const { status, error, retry } = useLive();
  const t = useT();
  if (status !== "offline") return <>{fallback}</>;
  return (
    <SectionCard>
      <div className="flex min-h-52 flex-col items-center justify-center gap-3 px-4 text-center">
        <span className="grid h-11 w-11 place-items-center rounded-full bg-warn-soft text-warn-fg">
          <AlertTriangle className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-base font-semibold text-foreground">{t("live.unavailable.title")}</h2>
          <p className="mt-1 max-w-lg text-sm text-muted-foreground">{t("live.unavailable.detail")}</p>
          {error && <p className="mt-1 font-mono text-xs text-muted-foreground">{error.message}</p>}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={retry}>
          <RefreshCw className="h-3.5 w-3.5" />
          {t("live.retry")}
        </Button>
      </div>
    </SectionCard>
  );
}
