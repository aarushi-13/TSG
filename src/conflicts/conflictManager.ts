import * as Y from 'yjs'

export type EditAuthor = { id: string; name: string }
export type CausalVector = Record<string, number>

export type LocalEditContext = {
  beforeVector: CausalVector
  blocks: Array<{ blockId: string; index: number; text: string; json: Record<string, unknown> }>
}

export type ConflictEditIntent = {
  id: string
  blockId: string
  clientId: number
  author: EditAuthor
  createdAt: number
  baseVector: CausalVector
  afterVector: CausalVector
  blockIndex: number
  baseBlock: string
  resultBlock: string
  baseContent?: Record<string, unknown>
  resultContent?: Record<string, unknown>
  start: number
  end: number
  crossedBlock: boolean
}

export type ConflictRecord = {
  id: string
  intentIds: string[]
  authors: [EditAuthor, EditAuthor]
  createdAt: number
  blockIndex: number
  blockId: string
  scope: 'paragraph'
  baseVersion: string
  baseContent?: Record<string, unknown>
  versionA: string
  versionB: string
  versionAContent?: Record<string, unknown>
  versionBContent?: Record<string, unknown>
  confidence: 'overlap' | 'uncertain'
  status: 'unresolved' | 'resolved'
  resolvedText?: string
  resolvedContent?: Record<string, unknown>
  resolution?: 'version-a' | 'version-b' | 'custom'
  resolvedBy?: EditAuthor
  resolvedAt?: number
}

export type ConflictSnapshot = { conflicts: ConflictRecord[]; unresolvedCount: number; intentCount: number }

const INTENTS_NAME = 'tsg-conflict-edit-intents-v1'
const CONFLICTS_NAME = 'tsg-conflict-records-v2'
const LEGACY_CONFLICTS_NAME = 'tsg-conflict-records-v1'
const LEGACY_BLOCK_ALIASES_NAME = 'tsg-conflict-block-aliases-v1'

export class ConflictManager {
  private readonly intents: Y.Array<ConflictEditIntent>
  private readonly records: Y.Map<ConflictRecord>
  private readonly legacyRecords: Y.Map<ConflictRecord>
  private readonly legacyBlockAliases: Y.Map<string>
  private readonly listeners = new Set<() => void>()
  private suppressed = false
  private snapshot: ConflictSnapshot
  private sequence = 0
  private started = false
  private readonly observer = () => {
    this.detectConflicts()
    this.refresh()
  }
  private readonly aliasesObserver = () => { this.detectConflicts(); this.refresh() }

  constructor(readonly doc: Y.Doc, readonly author: EditAuthor, readonly documentId = 'unknown-document') {
    this.intents = doc.getArray<ConflictEditIntent>(INTENTS_NAME)
    this.records = doc.getMap<ConflictRecord>(CONFLICTS_NAME)
    this.legacyRecords = doc.getMap<ConflictRecord>(LEGACY_CONFLICTS_NAME)
    this.legacyBlockAliases = doc.getMap<string>(LEGACY_BLOCK_ALIASES_NAME)
    this.snapshot = this.buildSnapshot()
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.intents.observe(this.observer)
    this.records.observe(this.observer)
    this.legacyBlockAliases.observe(this.aliasesObserver)
    this.detectConflicts()
    this.refresh()
  }

  getSnapshot = (): ConflictSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  bindLegacyBlock(blockIndex: number, blockId: string): void {
    const key = `legacy-block:${blockIndex}`
    if (!this.intents.toArray().some(intent => intent.blockId === key || (intent.blockId === undefined && intent.blockIndex === blockIndex))) return
    if (this.legacyBlockAliases.get(key) === blockId) return
    this.doc.transact(() => this.legacyBlockAliases.set(key, blockId), this)
  }

  recordLocalEdit(context: LocalEditContext, afterBlocks: Array<{ blockId: string; index: number; text: string; json: Record<string, unknown> }>): void {
    if (this.suppressed) return
    const currentById = new Map(afterBlocks.map(block => [block.blockId, block]))
    const afterVector = vectorToObject(Y.decodeStateVector(Y.encodeStateVector(this.doc)))
    const edits: ConflictEditIntent[] = []
    for (const baseBlock of context.blocks) {
      const resultBlock = currentById.get(baseBlock.blockId)
      const resultText = resultBlock?.text ?? ''
      const resultContent = resultBlock?.json ?? { ...baseBlock.json, content: [] }
      if (baseBlock.text === resultText && JSON.stringify(baseBlock.json) === JSON.stringify(resultContent)) continue
      const changed = diffRange(baseBlock.text, resultText)
      edits.push({
        id: `${this.doc.clientID}:${++this.sequence}:${Date.now().toString(36)}`,
        blockId: baseBlock.blockId,
        clientId: this.doc.clientID,
        author: this.author,
        createdAt: Date.now(),
        baseVector: context.beforeVector,
        afterVector,
        blockIndex: baseBlock.index,
        baseBlock: baseBlock.text,
        resultBlock: resultText,
        baseContent: baseBlock.json,
        resultContent,
        start: changed.start,
        end: changed.end,
        crossedBlock: false,
      })
    }
    if (edits.length) this.doc.transact(() => this.intents.push(edits), this)
  }

