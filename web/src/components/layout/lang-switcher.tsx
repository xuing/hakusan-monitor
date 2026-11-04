import { Languages } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LANG_META, LANGS, useI18n } from "@/i18n";

export function LangSwitcher() {
  const { lang, choice, setLang, t } = useI18n();
  const label = LANG_META[lang].label;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Change language · ${label}`}
          className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Languages className="h-3.5 w-3.5" />
          <span>{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] min-w-40 overflow-y-auto">
        <DropdownMenuCheckboxItem checked={choice === "auto"} onCheckedChange={() => setLang("auto")}>
          {t("lang.auto")}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {LANGS.map((l) => (
          <DropdownMenuCheckboxItem
            key={l}
            lang={LANG_META[l].tag}
            checked={choice === l}
            onCheckedChange={() => setLang(l)}
          >
            {LANG_META[l].label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
