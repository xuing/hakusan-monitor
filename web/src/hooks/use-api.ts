import { useEffect, useRef, useState } from "react";

interface ApiState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
}

/**
 * Fetch once (and optionally poll). `depKey` triggers a refetch when it changes;
 * the fetcher is held in a ref so inline closures don't cause refetch loops.
 */
export function useApi<T>(fetcher: () => Promise<T>, depKey: unknown = null, pollMs = 0): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({ data: null, error: null, loading: true });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let alive = true;
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const data = await fetcherRef.current();
        if (alive) setState({ data, error: null, loading: false });
      } catch (e) {
        if (alive) setState((s) => ({ ...s, error: e as Error, loading: false }));
      } finally {
        busy = false;
      }
    };
    void load();
    const id = pollMs ? setInterval(() => void load(), pollMs) : null;
    return () => {
      alive = false;
      if (id) clearInterval(id);
    };
  }, [depKey, pollMs]);

  return state;
}