  resolve(
    conflictId: string,
    resolution: 'version-a' | 'version-b' | 'custom',
    resolvedText: string,
    applyToEditor: () => boolean,
    resolvedContent?: Record<string, unknown>,
  ): boolean {
    const current = this.records.get(conflictId)
    if (!current || current.status === 'resolved') return false
    this.suppressed = true
    try {
      if (!applyToEditor()) return false
      this.doc.transact(() => this.records.set(conflictId, {
        ...current,
        status: 'resolved',
        resolution,
        resolvedText,
        ...(resolvedContent ? { resolvedContent } : {}),
        resolvedBy: this.author,
        resolvedAt: Date.now(),
      }), this)
      return true
    } finally {
      this.suppressed = false
    }
  }

  runWithoutRecording(operation: () => void): void {
    this.suppressed = true
    try { operation() } finally { this.suppressed = false }
  }

  destroy(): void {
    if (!this.started) return
    this.started = false
    this.intents.unobserve(this.observer)
    this.records.unobserve(this.observer)
    this.legacyBlockAliases.unobserve(this.aliasesObserver)
    this.listeners.clear()
  }

  private detectConflicts(): void {
    const intents = this.intents.toArray().map(normalizeIntent)
    const byBlock = new Map<string, ConflictEditIntent[]>()
    for (const intent of intents) {
      const rawBlockId = intent.blockId || `legacy-block:${intent.blockIndex}`
      const blockId = this.legacyBlockAliases.get(rawBlockId) ?? rawBlockId
      const blockIntents = byBlock.get(blockId) ?? []
      blockIntents.push({ ...intent, blockId })
      byBlock.set(blockId, blockIntents)
    }

    const grouped = new Map<string, ConflictEditIntent[]>()
    for (const blockIntents of byBlock.values()) {
      const clients = [...new Set(blockIntents.map(intent => intent.clientId))].sort((a, b) => a - b)
      for (let leftClient = 0; leftClient < clients.length; leftClient += 1) {
        for (let rightClient = leftClient + 1; rightClient < clients.length; rightClient += 1) {
          const pair = blockIntents.filter(intent => intent.clientId === clients[leftClient] || intent.clientId === clients[rightClient])
          const sets = new DisjointSet(pair.length)
          for (let left = 0; left < pair.length; left += 1) {
            for (let right = left + 1; right < pair.length; right += 1) {
              if (pair[left]!.clientId !== pair[right]!.clientId && areConcurrent(pair[left]!, pair[right]!)) sets.union(left, right)
            }
          }
          for (const component of sets.components()) {
            const edits = component.map(index => pair[index]!)
            if (new Set(edits.map(edit => edit.clientId)).size !== 2) continue
            const firstId = edits.slice().sort(compareIntentOrder)[0]!.id
            const key = `${edits[0]!.blockId}|${clients[leftClient]}|${clients[rightClient]}|${firstId}`
            const prior = grouped.get(key) ?? []
            grouped.set(key, [...new Map([...prior, ...edits].map(edit => [edit.id, edit])).values()])
          }
        }
      }
    }

    const candidates: ConflictRecord[] = []
    for (const edits of grouped.values()) {
      const byClient = [...new Set(edits.map(edit => edit.clientId))].sort((a, b) => a - b).map(clientId =>
        edits.filter(edit => edit.clientId === clientId).sort(compareIntentOrder))
      if (byClient.length !== 2) continue
      const earliest = byClient.map(group => group[0]!) as [ConflictEditIntent, ConflictEditIntent]
      const latest = byClient.map(group => group[group.length - 1]!) as [ConflictEditIntent, ConflictEditIntent]
      if (latest[0]!.resultBlock === latest[1]!.resultBlock
        && JSON.stringify(latest[0]!.resultContent) === JSON.stringify(latest[1]!.resultContent)) continue
      const firstIds = earliest.map(edit => edit.id).sort()
      const blockId = latest[0]!.blockId
      const id = `conflict-v2:${encodeURIComponent(this.documentId)}:${encodeURIComponent(blockId)}:${firstIds.map(encodeURIComponent).join(':')}`
      const legacy = [...this.legacyRecords.values()]
        .filter(record => record.intentIds.every(intentId => edits.some(edit => edit.id === intentId)))
        .filter(record => record.status === 'resolved')
        .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))[0]
      const existing = this.records.get(id)
      const chosen = existing?.status === 'resolved' ? existing : null
      candidates.push({
        id,
        intentIds: [...new Set(edits.map(edit => edit.id))].sort(),
        authors: latest.map(edit => edit.author) as [EditAuthor, EditAuthor],
        createdAt: Math.min(...earliest.map(edit => edit.createdAt)),
        blockIndex: latest[0]!.blockIndex,
        blockId,
        scope: 'paragraph',
        baseVersion: earliest[0]!.baseBlock,
        baseContent: earliest[0]!.baseContent,
        versionA: latest[0]!.resultBlock,
        versionB: latest[1]!.resultBlock,
        versionAContent: latest[0]!.resultContent,
        versionBContent: latest[1]!.resultContent,
        confidence: 'overlap',
        status: chosen ? 'resolved' : legacy ? 'resolved' : 'unresolved',
        ...(chosen ? {
          resolvedText: chosen.resolvedText,
          resolvedContent: chosen.resolvedContent,
          resolution: chosen.resolution,
          resolvedBy: chosen.resolvedBy,
          resolvedAt: chosen.resolvedAt,
        } : legacy ? {
          resolvedText: legacy.resolvedText,
          resolvedContent: legacy.resolvedContent,
          resolution: legacy.resolution,
          resolvedBy: legacy.resolvedBy,
          resolvedAt: legacy.resolvedAt,
        } : {}),
      })
    }

    if (candidates.length) this.doc.transact(() => {
      for (const conflict of candidates) {
        const existing = this.records.get(conflict.id)
        if (existing?.status === 'resolved') continue
        if (!existing || JSON.stringify(existing) !== JSON.stringify(conflict)) this.records.set(conflict.id, conflict)
      }
    }, this)
  }

  private buildSnapshot(): ConflictSnapshot {
    const conflicts = [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    return { conflicts, unresolvedCount: conflicts.filter(conflict => conflict.status === 'unresolved').length, intentCount: this.intents.length }
  }

  private refresh(): void {
    const next = this.buildSnapshot()
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return
    this.snapshot = next
    this.listeners.forEach(listener => listener())
  }
}

