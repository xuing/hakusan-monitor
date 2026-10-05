import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { reasonDescription, reasonLabel, type TFn } from "@/i18n";
import { cn } from "@/lib/utils";

/** A reason in the queue card's legend: the localized label; on hover or
 *  focus, the code Slurm reports and its meaning from Slurm's job reason
 *  codes. Job rows show the label alone — one explanation per reason. */
export function ReasonText({ reason, t, className }: { reason: string; t: TFn; className?: string }) {
  const label = reasonLabel(t, reason);
  const desc = reasonDescription(t, reason);
  if (!desc) return <span className={className}>{label}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "cursor-help text-left outline-none",
            "focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-primary/45",
            className,
          )}
        >
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs leading-relaxed">
        <code className="block break-words font-mono font-semibold">{reason}</code>
        {desc !== reason && <p className="mt-0.5">{desc}</p>}
      </TooltipContent>
    </Tooltip>
  );
}
