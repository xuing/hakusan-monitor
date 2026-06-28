import type { ReactNode } from "react";
import { SectionCard } from "@/components/common/section-card";
import { useApi } from "@/hooks/use-api";
import { useT } from "@/i18n";
import { api } from "@/lib/api";

export function ContainersPanel() {
  const { data } = useApi(api.meta, null, 60_000);
  const t = useT();
  const c = data?.container;

  return (
    <SectionCard title={t("section.containers")}>
      <p className="mb-3 text-sm text-muted-foreground">{t("container.lead")}</p>
      {c && (
        <div className="space-y-1.5 text-sm">
          <Row k={t("container.runtime")}>
            <Code>{`${c.runtime} ${c.version}`}</Code>
          </Row>
          <Row k={t("container.module")}>
            <Code>{`module load ${c.compute_module}`}</Code>
          </Row>
        </div>
      )}
      {c && c.examples.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs text-muted-foreground">{t("container.examples")}</div>
          {c.examples.map((ex) => (
            <pre key={ex} className="mb-1.5 overflow-x-auto rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] text-foreground/90">
              {ex}
            </pre>
          ))}
        </div>
      )}
      <div className="mt-3 text-xs text-muted-foreground">{t("container.gotchas")}</div>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        <li>{t("container.g1")}</li>
        <li>{t("container.g2")}</li>
        <li>{t("container.g3")}</li>
      </ul>
    </SectionCard>
  );
}

const Row = ({ k, children }: { k: string; children: ReactNode }) => (
  <div className="flex items-baseline gap-2">
    <span className="min-w-28 text-muted-foreground">{k}</span>
    {children}
  </div>
);
const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">{children}</code>
);
