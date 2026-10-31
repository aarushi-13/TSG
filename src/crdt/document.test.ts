import { Editor } from '@tiptap/core'
import * as Y from 'yjs'
import { afterEach, describe, expect, it } from 'vitest'
import { createDocumentSchema, createEditorExtensions } from '../editor/extensions'
import { YjsIndexedDBStore } from '../persistence/yjsStore'
import { initializeSharedContent, readSharedContent } from './document'
import type { JSONContent } from '@tiptap/core'

const baseContent: JSONContent = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'alpha' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'omega' }] },
  ],
}
const stores: YjsIndexedDBStore[] = []
const editors: Editor[] = []
const standaloneDocs: Y.Doc[] = []
let sequence = 0

function newStore() {
  const store = new YjsIndexedDBStore()
  stores.push(store)
  return store
}

function createEditor(doc: Y.Doc) {
  const editor = new Editor({ element: window.document.createElement('div'), extensions: createEditorExtensions(doc) })
  editors.push(editor)
  return editor
}

function normalized(session: Awaited<ReturnType<YjsIndexedDBStore['openDocument']>>) {
  return JSON.stringify(readSharedContent(session))
}

afterEach(async () => {
  for (const editor of editors.splice(0)) editor.destroy()
  for (const doc of standaloneDocs.splice(0)) doc.destroy()
  for (const store of stores.splice(0)) {
    for (const docId of [`crdt-${sequence}`, `crdt-${sequence}-peer`, `crdt-${sequence}-second`]) {
      await store.deleteDocument(docId).catch(() => undefined)
    }
  }
})

