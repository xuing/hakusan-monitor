import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { readHash, writeHash, type HashValue } from "@/lib/hash-params";

/** Mirror local state into the URL hash and back.
 *
 *  - Local state changes replace the hash (no history entry per click).
 *  - A hash change on the same page (pasted link, back/forward) calls
 *    `onExternal`, so the page shows what the link says.
 *  - Arriving from another page: a hash that names any of these keys wins;
 *    a bare link keeps the local state and writes it into the URL.
 *
 *  Local state stays the source of truth while typing, so a search box is
 *  never driven through router updates. */
export function useHashSync(
  enabled: boolean,
  state: Record<string, HashValue>,
  onExternal: (params: URLSearchParams) => void,
) {
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const written = useRef(hash);
  const page = useRef<string | null>(enabled ? pathname : null);
  const key = JSON.stringify(state);

  const push = () => {
    const next = writeHash(hash, state);
    written.current = next;
    if (next !== hash) navigate({ pathname, search, hash: next }, { replace: true, preventScrollReset: true });
  };

  useEffect(() => {
    if (!enabled) {
      page.current = null;
      return;
    }
    const samePage = page.current === pathname;
    page.current = pathname;
    if (samePage && hash === written.current) return;
    const params = readHash(hash);
    if (samePage || Object.keys(state).some((k) => params.has(k))) {
      written.current = hash;
      onExternal(params);
    } else {
      push();
    }
    // runs on navigation only; state changes are pushed below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, pathname, hash]);

  useEffect(() => {
    if (enabled && page.current === pathname) push();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
