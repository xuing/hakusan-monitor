import { toneClass, utilTone, type Tone } from "@/lib/slurm";
import { cn } from "@/lib/utils";

/** A thin utilization bar; colour follows the value unless a tone is given. */
export function Bar({ value, tone, className }: { value: number; tone?: Tone; className?: string }) {
  const tn = tone ?? utilTone(value);
  return (
    <div className={cn("h-2 overflow-hidden rounded-full bg-muted", className)}>
      <div
        className={cn("h-full rounded-full transition-all duration-500", toneClass[tn].dot)}
        style={{ width: `${Math.min(100, Math.round((value || 0) * 100))}%` }}
      />
    </div>
  );
}
