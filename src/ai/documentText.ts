import type { JSONContent } from '@tiptap/core'

/**
 * A frozen copy of what was sent for summarizing. Held so the panel can say which revision of the
 * document a summary belongs to: the editor stays live while a request is in flight, and a summary
 * of text the user has since rewritten should not be presented as current.
 */
export type DocumentSnapshot = {
  text: string
  capturedAt: number
  characters: number
}

/** Marker for a list item whose own paragraphs need to line up under it. */
const CONTINUATION_INDENT = '  '

function inlineText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  return (node.content ?? []).map(inlineText).join('')
}

/** Prefixes the first line and indents the rest, so wrapped list content stays visually nested. */
function withMarker(lines: string[], marker: string): string[] {
  if (!lines.length) return [marker.trimEnd()]
  const [first, ...rest] = lines
  return [marker + first, ...rest.map(line => (line ? CONTINUATION_INDENT + line : line))]
}

function tableRow(row: JSONContent): string {
  const cells = (row.content ?? []).map(cell => inlineText(cell).replace(/\s*\n\s*/gu, ' ').trim())
  return `| ${cells.join(' | ')} |`
}

/**
 * Renders one block node as the lines it contributes. Lists recurse so nesting is preserved, and
 * every other node falls back to its inline text, which keeps unknown node types from vanishing.
 */
function blockLines(node: JSONContent): string[] {
  const children = node.content ?? []
  switch (node.type) {
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6)
      const text = inlineText(node).trim()
      return text ? [`${'#'.repeat(level)} ${text}`] : []
    }
    case 'paragraph': {
      const text = inlineText(node)
      return text.trim() ? text.split('\n') : []
    }
    case 'codeBlock': {
      const language = typeof node.attrs?.language === 'string' ? node.attrs.language : ''
      return ['```' + language, ...inlineText(node).split('\n'), '```']
    }
    case 'horizontalRule':
      return ['---']
    case 'blockquote':
      return children.flatMap(blockLines).map(line => (line ? `> ${line}` : '>'))
    case 'bulletList':
      return children.flatMap(child => withMarker(blockLines(child), '- '))
    case 'orderedList': {
      const start = Number(node.attrs?.start) || 1
      return children.flatMap((child, index) => withMarker(blockLines(child), `${start + index}. `))
    }
    case 'taskList':
      return children.flatMap(child => withMarker(blockLines(child), child.attrs?.checked ? '- [x] ' : '- [ ] '))
    case 'listItem':
    case 'taskItem':
      return children.flatMap(blockLines)
    case 'table':
      return children.map(tableRow)
    case 'text':
    case 'hardBreak':
      return inlineText(node).split('\n')
    default:
      return children.flatMap(blockLines)
  }
}

/**
 * Flattens TipTap/ProseMirror JSON into plain text that still carries the document's shape, using
 * light markdown conventions for headings, lists, quotes and tables. `editor.getText()` would run
 * the whole document together, which costs the model the outline it needs to summarize faithfully.
 *
 * Purely a read of the JSON: it never touches the editor state or the Y.Doc behind it.
 */
export function extractDocumentText(doc: JSONContent | null | undefined): string {
  if (!doc) return ''
  const blocks: string[] = []
  for (const child of doc.content ?? []) {
    const lines = blockLines(child)
    if (lines.length) blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n').replace(/\n{3,}/gu, '\n\n').trim()
}

/** Freezes the current editor content as the revision a summary request is about. */
export function captureSnapshot(doc: JSONContent | null | undefined): DocumentSnapshot {
  const text = extractDocumentText(doc)
  return { text, capturedAt: Date.now(), characters: text.length }
}
