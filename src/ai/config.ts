/**
 * Where the browser sends summary requests.
 *
 * Defaults to a same-origin path, served by Vite middleware in development and by the Node web
 * service in production. VITE_SUMMARY_URL is an optional public endpoint override for local dev;
 * the provider API key stays on the server.
 */
export function getSummarizeUrl(): string {
  return import.meta.env.VITE_SUMMARY_URL?.trim() || '/api/summarize'
}
