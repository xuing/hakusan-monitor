/**
 * The URL prefix the app is mounted under, "" at the site root.
 *
 * Behind the reverse proxy the app lives at /hakusan/ (the proxy strips the
 * prefix before forwarding). index.html sets <base href> from the page URL
 * before any asset loads; this reads it back for the router and API calls.
 */
export const BASE_PATH = typeof document === "undefined"
  ? ""
  : new URL(document.baseURI).pathname.replace(/\/+$/, "");

/** An app-absolute path ("/api/snapshot") under the mount prefix. */
export const withBase = (path: string) => `${BASE_PATH}${path}`;
