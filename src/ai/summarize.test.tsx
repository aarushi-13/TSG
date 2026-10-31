import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { summarize } from './summarize'
import SummaryPanel, { renderSummary } from './SummaryPanel'

afterEach(() => cleanup())

function streamingResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200, ...init })
}

describe('summarize', () => {
  it('posts the document text and reports each streamed chunk', async () => {
    const fetchMock = vi.fn(async () => streamingResponse(['- first point\n', '- second point\n']))
    vi.stubGlobal('fetch', fetchMock)
    const chunks: string[] = []

    await summarize('A document long enough to summarize.', chunk => chunks.push(chunk))

    expect(chunks.join('')).toBe('- first point\n- second point\n')
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/summarize')
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body as string)).toEqual({ text: 'A document long enough to summarize.' })
  })

  it('reassembles a multi-byte character split across two chunks', async () => {
    const encoded = new TextEncoder().encode('Key takeaway: café')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, encoded.length - 1))
        controller.enqueue(encoded.slice(encoded.length - 1))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })))
    const chunks: string[] = []

    await summarize('A document long enough to summarize.', chunk => chunks.push(chunk))

    expect(chunks.join('')).toBe('Key takeaway: café')
  })

  it('surfaces the server message when the request is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('AI summaries are not configured on this server.', { status: 503 })))

    await expect(summarize('A document long enough to summarize.', () => {}))
      .rejects.toThrow('AI summaries are not configured on this server.')
  })

  it('stops reading when the caller aborts', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      return streamingResponse(['- a point\n'])
    }))
    controller.abort()

    await expect(summarize('A document long enough to summarize.', () => {}, controller.signal))
      .rejects.toThrow()
  })
})

describe('renderSummary', () => {
  it('turns dash and bullet lines into a list and leaves prose as paragraphs', () => {
    render(<div data-testid="summary">{renderSummary('- First point\n• Second point\n\nKey takeaway: it works.')}</div>)

    const items = screen.getAllByRole('listitem')
    expect(items.map(item => item.textContent)).toEqual(['First point', 'Second point'])
    expect(screen.getAllByRole('list')).toHaveLength(1)
    expect(screen.getByTestId('summary').querySelector('p')?.textContent).toBe('Key takeaway: it works.')
  })

  it('drops asterisk emphasis the model may emit', () => {
    render(<div data-testid="summary">{renderSummary('- A **bold** claim\n\n**Key takeaway:** done.')}</div>)

    expect(screen.getByRole('listitem').textContent).toBe('A bold claim')
    expect(screen.getByTestId('summary').querySelector('p')?.textContent).toBe('Key takeaway: done.')
  })

  it('renders nothing for an empty stream', () => {
    render(<div data-testid="summary">{renderSummary('')}</div>)

    expect(screen.getByTestId('summary')).toBeEmptyDOMElement()
  })
})

describe('SummaryPanel request lifecycle', () => {
  function streamOnce(text: string) {
    const encoder = new TextEncoder()
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(text)); controller.close() },
    }), { status: 200 })
  }

  it('sends exactly one request per open, even under StrictMode double-invoke', async () => {
    const fetchMock = vi.fn(async () => streamOnce('- Only one request.'))
    vi.stubGlobal('fetch', fetchMock)

    render(<StrictMode><SummaryPanel getText={() => 'A document long enough to summarize.'} onClose={() => {}}/></StrictMode>)

    expect(await screen.findByText('Only one request.')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('aborts the in-flight request when the panel unmounts', async () => {
    let captured: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      captured = options.signal ?? undefined
      return streamOnce('- A point.')
    }))

    const view = render(<StrictMode><SummaryPanel getText={() => 'A document long enough to summarize.'} onClose={() => {}}/></StrictMode>)
    expect(await screen.findByText('A point.')).toBeInTheDocument()
    expect(captured?.aborted).toBe(false)

    view.unmount()
    await waitFor(() => expect(captured?.aborted).toBe(true))
  })
})

describe('throttle handling', () => {
  function streamOnce(text: string) {
    const encoder = new TextEncoder()
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(text)); controller.close() },
    }), { status: 200 })
  }

  it('waits out a 429 and retries instead of surfacing it', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response('One summary every few seconds, please. Try again shortly.', { status: 429, headers: { 'retry-after': '5' } }))
        .mockResolvedValueOnce(streamOnce('- Recovered after the wait.'))
      vi.stubGlobal('fetch', fetchMock)

      const chunks: string[] = []
      const pending = summarize('A document long enough to summarize.', chunk => chunks.push(chunk))
      await vi.advanceTimersByTimeAsync(5_000)
      await pending

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(chunks.join('')).toBe('- Recovered after the wait.')
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up after one retry so a persistent throttle still reports', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('One summary every few seconds, please. Try again shortly.', { status: 429, headers: { 'retry-after': '5' } })))

      const pending = summarize('A document long enough to summarize.', () => {})
      const assertion = expect(pending).rejects.toThrow('One summary every few seconds')
      await vi.advanceTimersByTimeAsync(5_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops waiting if the panel is closed during the retry delay', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('throttled', { status: 429, headers: { 'retry-after': '5' } })))
      const controller = new AbortController()

      const pending = summarize('A document long enough to summarize.', () => {}, controller.signal)
      const assertion = expect(pending).rejects.toThrow()
      controller.abort()
      await vi.advanceTimersByTimeAsync(10)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
