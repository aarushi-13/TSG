import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, LoaderCircle, RefreshCw, Sparkles, X } from 'lucide-react'
import { summarize } from './summarize'

type Props = { getText: () => string; onClose: () => void }
type Status = 'loading' | 'streaming' | 'done' | 'error'

export const AI_DISCLAIMER = 'AI-generated, may contain mistakes.'

/**
 * Overlay panel that streams an AI summary of the current document. It is positioned over the page
 * rather than inside the editor column, so opening it never reflows the paper or interrupts typing.
 */
export default function SummaryPanel({ getText, onClose }: Props) {
  const [status, setStatus] = useState<Status>('loading')
  const [summary, setSummary] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [copied, setCopied] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const copyTimer = useRef<number | undefined>(undefined)
  const abortTimer = useRef<number | undefined>(undefined)
  const latestText = useRef(getText)
  latestText.current = getText

  const run = useCallback(() => {
    controller.current?.abort()
    const active = new AbortController()
    controller.current = active
    setStatus('loading')
    setSummary('')
    setErrorMessage('')
    void summarize(latestText.current(), chunk => {
      if (active.signal.aborted) return
      setStatus('streaming')
      setSummary(previous => previous + chunk)
    }, active.signal).then(() => {
      if (!active.signal.aborted) setStatus('done')
    }).catch((error: unknown) => {
      if (active.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return
      setErrorMessage(error instanceof Error && error.message ? error.message : 'Summary failed. Please try again.')
      setStatus('error')
    })
  }, [])

  useEffect(() => {
    // StrictMode runs this effect twice in development: mount, cleanup, then mount again. Aborting
    // straight away in the cleanup would cancel the first request and immediately start a second,
    // and the server's per-IP throttle would reject that second one. Queueing the abort instead
    // lets the re-run cancel it, so opening the panel sends exactly one request, while a genuine
    // unmount still aborts a tick later.
    window.clearTimeout(abortTimer.current)
    if (!controller.current || controller.current.signal.aborted) run()
    return () => {
      abortTimer.current = window.setTimeout(() => {
        controller.current?.abort()
        window.clearTimeout(copyTimer.current)
      }, 0)
    }
  }, [run])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(summary.trim())
      setCopied(true)
      window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800)
    } catch {
      window.prompt('Copy this summary', summary.trim())
    }
  }

  const streaming = status === 'loading' || status === 'streaming'
  return <aside className="summary-panel" role="dialog" aria-label="AI summary">
    <header className="summary-panel-top">
      <span className="summary-panel-title"><Sparkles size={14}/> Summary</span>
      <button className="icon-button" type="button" onClick={onClose} aria-label="Close summary"><X size={16}/></button>
    </header>
    <div className="summary-panel-body" aria-live="polite" aria-busy={streaming}>
      {status === 'error'
        ? <div className="summary-error" role="alert"><b>No summary yet</b><p>{errorMessage}</p><button className="summary-action" type="button" onClick={run}><RefreshCw size={13}/> Retry</button></div>
        : status === 'loading'
          ? <div className="summary-loading"><LoaderCircle size={15}/> Reading your document…</div>
          : <div className="summary-content">{renderSummary(summary)}{status === 'streaming' && <span className="summary-caret" aria-hidden="true"/>}</div>}
    </div>
    <footer className="summary-panel-foot">
      {status !== 'error' && <div className="summary-actions">
        <button className="summary-action" type="button" onClick={() => void copy()} disabled={streaming || !summary.trim()}>{copied ? <><Check size={13}/> Copied</> : <><Copy size={13}/> Copy</>}</button>
        <button className="summary-action" type="button" onClick={run} disabled={streaming}><RefreshCw size={13}/> Regenerate</button>
        <button className="summary-action" type="button" onClick={onClose}>Close</button>
      </div>}
      <p className="summary-note">{AI_DISCLAIMER}</p>
    </footer>
  </aside>
}

/** Turns the streamed plain text into paragraphs and bullet lists without a markdown dependency. */
export function renderSummary(text: string): ReactNode[] {
  const blocks: ReactNode[] = []
  let bullets: string[] = []
  const flushBullets = () => {
    if (!bullets.length) return
    blocks.push(<ul key={`list-${blocks.length}`}>{bullets.map((item, index) => <li key={index}>{item}</li>)}</ul>)
    bullets = []
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) { flushBullets(); continue }
    if (trimmed.startsWith('-') || trimmed.startsWith('•')) {
      bullets.push(stripInlineMarkup(trimmed.slice(1).trim()))
      continue
    }
    flushBullets()
    blocks.push(<p key={`line-${blocks.length}`}>{stripInlineMarkup(trimmed)}</p>)
  }
  flushBullets()
  return blocks
}

/** Drops the asterisk emphasis the model sometimes emits, since nothing here renders markdown. */
function stripInlineMarkup(value: string): string {
  return value.replace(/\*\*(.+?)\*\*/gu, '$1').replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|$)/gu, '$1$2')
}
