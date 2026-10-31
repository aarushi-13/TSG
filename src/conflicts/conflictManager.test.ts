import * as Y from 'yjs'
import { afterEach, describe, expect, it } from 'vitest'
import { ConflictManager, type ConflictRecord, type LocalEditContext } from './conflictManager'

const managers: ConflictManager[] = []
const docs: Y.Doc[] = []

afterEach(() => {
  managers.splice(0).forEach(manager => manager.destroy())
  docs.splice(0).forEach(doc => doc.destroy())
})

describe('ConflictManager', () => {
  it('groups concurrent replacements of different words in the same paragraph into one conflict', () => {
    const pair = createPair('Hello world, welcome to TSG.')
    makeEdit(pair.a, pair.managerA, 'Hello everyone, welcome to TSG.', 0, 'paragraph-y-1')
    makeEdit(pair.b, pair.managerB, 'Hello developers, welcome to TSG.', 0, 'paragraph-y-1')
    exchange(pair)
    expect(pair.managerA.getSnapshot().conflicts).toHaveLength(1)
    expect(pair.managerB.getSnapshot().conflicts).toHaveLength(1)
    const conflict = pair.managerA.getSnapshot().conflicts[0]!
    expect([conflict.versionA, conflict.versionB]).toEqual(expect.arrayContaining([
      'Hello everyone, welcome to TSG.', 'Hello developers, welcome to TSG.',
    ]))
    expect(pair.managerB.getSnapshot().conflicts[0]).toEqual(conflict)
  })

  it('combines many character transactions from one editing episode into one paragraph conflict', () => {
    const pair = createPair('Hello world, welcome to TSG.')
    typeByCharacter(pair.a, pair.managerA, 'Hello everyone, welcome to TSG.', 'paragraph-y-1')
    typeByCharacter(pair.b, pair.managerB, 'Hello developers, welcome to TSG.', 'paragraph-y-1')
    exchange(pair)
    expect(pair.managerA.getSnapshot().conflicts).toHaveLength(1)
    expect(pair.managerB.getSnapshot().conflicts).toHaveLength(1)
    expect(pair.managerA.getSnapshot().conflicts[0]?.intentIds.length).toBeGreaterThan(2)
  })

  it('groups multiple insertions and deletions within a paragraph as one conflict', () => {
    const pair = createPair('abcdef ghijkl')
    editInPieces(pair.a, pair.managerA, 'abXcd fghjkl', 'paragraph-y-1')
    editInPieces(pair.b, pair.managerB, 'abcde Yhijkl', 'paragraph-y-1')
    exchange(pair)
    expect(pair.managerA.getSnapshot().conflicts).toHaveLength(1)
    expect(pair.managerB.getSnapshot().conflicts).toHaveLength(1)
  })

  it('keeps independent paragraph edits conflict-free and tracks genuinely conflicting paragraphs separately', () => {
    const pair = createPair('First paragraph\nSecond paragraph')
    makeEdit(pair.a, pair.managerA, 'First paragraph edited\nSecond paragraph', 0, 'paragraph-y-1')
    makeEdit(pair.b, pair.managerB, 'First paragraph\nSecond paragraph edited', 1, 'paragraph-y-2')
    exchange(pair)
    expect(pair.managerA.getSnapshot().unresolvedCount).toBe(0)

    const second = createPair('First paragraph\nSecond paragraph')
    makeEdit(second.a, second.managerA, 'First paragraph A\nSecond paragraph', 0, 'paragraph-y-1')
    makeEdit(second.a, second.managerA, 'First paragraph A\nSecond paragraph A', 1, 'paragraph-y-2')
    makeEdit(second.b, second.managerB, 'First paragraph B\nSecond paragraph', 0, 'paragraph-y-1')
    makeEdit(second.b, second.managerB, 'First paragraph B\nSecond paragraph B', 1, 'paragraph-y-2')
    exchange(second)
    expect(second.managerA.getSnapshot().unresolvedCount).toBe(2)
  })

  it('deduplicates repeated and out-of-order update replay', () => {
    const pair = createPair('hello world')
    makeEdit(pair.a, pair.managerA, 'hullo world', 0, 'paragraph-y-1')
    makeEdit(pair.b, pair.managerB, 'hallo world', 0, 'paragraph-y-1')
    const updateA = Y.encodeStateAsUpdate(pair.a)
    const updateB = Y.encodeStateAsUpdate(pair.b)
    Y.applyUpdate(pair.a, updateB)
    Y.applyUpdate(pair.b, updateA)
    Y.applyUpdate(pair.a, updateB)
    Y.applyUpdate(pair.b, updateA)
    expect(pair.managerA.getSnapshot().conflicts).toHaveLength(1)
    expect(pair.managerB.getSnapshot().conflicts).toHaveLength(1)
  })

  it('persists an unresolved grouped conflict and keeps its identity after recovery and replay', () => {
    const pair = createPair('Hello world, welcome to TSG.')
    typeByCharacter(pair.a, pair.managerA, 'Hello everyone, welcome to TSG.', 'paragraph-y-1')
    typeByCharacter(pair.b, pair.managerB, 'Hello developers, welcome to TSG.', 'paragraph-y-1')
    exchange(pair)
    const original = pair.managerA.getSnapshot().conflicts[0]!
    const recovered = new Y.Doc()
    docs.push(recovered)
    Y.applyUpdate(recovered, Y.encodeStateAsUpdate(pair.a))
    const manager = new ConflictManager(recovered, { id: 'recovery', name: 'Recovery' }, 'doc-1')
    manager.start()
    managers.push(manager)
    Y.applyUpdate(recovered, Y.encodeStateAsUpdate(pair.b))
    expect(manager.getSnapshot().conflicts).toHaveLength(1)
    expect(manager.getSnapshot().conflicts[0]?.id).toBe(original.id)
  })

  it('synchronizes one resolution and never recreates the resolved conflict on replay', () => {
    const pair = createPair('hello world')
    makeEdit(pair.a, pair.managerA, 'hullo world', 0, 'paragraph-y-1')
    makeEdit(pair.b, pair.managerB, 'hallo world', 0, 'paragraph-y-1')
    exchange(pair)
    const conflict = pair.managerA.getSnapshot().conflicts[0]!
    const resolution = 'combined hello world'
    pair.managerA.resolve(conflict.id, 'custom', resolution, () => true)
    const resolved = Y.encodeStateAsUpdate(pair.a)
    Y.applyUpdate(pair.b, resolved)
    Y.applyUpdate(pair.a, Y.encodeStateAsUpdate(pair.b))
    Y.applyUpdate(pair.a, resolved)
    expect(pair.managerA.getSnapshot().conflicts).toHaveLength(1)
    expect(pair.managerB.getSnapshot().conflicts).toHaveLength(1)
    expect(pair.managerB.getSnapshot().conflicts[0]).toMatchObject({ status: 'resolved', resolvedText: resolution })
  })

  it('consolidates legacy pairwise records while retaining their resolution history', () => {
    const pair = createPair('hello world')
    makeEdit(pair.a, pair.managerA, 'hullo world', 0, 'paragraph-y-1')
    makeEdit(pair.b, pair.managerB, 'hallo world', 0, 'paragraph-y-1')
    exchange(pair)
    const conflict = pair.managerA.getSnapshot().conflicts[0]!
    const legacy = pair.a.getMap<ConflictRecord>('tsg-conflict-records-v1')
    for (let index = 0; index < 8; index += 1) legacy.set(`legacy-${index}`, {
      ...conflict, id: `legacy-${index}`, intentIds: conflict.intentIds.slice(index % conflict.intentIds.length, index % conflict.intentIds.length + 2),
      status: 'unresolved',
    })
    legacy.set('legacy-resolved', { ...conflict, id: 'legacy-resolved', status: 'resolved', resolution: 'version-a', resolvedText: conflict.versionA, resolvedAt: Date.now() })
    const recovered = new Y.Doc()
    docs.push(recovered)
    Y.applyUpdate(recovered, Y.encodeStateAsUpdate(pair.a))
    const manager = new ConflictManager(recovered, { id: 'recovery', name: 'Recovery' }, 'doc-1')
    manager.start()
    managers.push(manager)
    expect(manager.getSnapshot().conflicts).toHaveLength(1)
    expect(manager.getSnapshot().conflicts[0]).toMatchObject({ status: 'resolved', resolvedText: conflict.versionA })
  })
})

