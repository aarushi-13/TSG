import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'
import * as Y from 'yjs'
import { ySyncPluginKey } from '@tiptap/y-tiptap'

export type RichTextBlock = {
  blockId: string
  sourceId: string
  index: number
  text: string
  json: Record<string, unknown>
  from: number
  to: number
}

type SyncState = { type?: Y.XmlFragment; doc?: Y.Doc; binding?: { mapping?: Map<Y.AbstractType<unknown>, ProseMirrorNode | ProseMirrorNode[]> } }
type YItemType = Y.AbstractType<unknown> & { _item?: { id?: { client: number; clock: number } } | null }

/** Returns Yjs-item-backed identifiers for text blocks, stable across edits and replica order. */
export function getRichTextBlocks(state: EditorState): RichTextBlock[] {
  const sync = ySyncPluginKey.getState(state) as SyncState | undefined
  const mapping = sync?.binding?.mapping
  const aliases = sync?.doc?.getMap<string>('tsg-block-identities-v1')
  const result: RichTextBlock[] = []
  let index = 0
  state.doc.descendants((node, from) => {
    if (!node.isTextblock) return true
    const yType = mapping && findMappedType(mapping, node)
    const itemId = yType?._item?.id
    const sourceId = itemId
      ? `y:${itemId.client}:${itemId.clock}`
      : relativeBlockId(sync?.type, index, node.type.name)
    const blockId = aliases?.get(sourceId) ?? sourceId
    result.push({ blockId, sourceId, index, text: node.textContent, json: node.toJSON() as Record<string, unknown>, from, to: from + node.nodeSize })
    index += 1
    return false
  })
  return result
}

/** Preserve the shared identity of an initially empty Yjs block after it gets its first item. */
export function adoptBlockIdentity(state: EditorState, index: number, stableId: string): void {
  const sync = ySyncPluginKey.getState(state) as SyncState | undefined
  const block = getRichTextBlocks(state)[index]
  if (!sync?.doc || !block || block.blockId === stableId || !block.sourceId.startsWith('y:')) return
  sync.doc.getMap<string>('tsg-block-identities-v1').set(block.sourceId, stableId)
}

function relativeBlockId(fragment: Y.XmlFragment | undefined, index: number, typeName: string): string {
  if (!fragment) return `fallback:${index}:${typeName}`
  const relative = Y.createRelativePositionFromTypeIndex(fragment, fragment.length)
  const encoded = Array.from(Y.encodeRelativePosition(relative), byte => byte.toString(16).padStart(2, '0')).join('')
  return `relative:${encoded}:${index}:${typeName}`
}

function findMappedType(
  mapping: Map<Y.AbstractType<unknown>, ProseMirrorNode | ProseMirrorNode[]>,
  node: ProseMirrorNode,
): YItemType | undefined {
  for (const [type, mapped] of mapping) {
    if (mapped === node || (Array.isArray(mapped) && mapped.includes(node))) return type as YItemType
  }
  return undefined
}
