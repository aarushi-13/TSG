import type { JSONContent } from '@tiptap/core'

export type DocumentRecord = {
  id: string
  title: string
  content: JSONContent
  createdAt: number
  updatedAt: number
}

export const EMPTY_DOCUMENT: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
}
