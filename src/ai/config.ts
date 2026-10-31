/**
 * Where the browser sends summary requests.
 *
 * Defaults to a same-origin path, which is what `npm run dev` serves through Vite middleware and
 * what a reverse proxy in front of the summary service should expose in deployment. Set
 * VITE_SUMMARY_URL to point straight at the standalone service when it is reached directly; it is
 * a public endpoint URL, never a credential, and the provider API key stays on the service.
 */
export function getSummarizeUrl(): string {
  return import.meta.env.VITE_SUMMARY_URL?.trim() || '/api/summarize'
}