function createPair(seed: string) {
  const a = new Y.Doc()
  const b = new Y.Doc()
  docs.push(a, b)
  a.getText('content').insert(0, seed)
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  const managerA = new ConflictManager(a, { id: 'user-a', name: 'User A' }, 'doc-1')
  const managerB = new ConflictManager(b, { id: 'user-b', name: 'User B' }, 'doc-1')
  managerA.start()
  managerB.start()
  managers.push(managerA, managerB)
  return { a, b, managerA, managerB, textA: a.getText('content'), textB: b.getText('content') }
}

function makeEdit(doc: Y.Doc, manager: ConflictManager, after: string, blockIndex: number, blockId: string): void {
  const text = doc.getText('content')
  const before = text.toString()
  const beforeVector = vector(doc)
  replaceText(text, after)
  manager.recordLocalEdit(context(beforeVector, before, blockIndex, blockId), context(beforeVector, after, blockIndex, blockId).blocks)
}

function typeByCharacter(doc: Y.Doc, manager: ConflictManager, target: string, blockId: string): void {
  const text = doc.getText('content')
  const base = text.toString()
  const prefix = commonPrefix(base, target)
  const suffix = commonSuffix(base, target, prefix)
  for (let count = 0; count < target.length - prefix - suffix; count += 1) {
    const before = text.toString()
    const beforeVector = vector(doc)
    const changedLength = before.length - prefix - suffix
    if (changedLength) text.delete(prefix, changedLength)
    const nextChar = target.slice(prefix, prefix + count + 1)
    if (nextChar) text.insert(prefix, nextChar)
    const after = text.toString()
    manager.recordLocalEdit(context(beforeVector, before, 0, blockId), [block(after, 0, blockId)])
  }
}

