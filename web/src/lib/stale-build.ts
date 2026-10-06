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

const BUILD_KEY = "hm_reload_for_build";
const IDLE_MS = 2 * 60_000;
let waiting = false;

/** The build this tab runs: the hash in its entry script's name ("" in dev). */
function ownBuild(): string {
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return "";
  const src = document.querySelector<HTMLScriptElement>('script[type="module"][src*="assets/index-"]')?.src ?? "";
  return /assets\/index-([\w-]+)\.js/.exec(src)?.[1] ?? "";
}

/** The server serves `build`. When it is not the one this tab runs, reload
 *  onto it once the viewer is not using the page — the tab is hidden, or no
 *  input for 2 min — so a half-set request is not lost. Once per build: if
 *  the reload still lands on another build, the tab stays as it is. */
export function noticeBuild(build: unknown) {
  const own = ownBuild();
  if (waiting || !own || typeof build !== "string" || !build || build === own) return;
  try {
    if (sessionStorage.getItem(BUILD_KEY) === build) return;
  } catch {
    // storage blocked: the 30 s guard in reloadForNewBuild still applies
  }
  waiting = true;
  let lastInput = Date.now();
  const mark = () => { lastInput = Date.now(); };
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    window.addEventListener(type, mark, { passive: true });
  }
  const tryReload = () => {
    if (!document.hidden && Date.now() - lastInput < IDLE_MS) return;
    try {
      sessionStorage.setItem(BUILD_KEY, build);
    } catch {
      // see above
    }
    reloadForNewBuild();
  };
  document.addEventListener("visibilitychange", tryReload);
  setInterval(tryReload, 15_000);
  tryReload();
}
