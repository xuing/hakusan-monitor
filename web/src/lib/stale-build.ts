/**
 * A tab opened before a deploy still runs the old bundle; its lazy page
 * chunks were deleted by the rebuild, so the next navigation's import 404s
 * and the page fails to render. Reload once to pick up the new build — the
 * guard stops a loop when the failure is something else.
 */
const KEY = "hm_stale_reload_at";

export function isChunkLoadError(error: unknown): boolean {
  const msg = String((error as Error)?.message ?? error);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(msg);
}

/** true when a reload was started. */
export function reloadForNewBuild(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // storage blocked: still reload; the browser's own retry limits apply
  }
  window.location.reload();
  return true;
}

export function installStaleBuildReload() {
  // Vite fires this when a lazy chunk's preload fails
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadForNewBuild()) event.preventDefault();
  });
}
