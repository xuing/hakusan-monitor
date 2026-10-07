// The guide pages' shared building blocks: a SectionCard with a deep-link
// anchor, a terminal-styled command block, a tinted note, inline `code` in
// running text and a collapsed card. Used by the Slurm guide and Getting started.
import type { ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { CopyButton } from "@/components/common/copy-button";
import type { Tone } from "@/lib/slurm";
import { cn } from "@/lib/utils";

/** A guide section in the dashboard's shared SectionCard look; `id` is the
 *  deep-link anchor. */
export function Section({ id, className, title, lead, extra, children }: {
  id: string;
  className?: string;
  title: string;
  lead?: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div id={id} className={cn("min-w-0 scroll-mt-16", className)}>
      <SectionCard title={title} extra={extra}>
        {lead && <p className="mb-3 text-sm leading-relaxed text-muted-foreground">{lead}</p>}
        {children}
      </SectionCard>
    </div>
  );
}

/** Code block — muted in light theme, terminal-dark in dark theme:
 *  `lines` get a $ prompt each; `file` shows a script with its
 *  name in a title bar instead. */
export function Terminal({ lines, output, file, text, className, wrap }: {
  lines?: string[];
  output?: string;
  file?: string;
  text?: string;
  className?: string;
  /** wrap a long command instead of scrolling it (a one-liner the reader must see whole) */
  wrap?: boolean;
}) {
  const copyText = file ? (text ?? "") : (lines ?? []).join("\n");
  if (file) {
    return (
      <div className={cn("min-w-0 overflow-hidden rounded-lg border border-border bg-muted/40 dark:border-zinc-800 dark:bg-zinc-950", className)}>
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5 dark:border-zinc-800">
          <span className="font-mono text-xs text-muted-foreground dark:text-zinc-400">{file}</span>
          <CopyButton text={copyText} label className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100" />
        </div>
        <pre className="overflow-x-auto px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground dark:text-zinc-100">
          {(text ?? "").split("\n").map((line, i) => (
            <div key={i} className={cn(line.startsWith("#SBATCH") ? "text-sky-700 dark:text-sky-300" : line.startsWith("#") ? "text-muted-foreground dark:text-zinc-500" : undefined)}>
              {line || " "}
            </div>
          ))}
        </pre>
      </div>
    );
  }
  return (
    <div className={cn("flex min-w-0 items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950", className)}>
      <pre className={cn("min-w-0 flex-1 font-mono text-xs leading-relaxed text-foreground dark:text-zinc-100", wrap ? "whitespace-pre-wrap break-all" : "overflow-x-auto")}>
        {(lines ?? []).map((line, i) => (
          <div key={i}>
            <span aria-hidden className="select-none text-muted-foreground dark:text-zinc-500">$ </span>
            {line}
          </div>
        ))}
        {output && <div className="text-muted-foreground dark:text-zinc-500">{output}</div>}
      </pre>
      <CopyButton text={copyText} label className="pt-0.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100" />
    </div>
  );
}

const NOTE_BOX: Record<Tone, string> = {
  ok: "border-ok/35 bg-ok-soft/45",
  warn: "border-warn/40 bg-warn-soft/50",
  bad: "border-bad/35 bg-bad-soft/45",
  info: "border-info/35 bg-info-soft/45",
  neutral: "border-border bg-muted/30",
};
const NOTE_ICON: Record<Tone, string> = {
  ok: "text-ok-fg",
  warn: "text-warn-fg",
  bad: "text-bad-fg",
  info: "text-info-fg",
  neutral: "text-muted-foreground",
};

export function Note({ tone, icon: Icon, children }: { tone: Tone; icon: LucideIcon; children: ReactNode }) {
  return (
    <div className={cn("flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm leading-relaxed", NOTE_BOX[tone])}>
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", NOTE_ICON[tone])} aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Text with `backtick` spans rendered as inline code — flags read as flags. */
export function Rich({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="whitespace-nowrap rounded bg-muted px-1 py-px font-mono text-[0.85em] text-foreground">{part}</code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** A collapsed card in the look of the Project page's policy section: one
 *  line (title + hint) until opened. `id` is the deep-link anchor. */
export function Advanced({ id, title, hint, children }: { id: string; title: string; hint: string; children: ReactNode }) {
  return (
    <details id={id} className="group scroll-mt-16 rounded-xl border border-border bg-card">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
        <h3 className="text-sm font-medium">{title}</h3>
        <span className="ml-auto text-xs text-muted-foreground">{hint}</span>
      </summary>
      <div className="space-y-3 border-t border-border/60 px-4 pb-4 pt-3 text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
    </details>
  );
}
