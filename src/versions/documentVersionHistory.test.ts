import * as Y from 'yjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentVersionHistory, DEFAULT_VERSION_CHECKPOINT_POLICY } from './documentVersionHistory'
import { YjsIndexedDBStore } from '../persistence/yjsStore'

const docs: Y.Doc[] = []
const histories: DocumentVersionHistory[] = []
afterEach(() => {
  histories.splice(0).forEach(history => history.destroy())
  docs.splice(0).forEach(doc => doc.destroy())
  vi.useRealTimers()
})

const paragraph = (text: string, marks?: Array<{ type: string }>) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph' as const, content: text ? [{ type: 'text' as const, text, ...(marks ? { marks } : {}) }] : [] }],
})
const policy = { ...DEFAULT_VERSION_CHECKPOINT_POLICY, quietPeriodMs: 10_000, minimumAutomaticIntervalMs: 0, minimumChangedCharacters: 40 }

describe('DocumentVersionHistory', () => {
  it('does not checkpoint after a 1–2 second pause or for a minor change', () => {
    vi.useFakeTimers()
    const doc = new Y.Doc(); docs.push(doc)
    const history = new DocumentVersionHistory(doc, { id: 'a', name: 'A' }, { ...policy, quietPeriodMs: 30_000 })
    history.start(); histories.push(history)
    history.recordLocalEdit(paragraph('Original text'), paragraph('Original text with a tiny edit'))
    vi.advanceTimersByTime(2_000)
    expect(history.getSnapshot()).toHaveLength(1)
    vi.advanceTimersByTime(28_000)
    expect(history.getSnapshot()).toHaveLength(1)
  })

  it('groups many edits into one substantial automatic editing-session checkpoint', () => {
    vi.useFakeTimers()
    const doc = new Y.Doc(); docs.push(doc)
    const history = new DocumentVersionHistory(doc, { id: 'writer', name: 'Writer' }, policy)
    history.start(); histories.push(history)
    const base = paragraph('A short starting sentence.')
    history.recordLocalEdit(base, paragraph('A substantially expanded starting sentence with additional detail.'))
    vi.advanceTimersByTime(8_000)
    history.recordLocalEdit(paragraph('A substantially expanded starting sentence with additional detail.'), paragraph('A substantially expanded starting sentence with additional detail and another full explanation of the intended direction.'))
    vi.advanceTimersByTime(9_999)
    expect(history.getSnapshot()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(history.getSnapshot()).toHaveLength(2)
    expect(history.getSnapshot()[1]).toMatchObject({ kind: 'automatic', author: { id: 'writer' }, name: 'Editing session' })
    expect(history.getSnapshot()[1]?.content).toEqual(paragraph('A substantially expanded starting sentence with additional detail and another full explanation of the intended direction.'))
  })

  it('creates named versions, preserves rich marks, and deduplicates duplicate or near-identical snapshots', () => {
    const doc = new Y.Doc(); docs.push(doc)
    const history = new DocumentVersionHistory(doc, { id: 'writer', name: 'Writer' }, policy)
    history.start(); histories.push(history)
    const rich = paragraph('A formatted document', [{ type: 'bold' }])
    const first = history.createNamedVersion('Approved draft', rich)
    expect(first?.name).toBe('Approved draft')
    expect(first?.content).toEqual(rich)
    expect(history.createNamedVersion('Duplicate title', rich)).toBeNull()
    expect(history.createNamedVersion('Nearly same', paragraph('A formatted document! ', [{ type: 'bold' }]))).toBeNull()
    expect(history.getSnapshot()).toHaveLength(1)
  })

  it('synchronizes named and restore entries between independent Y.Doc replicas', () => {
    const a = new Y.Doc(); const b = new Y.Doc(); docs.push(a, b)
    const historyA = new DocumentVersionHistory(a, { id: 'a', name: 'A' }, policy)
    const historyB = new DocumentVersionHistory(b, { id: 'b', name: 'B' }, policy)
    historyA.start(); historyB.start(); histories.push(historyA, historyB)
    const original = paragraph('Original content')
    const named = historyA.createNamedVersion('Release candidate', original)!
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    expect(historyB.getSnapshot()).toEqual(historyA.getSnapshot())
    const restored = historyA.createRestoreVersion(paragraph('Restored rich content', [{ type: 'italic' }]), named)
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    expect(historyB.getSnapshot()).toEqual(historyA.getSnapshot())
    expect(historyB.getSnapshot().at(-1)).toMatchObject({ kind: 'restore', restoredFrom: named.id, content: paragraph('Restored rich content', [{ type: 'italic' }]) })
    expect(restored.id).not.toBe(named.id)
  })

  it('deletes only the selected saved snapshot, protects current content, and synchronizes deletion', () => {
    const a = new Y.Doc(); const b = new Y.Doc(); docs.push(a, b)
    a.getText('live-content').insert(0, 'Unchanged active document')
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    const historyA = new DocumentVersionHistory(a, { id: 'a', name: 'A' }, policy)
    const historyB = new DocumentVersionHistory(b, { id: 'b', name: 'B' }, policy)
    historyA.start(); historyB.start(); histories.push(historyA, historyB)
    const saved = historyA.createNamedVersion('Older snapshot', paragraph('Old content'))!
    const current = paragraph(a.getText('live-content').toString())
    const activeVersion = historyA.createNamedVersion('Current document version', current)!
    expect(historyA.deleteVersion(activeVersion.id, current)).toBe(false)
    expect(historyA.deleteVersion(saved.id, current)).toBe(true)
    expect(historyA.deleteVersion('missing', current)).toBe(false)
    expect(a.getText('live-content').toString()).toBe('Unchanged active document')
    expect(historyA.getSnapshot()).toEqual([activeVersion])
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    expect(historyB.getSnapshot()).toEqual([activeVersion])
    expect(b.getText('live-content').toString()).toBe('Unchanged active document')
  })

  it('persists version deletion across y-indexeddb session restart without changing document content', async () => {
    const store = new YjsIndexedDBStore()
    const documentId = `version-delete-${crypto.randomUUID()}`
    const session = await store.openDocument(documentId)
    session.doc.getText('current').insert(0, 'Current text stays')
    const history = new DocumentVersionHistory(session.doc, { id: 'a', name: 'A' }, policy)
    history.start(); histories.push(history)
    const saved = history.createNamedVersion('Old text', paragraph('Historical content'))!
    expect(history.deleteVersion(saved.id, paragraph('Current text stays'))).toBe(true)
    await session.flush()
    history.destroy()
    await session.destroy()

    const recoveredSession = await store.openDocument(documentId)
    const recovered = new DocumentVersionHistory(recoveredSession.doc, { id: 'a', name: 'A' }, policy)
    recovered.start(); histories.push(recovered)
    expect(recovered.getSnapshot()).toHaveLength(0)
    expect(recoveredSession.doc.getText('current').toString()).toBe('Current text stays')
    recovered.destroy()
    await recoveredSession.destroy()
  })
})
