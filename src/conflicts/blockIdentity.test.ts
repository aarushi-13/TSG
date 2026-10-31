import { Editor } from '@tiptap/core'
import * as Y from 'yjs'
import { afterEach, describe, expect, it } from 'vitest'
import { adoptBlockIdentity, getRichTextBlocks } from './blockIdentity'
import { createDocumentSchema, createEditorExtensions } from '../editor/extensions'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'

const editors: Editor[] = []
const docs: Y.Doc[] = []

afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy())
  docs.splice(0).forEach(doc => doc.destroy())
})

describe('rich-text block identity', () => {
  it('uses stable Yjs item identity for paragraphs and headings across local text changes', () => {
    const doc = new Y.Doc()
    docs.push(doc)
    prosemirrorJSONToYXmlFragment(createDocumentSchema(), { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'second' }] },
    ] }, doc.getXmlFragment('default'))
    const editor = new Editor({
      extensions: createEditorExtensions(doc),
    })
    editors.push(editor)
    const before = getRichTextBlocks(editor.state)
    expect(before).toHaveLength(3)
    expect(before.slice(0, 2).map(block => block.blockId[0])).toEqual(['y', 'y'])
    expect(before[2]?.blockId.startsWith('relative:')).toBe(true)
    editor.commands.setTextSelection({ from: 1, to: 6 })
    editor.commands.insertContent('updated')
    const after = getRichTextBlocks(editor.state)
    expect(after.slice(0, 2).map(block => block.blockId)).toEqual(before.slice(0, 2).map(block => block.blockId))
    expect(after.map(block => block.text)).toEqual(['updated', 'second', ''])

    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.commands.insertContent('new paragraph')
    adoptBlockIdentity(editor.state, 2, before[2]!.blockId)
    expect(getRichTextBlocks(editor.state)[2]?.blockId).toBe(before[2]?.blockId)
  })
})
