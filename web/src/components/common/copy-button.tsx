import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useT } from "@/i18n";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/** copied-state with the standard 1.2s reset. */
export function useCopied(): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };
  return [copied, copy];
}

/** The one copy affordance: icon-only by default, `label` adds the text. */
export function CopyButton({ text, label, className }: { text: string; label?: boolean; className?: string }) {
  const t = useT();
  const [copied, copy] = useCopied();
  const Icon = copied ? Check : Copy;
  const title = t(copied ? "helper.copied" : "helper.copy");
  return (
    <button
      type="button"
      onClick={() => void copy(text)}
      title={title}
      aria-label={title}
      className={cn(
        label
          ? "inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          : "shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      <Icon className={label ? "h-3 w-3" : "h-3.5 w-3.5"} />
      {label ? title : null}
    </button>
  );
}
