import { Languages } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LANGS, useI18n } from "@/i18n";
import type { Lang } from "@/i18n";

const LABELS: Record<Lang, string> = {
  ja: "日本語",
  en: "English",
  zh: "中文",
};

export function LangSwitcher() {
  const { lang, setLang } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Change language"
          className="flex h-8 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Languages className="h-3.5 w-3.5" />
          <span>{LABELS[lang]}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-32">
        {LANGS.map((l) => (
          <DropdownMenuCheckboxItem
            key={l}
            checked={lang === l}
            onCheckedChange={() => setLang(l)}
          >
            {LABELS[l]}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