describe('TipTap and Yjs CRDT integration', () => {
  it('initializes a Y.Doc from the stored JSON exactly once and edits the shared fragment', async () => {
    const id = `crdt-${++sequence}`
    const session = await newStore().openDocument(id)
    initializeSharedContent(session, baseContent)
    await session.flush()
    const editor = createEditor(session.doc)
    expect(editor.getJSON()).toEqual(editor.schema.nodeFromJSON(baseContent).toJSON())

    editor.commands.insertContentAt(2, 'A')
    expect(editor.getText()).toContain('aAlpha')
    expect(readSharedContent(session)).toEqual(editor.getJSON())
    await session.flush()
    await session.destroy()
  })

  it('exchanges independent concurrent TipTap updates and converges in either order with duplicates', async () => {
    const id = `crdt-${++sequence}`
    const store = newStore()
    const alice = await store.openDocument(id)
    initializeSharedContent(alice, baseContent)
    const initial = Y.encodeStateAsUpdate(alice.doc)
    const bobDoc = new Y.Doc()
    Y.applyUpdate(bobDoc, initial)
    const bobSession = { ...alice, documentId: `${id}-peer`, doc: bobDoc }
    const aliceEditor = createEditor(alice.doc)
    const bobEditor = createEditor(bobDoc)
    const commonVector = Y.encodeStateVector(alice.doc)

    aliceEditor.commands.insertContentAt(2, 'A')
    bobEditor.commands.insertContentAt(10, 'B')
    const aliceUpdate = Y.encodeStateAsUpdate(alice.doc, commonVector)
    const bobUpdate = Y.encodeStateAsUpdate(bobDoc, commonVector)

    const forward = new Y.Doc()
    const reverse = new Y.Doc()
    Y.applyUpdate(forward, initial)
    Y.applyUpdate(reverse, initial)
    Y.applyUpdate(forward, aliceUpdate)
    Y.applyUpdate(forward, bobUpdate)
    Y.applyUpdate(forward, aliceUpdate)
    Y.applyUpdate(reverse, bobUpdate)
    Y.applyUpdate(reverse, aliceUpdate)
    Y.applyUpdate(reverse, bobUpdate)

    const forwardSession = { ...alice, doc: forward }
    const reverseSession = { ...alice, doc: reverse }
    expect(normalized(forwardSession)).toBe(normalized(reverseSession))
    expect(JSON.stringify(readSharedContent(forwardSession))).toContain('A')
    expect(JSON.stringify(readSharedContent(forwardSession))).toContain('B')

    Y.applyUpdate(alice.doc, bobUpdate)
    Y.applyUpdate(bobDoc, aliceUpdate)
    await alice.flush()
    expect(JSON.stringify(readSharedContent(alice))).toBe(JSON.stringify(readSharedContent(bobSession)))
    expect(aliceEditor.getText()).toContain('A')
    expect(aliceEditor.getText()).toContain('B')
    const history = await store.listUpdateHistory(id)
    expect(history.some(entry => entry.kind === 'checkpoint')).toBe(true)
    expect(history.filter(entry => entry.kind === 'update').length).toBeGreaterThanOrEqual(2)
    expect(history.every(entry => entry.update.byteLength > 0)).toBe(true)
    const archivedReplica = new Y.Doc()
    for (const entry of history) Y.applyUpdate(archivedReplica, entry.update)
    expect(JSON.stringify(readSharedContent({ ...alice, doc: archivedReplica }))).toBe(JSON.stringify(readSharedContent(alice)))
    archivedReplica.destroy()

    forward.destroy()
    reverse.destroy()
    bobDoc.destroy()
    await alice.destroy()
  })

  it('retains concurrent insertions at the same position in the merged Y.XmlFragment', async () => {
    const id = `crdt-${++sequence}`
    const store = newStore()
    const left = await store.openDocument(id)
    initializeSharedContent(left, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'shared text' }] }] })
    const baseUpdate = Y.encodeStateAsUpdate(left.doc)
    const baseVector = Y.encodeStateVector(left.doc)
    const right = new Y.Doc()
    standaloneDocs.push(right)
    Y.applyUpdate(right, baseUpdate)
    const leftEditor = createEditor(left.doc)
    const rightEditor = createEditor(right)

    leftEditor.commands.insertContentAt(4, 'LEFT')
    rightEditor.commands.insertContentAt(4, 'RIGHT')
    const leftUpdate = Y.encodeStateAsUpdate(left.doc, baseVector)
    const rightUpdate = Y.encodeStateAsUpdate(right, baseVector)
    Y.applyUpdate(left.doc, rightUpdate)
    Y.applyUpdate(right, leftUpdate)

    const merged = leftEditor.getText()
    expect(merged).toContain('LEFT')
    expect(merged).toContain('RIGHT')
    expect(merged).toBe(rightEditor.getText())
    await left.destroy()
  })

  it('does not overwrite non-empty shared content when initialization is retried', async () => {
    const id = `crdt-${++sequence}`
    const session = await newStore().openDocument(id)
    initializeSharedContent(session, baseContent)
    const doc = createEditor(session.doc)
    doc.commands.insertContentAt(2, '!')
    const expected = doc.getJSON()

    initializeSharedContent(session, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'stale' }] }] })
    expect(readSharedContent(session)).toEqual(expected)
    await session.destroy()
  })

  it('keeps separate documents isolated and restores XML-backed editor content after reopening', async () => {
    const store = newStore()
    const first = await store.openDocument(`crdt-${++sequence}`)
    const second = await store.openDocument(`${first.documentId}-second`)
    initializeSharedContent(first, baseContent)
    initializeSharedContent(second, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'other document' }] }] })
    await first.flush()
    await second.flush()
    await first.destroy()
    await second.destroy()

    const restoredFirst = await store.openDocument(first.documentId)
    const restoredSecond = await store.openDocument(second.documentId)
    expect(readSharedContent(restoredFirst)).toEqual(createDocumentSchema().nodeFromJSON(baseContent).toJSON())
    expect(readSharedContent(restoredSecond)).not.toEqual(readSharedContent(restoredFirst))
    await restoredFirst.destroy()
    await restoredSecond.destroy()
  })
})
