import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import * as Y from 'yjs'
import type { JSONContent } from '@tiptap/core'
import DocumentEditor from '../editor/DocumentEditor'
import { documentYjsStore } from '../persistence/yjsStore'
import type { DocumentRecord } from '../documents/types'

const VERSION_MAP = 'tsg-document-versions-v1'
const CONFLICT_RECORDS = 'tsg-conflict-records-v2'

/** Long enough to clear the summarizer's minimum, and structured so extraction has shape to keep. */
const notes: JSONContent = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Hedgerow survey' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Fourteen of twenty hawthorn saplings have taken well this season.' }] },
    {
      type: 'bulletList',
      content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Six near the ditch are waterlogged' }] }] }],
    },
  ],
}

let sequence = 0
const leases: Array<{ release: () => void }> = []

function streamOf(...chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status: 200 })
}

/** Installs a provider response whose stream the caller closes, to hold a request mid-flight. */
function groqHeld(stream: ReadableStream): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })))
}

function record(id: string, content: JSONContent): DocumentRecord {
  return { id, title: 'Field notes', content, createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000 }
}

/** Mounts the editor and hands back the same Y.Doc session it is using, for direct inspection. */
async function openEditor(content: JSONContent = notes) {
  const id = `summary-integration-${++sequence}`
  const lease = documentYjsStore.acquireDocument(id)
  leases.push(lease)
  const view = render(<MemoryRouter><DocumentEditor document={record(id, content)} onSave={vi.fn(async () => true)}/></MemoryRouter>)
  await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy())
  const session = await lease.session
  return { view, session, doc: session.doc }
}

/** Resolves once the document has gone a short while without any Yjs update of its own. */
async function untilQuiet(doc: Y.Doc, idleMs = 250): Promise<void> {
  let last = Date.now()
  const bump = () => { last = Date.now() }
  doc.on('update', bump)
  try {
    while (Date.now() - last < idleMs) await new Promise(resolve => setTimeout(resolve, 40))
  } finally {
    doc.off('update', bump)
  }
}

async function generateSummary(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Summarize' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: 'Summarize' }))
  await screen.findByRole('dialog', { name: 'AI summary' })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => streamOf('- Fourteen hawthorn took well.\n- Six are waterlogged.\n')))
})

afterEach(() => {
  cleanup()
  while (leases.length) leases.pop()?.release()
  vi.unstubAllGlobals()
})

describe('AI summary against the live editor', () => {
  it('sends the latest editor content as structured text, headings and bullets intact', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn(async () => streamOf('- A point.'))
    vi.stubGlobal('fetch', fetchMock)
    await openEditor()

    await generateSummary(user)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { text: string }
    expect(body.text).toContain('# Hedgerow survey')
    expect(body.text).toContain('Fourteen of twenty hawthorn saplings have taken well this season.')
    expect(body.text).toContain('- Six near the ditch are waterlogged')
  })

  it('summarizes text typed after the document was opened, not the stored projection', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn(async () => streamOf('- A point.'))
    vi.stubGlobal('fetch', fetchMock)
    await openEditor()

    const editable = document.querySelector<HTMLElement>('.ProseMirror')!
    await user.click(editable)
    await user.type(editable, 'An afterthought worth including.')
    await generateSummary(user)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { text: string }
    expect(body.text).toContain('An afterthought worth including.')
  })

  it('names the snapshot a finished summary describes', async () => {
    const user = userEvent.setup()
    await openEditor()

    await generateSummary(user)

    expect(await screen.findByText(/Summary of [\d,]+ characters as of/u)).toBeInTheDocument()
  })

  it('flags a summary as stale once the document moves past it', async () => {
    const user = userEvent.setup()
    await openEditor()

    await generateSummary(user)
    await screen.findByText(/Summary of [\d,]+ characters as of/u)

    const editable = document.querySelector<HTMLElement>('.ProseMirror')!
    await user.click(editable)
    await user.type(editable, ' And one more line.')

    expect(await screen.findByText(/The document has changed since this summary/u)).toBeInTheDocument()
  })
})