function vectorToObject(vector: Map<number, number>): CausalVector {
  return Object.fromEntries([...vector.entries()].map(([client, clock]) => [String(client), clock]))
}

function hasObserved(vector: CausalVector, target: CausalVector): boolean {
  return Object.entries(target).every(([client, clock]) => (vector[client] ?? 0) >= clock)
}

function areConcurrent(a: ConflictEditIntent, b: ConflictEditIntent): boolean {
  return !hasObserved(a.baseVector, b.afterVector) && !hasObserved(b.baseVector, a.afterVector)
}

function diffRange(before: string, after: string): { start: number; end: number; newEnd: number } {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1
  let suffix = 0
  while (suffix < before.length - start && suffix < after.length - start && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1
  return { start, end: before.length - suffix, newEnd: after.length - suffix }
}

function normalizeIntent(intent: ConflictEditIntent): ConflictEditIntent {
  return { ...intent, blockId: intent.blockId || `legacy-block:${intent.blockIndex}` }
}

function compareIntentOrder(left: ConflictEditIntent, right: ConflictEditIntent): number {
  if (left.clientId === right.clientId) {
    const leftSeq = Number(left.id.split(':')[1])
    const rightSeq = Number(right.id.split(':')[1])
    if (Number.isFinite(leftSeq) && Number.isFinite(rightSeq) && leftSeq !== rightSeq) return leftSeq - rightSeq
  }
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}

class DisjointSet {
  private readonly parents: number[]

  constructor(size: number) { this.parents = Array.from({ length: size }, (_, index) => index) }

  private root(index: number): number {
    const parent = this.parents[index]!
    if (parent !== index) this.parents[index] = this.root(parent)
    return this.parents[index]!
  }

  union(left: number, right: number): void {
    const leftRoot = this.root(left)
    const rightRoot = this.root(right)
    if (leftRoot !== rightRoot) this.parents[rightRoot] = leftRoot
  }

  components(): number[][] {
    const result = new Map<number, number[]>()
    this.parents.forEach((_, index) => {
      const root = this.root(index)
      const members = result.get(root) ?? []
      members.push(index)
      result.set(root, members)
    })
    return [...result.values()]
  }
}