function editInPieces(doc: Y.Doc, manager: ConflictManager, target: string, blockId: string): void {
  typeByCharacter(doc, manager, target, blockId)
}

function context(beforeVector: Record<string, number>, text: string, index: number, blockId: string): LocalEditContext {
  const lines = text.split('\n')
  return { beforeVector, blocks: lines.map((line, lineIndex) => block(line, lineIndex, lineIndex === index ? blockId : `paragraph-${lineIndex}`)) }
}

function block(text: string, index: number, blockId: string) {
  return { blockId, index, text, json: { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] } }
}

function vector(doc: Y.Doc): Record<string, number> {
  return Object.fromEntries([...Y.decodeStateVector(Y.encodeStateVector(doc)).entries()].map(([client, clock]) => [String(client), clock]))
}

function exchange(pair: ReturnType<typeof createPair>): void {
  Y.applyUpdate(pair.a, Y.encodeStateAsUpdate(pair.b))
  Y.applyUpdate(pair.b, Y.encodeStateAsUpdate(pair.a))
}

function replaceText(text: Y.Text, replacement: string): void {
  if (text.length) text.delete(0, text.length)
  if (replacement) text.insert(0, replacement)
}

function commonPrefix(left: string, right: string): number {
  let index = 0
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1
  return index
}

function commonSuffix(left: string, right: string, prefix: number): number {
  let count = 0
  while (count < left.length - prefix && count < right.length - prefix && left[left.length - count - 1] === right[right.length - count - 1]) count += 1
  return count
}
