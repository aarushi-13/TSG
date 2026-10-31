import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import { captureSnapshot, extractDocumentText } from './documentText'

const paragraph = (text: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content })

describe('extractDocumentText', () => {
  it('returns an empty string for missing or empty documents', () => {
    expect(extractDocumentText(null)).toBe('')
    expect(extractDocumentText(undefined)).toBe('')
    expect(extractDocumentText(doc())).toBe('')
    expect(extractDocumentText(doc({ type: 'paragraph' }))).toBe('')
  })

  it('marks headings by level so the outline survives', () => {
    const text = extractDocumentText(doc(
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Field notes' }] },
      paragraph('We walked the north field.'),
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Next steps' }] },
      paragraph('Order replacement stakes.'),
    ))

    expect(text).toBe('# Field notes\n\nWe walked the north field.\n\n### Next steps\n\nOrder replacement stakes.')
  })

  it('separates paragraphs by a blank line rather than running them together', () => {
    expect(extractDocumentText(doc(paragraph('First thought.'), paragraph('Second thought.'))))
      .toBe('First thought.\n\nSecond thought.')
  })

  it('keeps bullet and ordered list structure, numbering from the list start', () => {
    const bullets = doc({
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [paragraph('Hawthorn took well')] },
        { type: 'listItem', content: [paragraph('Six are waterlogged')] },
      ],
    })
    expect(extractDocumentText(bullets)).toBe('- Hawthorn took well\n- Six are waterlogged')

    const ordered = doc({
      type: 'orderedList',
      attrs: { start: 3 },
      content: [
        { type: 'listItem', content: [paragraph('Book the soil test')] },
        { type: 'listItem', content: [paragraph('Write up the bee count')] },
      ],
    })
    expect(extractDocumentText(ordered)).toBe('3. Book the soil test\n4. Write up the bee count')
  })

  it('indents nested lists under their parent item', () => {
    const text = extractDocumentText(doc({
      type: 'bulletList',
      content: [{
        type: 'listItem',
        content: [
          paragraph('Hedgerow'),
          { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('Fourteen healthy')] }] },
        ],
      }],
    }))

    expect(text).toBe('- Hedgerow\n  - Fourteen healthy')
  })

  it('renders task list checkboxes by state', () => {
    const text = extractDocumentText(doc({
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: true }, content: [paragraph('Order stakes')] },
        { type: 'taskItem', attrs: { checked: false }, content: [paragraph('Book soil test')] },
      ],
    }))

    expect(text).toBe('- [x] Order stakes\n- [ ] Book soil test')
  })

  it('prefixes blockquotes and fences code blocks', () => {
    expect(extractDocumentText(doc({ type: 'blockquote', content: [paragraph('A borrowed thought.')] })))
      .toBe('> A borrowed thought.')
    expect(extractDocumentText(doc({ type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const a = 1' }] })))
      .toBe('```ts\nconst a = 1\n```')
  })

  it('renders tables one row per line', () => {
    const cell = (text: string): JSONContent => ({ type: 'tableCell', content: [paragraph(text)] })
    const text = extractDocumentText(doc({
      type: 'table',
      content: [
        { type: 'tableRow', content: [cell('Species'), cell('Count')] },
        { type: 'tableRow', content: [cell('Hawthorn'), cell('14')] },
      ],
    }))

    expect(text).toBe('| Species | Count |\n| Hawthorn | 14 |')
  })

  it('keeps hard breaks as line breaks and horizontal rules as a divider', () => {
    expect(extractDocumentText(doc({
      type: 'paragraph',
      content: [{ type: 'text', text: 'One' }, { type: 'hardBreak' }, { type: 'text', text: 'Two' }],
    }))).toBe('One\nTwo')
    expect(extractDocumentText(doc(paragraph('Above'), { type: 'horizontalRule' }, paragraph('Below'))))
      .toBe('Above\n\n---\n\nBelow')
  })

  it('falls back to inline text for node types it does not know', () => {
    expect(extractDocumentText(doc({ type: 'someFutureBlock', content: [paragraph('Still readable.')] })))
      .toBe('Still readable.')
  })

  it('does not mutate the document it reads', () => {
    const source = doc(
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Notes' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('A point')] }] },
    )
    const before = JSON.stringify(source)

    extractDocumentText(source)

    expect(JSON.stringify(source)).toBe(before)
  })
})

describe('captureSnapshot', () => {
  it('records the extracted text with its length and a timestamp', () => {
    const snapshot = captureSnapshot(doc(paragraph('A short note.')))

    expect(snapshot.text).toBe('A short note.')
    expect(snapshot.characters).toBe('A short note.'.length)
    expect(snapshot.capturedAt).toBeGreaterThan(0)
  })

  it('snapshots an empty document as empty text', () => {
    expect(captureSnapshot(doc()).text).toBe('')
    expect(captureSnapshot(doc()).characters).toBe(0)
  })
})
