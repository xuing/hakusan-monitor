import { Fragment, type ReactNode } from "react";
import type { TFn, TranslationKey } from "@/i18n";
import { tidyUnits } from "@/lib/analytics-format";

/** Placeholders that stay plain text inside a finding; every other value is bold. */
const PLAIN = new Set(["unit", "unitH", "unitN", "pool", "thing", "day"]);

/** A localized sentence with its numbers set in bold. */
export function rich(t: TFn, key: TranslationKey, vars: Record<string, string | number>): ReactNode {
  const parts = tidyUnits(t(key), vars).split(/\{(\w+)\}/g);
  return parts.map((part, i) => {
    if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>;
    const value = vars[part];
    if (value === undefined) return <Fragment key={i}>{`{${part}}`}</Fragment>;
    return PLAIN.has(part)
      ? <Fragment key={i}>{value}</Fragment>
      : <b key={i} className="font-semibold">{value}</b>;
  });
}
