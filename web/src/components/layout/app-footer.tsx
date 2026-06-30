import { useT } from "@/i18n";

const GITHUB_URL = "https://github.com/xuing/hakusan-monitor";
const HAKUSAN_URL = "https://www.jaist.ac.jp/iscenter/en/mpc/hakusan/";

export function AppFooter() {
  const t = useT();

  return (
    <footer className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-4 text-xs text-muted-foreground">
      <span>{t("footer.disclaimer")}</span>
      <span className="flex items-center gap-3">
        <a className="text-foreground/70 hover:underline" href={GITHUB_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>
        <a className="text-foreground/70 hover:underline" href={HAKUSAN_URL} target="_blank" rel="noreferrer">
          Hakusan
        </a>
      </span>
    </footer>
  );
}
