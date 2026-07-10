import { useState } from "react";
import { copyText } from "@/lib/clipboard";

/** Copied state with the standard 1.2 second reset. */
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
