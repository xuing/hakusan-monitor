import { useT } from "@/i18n";
import { getSite } from "@/lib/site";

const GITHUB_URL = "https://github.com/xuing/hakusan-monitor";

export function AppFooter() {
  const t = useT();
  const site = getSite();

  return (
    <footer className="mx-auto flex w-full max-w-[1920px] flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-4 text-xs text-muted-foreground">
      <span>{site.org ? t("footer.disclaimer") : ""}</span>
      <span className="flex items-center gap-3">
        <a className="text-foreground/70 hover:underline" href={GITHUB_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>
        {site.links.home && (
          <a className="text-foreground/70 hover:underline" href={site.links.home} target="_blank" rel="noreferrer">
            {site.name}
          </a>
        )}
      </span>
    </footer>
  );
}
