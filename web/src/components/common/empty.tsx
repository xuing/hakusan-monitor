import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("py-8 text-center text-sm text-muted-foreground", className)}>{children}</div>
  );
}
