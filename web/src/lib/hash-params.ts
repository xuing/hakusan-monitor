/** Page state kept in the URL fragment: `#pool=a100&state=RUNNING&state=PENDING`.
 *  A key may repeat (one entry per selected value), so a value may hold commas. */
export type HashValue = string | string[] | null | undefined;

export function readHash(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
}

/** The hash with `updates` applied; null, "" or [] removes the key. Keys not in
 *  `updates` keep their place, so two parts of a page can share one hash. */
export function writeHash(hash: string, updates: Record<string, HashValue>): string {
  const params = readHash(hash);
  for (const [key, value] of Object.entries(updates)) {
    params.delete(key);
    for (const v of Array.isArray(value) ? value : value ? [value] : []) {
      if (v) params.append(key, v);
    }
  }
  const text = params.toString();
  return text ? `#${text}` : "";
}
