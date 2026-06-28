import { useApi } from "@/hooks/use-api";
import { useLive } from "@/hooks/use-live";
import { useT } from "@/i18n";
import type { TranslationKey } from "@/i18n/en";
import { api } from "@/lib/api";

export function AppFooter() {
  const { snap } = useLive();
  const { data } = useApi(api.meta, null, 60_000);
  const t = useT();
  const docs = data?.docs?.course_material;

  return (
    <footer className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-4 text-xs text-muted-foreground">
      <span>{t("footer.disclaimer")}</span>
      <span>
        {t("footer.source")}: {snap ? t(`source.${snap.source}` as TranslationKey) : "—"}
        {docs && (
          <>
            {" · "}
            <a className="text-foreground/70 hover:underline" href={docs} target="_blank" rel="noreferrer">
              {t("footer.docs")}
            </a>
          </>
        )}
      </span>
    </footer>
  );
}
