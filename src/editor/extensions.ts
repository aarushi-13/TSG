import { Extension, getSchema } from '@tiptap/core'
import type { Extensions } from '@tiptap/core'
import { Plugin, type Transaction } from '@tiptap/pm/state'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import TextAlign from '@tiptap/extension-text-align'
import { TableKit } from '@tiptap/extension-table'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import * as Y from 'yjs'
import type { WebrtcProvider } from 'y-webrtc'
import type { LocalCollaborator } from '../networking/config'
import type { LocalEditContext } from '../conflicts/conflictManager'
import { getRichTextBlocks } from '../conflicts/blockIdentity'

const localEditContexts = new WeakMap<Transaction, LocalEditContext>()

export function consumeLocalEditContext(transaction: Transaction): LocalEditContext | null {
  const context = localEditContexts.get(transaction) ?? null
  localEditContexts.delete(transaction)
  return context
}

function createConflictCaptureExtension(document: Y.Doc) {
  return Extension.create({
    name: 'tsgConflictCapture',
    addProseMirrorPlugins() {
      return [new Plugin({
        filterTransaction(transaction, state) {
          if (!transaction.docChanged || transaction.getMeta(ySyncPluginKey)) return true
          localEditContexts.set(transaction, {
            beforeVector: Object.fromEntries([...Y.decodeStateVector(Y.encodeStateVector(document)).entries()].map(([client, clock]) => [String(client), clock])),
            blocks: getRichTextBlocks(state).map(({ blockId, index, text, json }) => ({ blockId, index, text, json })),
          })
          return true
        },
      })]
    },
  })
}

export function createEditorExtensions(document?: Y.Doc, provider?: WebrtcProvider, collaborator?: LocalCollaborator): Extensions {
  const extensions: Extensions = [
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, undoRedo: document ? false : undefined }),
    Placeholder.configure({ placeholder: 'Start with a thought…' }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TableKit.configure({ table: { resizable: true } }),
    TaskList,
    TaskItem.configure({ nested: true }),
  ]
  if (document) extensions.push(createConflictCaptureExtension(document), Collaboration.configure({ document, field: 'default' }))
  if (provider && collaborator) extensions.push(CollaborationCaret.configure({ provider, user: collaborator }))
  return extensions
}

export function createDocumentSchema() {
  return getSchema(createEditorExtensions())
}