describe('AI summary leaves the document alone', () => {
  // Control for the negative assertions below: proves the update watcher is wired to a doc that
  // really does emit, so "no updates" cannot pass just because nothing was being observed.
  it('sees Y.Doc updates when the user actually types', async () => {
    const user = userEvent.setup()
    const { doc } = await openEditor()
    await untilQuiet(doc)

    const updates: Uint8Array[] = []
    const watch = (update: Uint8Array) => updates.push(update)
    doc.on('update', watch)
    const editable = document.querySelector<HTMLElement>('.ProseMirror')!
    await user.click(editable)
    await user.type(editable, 'A real edit.')
    doc.off('update', watch)

    expect(updates.length).toBeGreaterThan(0)
  })

  it('does not insert the summary into the document on its own', async () => {
    const user = userEvent.setup()
    await openEditor()

    await generateSummary(user)
    expect(await screen.findByText('Fourteen hawthorn took well.')).toBeInTheDocument()

    expect(document.querySelector('.ProseMirror')!.textContent).not.toContain('AI summary')
    expect(document.querySelector('.ProseMirror')!.textContent).not.toContain('Fourteen hawthorn took well.')
  })

  it('writes nothing to the Y.Doc while generating a summary', async () => {
    const user = userEvent.setup()
    const { doc } = await openEditor()
    await untilQuiet(doc)

    const updates: Uint8Array[] = []
    const watch = (update: Uint8Array) => updates.push(update)
    doc.on('update', watch)
    await generateSummary(user)
    await screen.findByText('Fourteen hawthorn took well.')
    doc.off('update', watch)

    expect(updates).toHaveLength(0)
  })

  it('creates no version-history entries while generating a summary', async () => {
    const user = userEvent.setup()
    const { doc } = await openEditor()
    await untilQuiet(doc)
    const before = doc.getMap(VERSION_MAP).size

    await generateSummary(user)
    await screen.findByText('Fourteen hawthorn took well.')

    expect(doc.getMap(VERSION_MAP).size).toBe(before)
  })

  it('records no conflicts while generating a summary', async () => {
    const user = userEvent.setup()
    const { doc } = await openEditor()
    await untilQuiet(doc)

    await generateSummary(user)
    await screen.findByText('Fourteen hawthorn took well.')

    expect(doc.getMap(CONFLICT_RECORDS).size).toBe(0)
  })

  it('lets a peer keep editing, and the edit arrive, while a summary is in flight', async () => {
    const user = userEvent.setup()
    // A stream held open on purpose, so the assertions run while the request is genuinely unfinished.
    let release: () => void = () => {}
    const encoder = new TextEncoder()
    groqHeld(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('- Partial summary so far.'))
        release = () => controller.close()
      },
    }))
    const { doc } = await openEditor()
    await untilQuiet(doc)

    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))
    peer.on('update', update => Y.applyUpdate(doc, update, 'peer'))

    await generateSummary(user)
    expect(await screen.findByText('Partial summary so far.')).toBeInTheDocument()

    // The other collaborator types while this browser is still streaming its summary.
    const fragment = peer.getXmlFragment('default')
    const added = new Y.XmlElement('paragraph')
    added.insert(0, [new Y.XmlText('A peer typed this mid-summary.')])
    peer.transact(() => fragment.insert(fragment.length, [added]))

    await waitFor(() => expect(document.querySelector('.ProseMirror')!.textContent).toContain('A peer typed this mid-summary.'))

    release()
    await waitFor(() => expect(screen.getByRole('button', { name: /Regenerate/u })).toBeEnabled())
    peer.destroy()
  })

  it('sends a collaborating peer nothing while a summary is generated', async () => {
    const user = userEvent.setup()
    const { doc } = await openEditor()
    await untilQuiet(doc)

    // A second browser on the same document, fed by the same updates y-webrtc would carry.
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))
    let relayed = 0
    const relay = (update: Uint8Array) => { relayed += 1; Y.applyUpdate(peer, update, 'relay') }
    doc.on('update', relay)

    await generateSummary(user)
    await screen.findByText('Fourteen hawthorn took well.')
    doc.off('update', relay)

    expect(relayed).toBe(0)
    expect(JSON.stringify(peer.getXmlFragment('default').toJSON())).not.toContain('Fourteen hawthorn took well.')
    peer.destroy()
  })
})

describe('inserting a summary', () => {
  it('appends it as its own section only when the user asks', async () => {
    const user = userEvent.setup()
    await openEditor()

    await generateSummary(user)
    await screen.findByText('Fourteen hawthorn took well.')
    await user.click(screen.getByRole('button', { name: /Insert into document/u }))

    await waitFor(() => expect(document.querySelector('.ProseMirror')!.textContent).toContain('AI summary'))
    const content = document.querySelector('.ProseMirror')!.textContent ?? ''
    expect(content).toContain('Fourteen hawthorn took well.')
    expect(content).toContain('Six are waterlogged.')
    // The original text is still there; the summary was appended, not substituted.
    expect(content).toContain('Fourteen of twenty hawthorn saplings have taken well this season.')
  })

  it('turns the bullet lines into a real list rather than literal dashes', async () => {
    const user = userEvent.setup()
    await openEditor()

    await generateSummary(user)
    await screen.findByText('Fourteen hawthorn took well.')
    await user.click(screen.getByRole('button', { name: /Insert into document/u }))

    await waitFor(() => expect(document.querySelector('.ProseMirror h3')).toBeTruthy())
    const items = [...document.querySelectorAll('.ProseMirror ul li')].map(item => item.textContent)
    expect(items).toContain('Fourteen hawthorn took well.')
    expect(document.querySelector('.ProseMirror h3')!.textContent).toBe('AI summary')
  })

  it('reports the insert back to the user and raises no conflicts', async () => {
    const user = userEvent.setup()
    const { doc } = await openEditor()

    await generateSummary(user)
    await screen.findByText('Fourteen hawthorn took well.')
    await user.click(screen.getByRole('button', { name: /Insert into document/u }))

    expect(await screen.findByRole('button', { name: /Inserted/u })).toBeInTheDocument()
    expect(doc.getMap(CONFLICT_RECORDS).size).toBe(0)
  })
})

describe('AI summary failure handling', () => {
  it('surfaces an oversized-document refusal from the server', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('That document is too large to summarize.', { status: 413 })))
    await openEditor()

    await generateSummary(user)

    expect(await screen.findByText('That document is too large to summarize.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Retry/u })).toBeInTheDocument()
  })

  it('surfaces a network failure without touching the document', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const { doc } = await openEditor()
    await untilQuiet(doc)

    const updates: Uint8Array[] = []
    const watch = (update: Uint8Array) => updates.push(update)
    doc.on('update', watch)
    await generateSummary(user)

    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument()
    doc.off('update', watch)
    expect(updates).toHaveLength(0)
  })

  it('keeps editing available while summaries are unavailable', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('AI summaries are not configured on this server.', { status: 503 })))
    await openEditor()

    await generateSummary(user)
    expect(await screen.findByText('AI summaries are not configured on this server.')).toBeInTheDocument()

    const editable = document.querySelector<HTMLElement>('.ProseMirror')!
    await user.click(editable)
    await user.type(editable, ' Still typing.')

    await waitFor(() => expect(editable.textContent).toContain('Still typing.'))
  })
})
