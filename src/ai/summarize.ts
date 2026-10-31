const SUMMARIZE_ENDPOINT = '/api/summarize'
const GENERIC_FAILURE = 'The summary service could not be reached. Please try again.'
const THROTTLE_RETRIES = 1
const DEFAULT_RETRY_DELAY_MS = 5_000
const MAX_RETRY_DELAY_MS = 10_000

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    function onAbort() { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Honours Retry-After when the server sends one, clamped so a bad header cannot stall the panel. */
function retryDelay(response: Response): number {
  const header = Number(response.headers.get('retry-after'))
  if (!Number.isFinite(header) || header <= 0) return DEFAULT_RETRY_DELAY_MS
  return Math.min(header * 1000, MAX_RETRY_DELAY_MS)
}

/**
 * Streams a summary of `text` from the server, handing each decoded piece to `onChunk`.
 * Rejects with the server's own message when the request is refused, so the panel can show it verbatim.
 *
 * A 429 is waited out and retried rather than surfaced: the throttle is there to protect the
 * service from bursts, and showing the user a dead end because a request arrived a moment too
 * early would be worse than pausing for the server's Retry-After.
 */
export async function summarize(text: string, onChunk: (chunk: string) => void, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(SUMMARIZE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    })

    if (response.status === 429 && attempt < THROTTLE_RETRIES) {
      await response.text().catch(() => '')
      await wait(retryDelay(response), signal)
      continue
    }

    if (!response.ok) {
      const message = (await response.text().catch(() => '')).trim()
      throw new Error(message || GENERIC_FAILURE)
    }
    if (!response.body) throw new Error(GENERIC_FAILURE)

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        if (chunk) onChunk(chunk)
      }
      const tail = decoder.decode()
      if (tail) onChunk(tail)
    } finally {
      reader.releaseLock()
    }
    return
  }
}
