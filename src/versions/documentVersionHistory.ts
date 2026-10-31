import type { JSONContent } from '@tiptap/core'
import * as Y from 'yjs'

export type DocumentVersion = {
  id: string
  name: string
  summary: string
  content: JSONContent
  author: { id: string; name: string }
  createdAt: number
  kind: 'baseline' | 'automatic' | 'manual' | 'restore'
  restoredFrom?: string
}

export type VersionCheckpointPolicy = {
  /** Quiet period after the last local editor transaction before an automatic checkpoint. */
  quietPeriodMs: number
  /** Minimum time between automatic checkpoints. */
  minimumAutomaticIntervalMs: number
  /** Text edits this large, or edits across this many blocks, count as substantial. */
  minimumChangedCharacters: number
  minimumChangedBlocks: number
  /** Near-identical snapshots within this text delta are treated as duplicates. */
  duplicateTextTolerance: number
}

export const DEFAULT_VERSION_CHECKPOINT_POLICY: Readonly<VersionCheckpointPolicy> = {
  quietPeriodMs: 30_000,
  minimumAutomaticIntervalMs: 5 * 60_000,
  minimumChangedCharacters: 80,
  minimumChangedBlocks: 2,
  duplicateTextTolerance: 8,
}

const VERSION_MAP = 'tsg-document-versions-v1'
const BASELINE_ID = 'baseline'

/**
 * Version history is metadata inside the document's existing Y.Doc, separate from
 * both the TipTap fragment and conflict records. Yjs/y-indexeddb/y-webrtc therefore
 * provide the existing persistence and synchronization paths without a second doc.
 */
export class DocumentVersionHistory {
  private readonly versions: Y.Map<DocumentVersion>
  private readonly listeners = new Set<() => void>()
  private snapshot: DocumentVersion[]
  private timer: ReturnType<typeof setTimeout> | undefined
  private started = false
  private lastAutomaticAt = 0
  private readonly observer = () => this.refresh()

  constructor(
    readonly doc: Y.Doc,
    readonly author: { id: string; name: string },
    private readonly policy: VersionCheckpointPolicy = DEFAULT_VERSION_CHECKPOINT_POLICY,
  ) {
    this.versions = doc.getMap<DocumentVersion>(VERSION_MAP)
    this.snapshot = this.sorted()
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.versions.observe(this.observer)
  }

  getSnapshot = (): DocumentVersion[] => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Called only for local TipTap transactions. Remote peer updates never create checkpoints. */
  recordLocalEdit(before: JSONContent, after: JSONContent, readCurrentContent: () => JSONContent = () => after): void {
    if (!this.started) return
    this.ensureBaseline(before)
    if (this.timer) clearTimeout(this.timer)
    const delay = Math.max(this.policy.quietPeriodMs, this.policy.minimumAutomaticIntervalMs - (Date.now() - this.lastAutomaticAt))
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.createAutomatic(readCurrentContent())
    }, delay)
  }

  createNamedVersion(name: string, content: JSONContent): DocumentVersion | null {
    const normalizedName = name.trim().slice(0, 100)
    if (!normalizedName) return null
    return this.create('manual', normalizedName, content)
  }

  createRestoreVersion(content: JSONContent, restoredFrom: DocumentVersion): DocumentVersion {
    const restored = this.create('restore', `Restored “${restoredFrom.name}”`, content, true, restoredFrom.id)
    if (!restored) throw new Error('Could not create the restore history entry.')
    return restored
  }

  /** Remove only the selected snapshot. The current live document is never touched. */
  deleteVersion(versionId: string, currentContent: JSONContent): boolean {
    if (!this.started) return false
    const version = this.versions.get(versionId)
    if (!version || JSON.stringify(version.content) === JSON.stringify(currentContent)) return false
    this.doc.transact(() => this.versions.delete(versionId), this)
    return true
  }

  destroy(): void {
    if (!this.started) return
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.versions.unobserve(this.observer)
    this.listeners.clear()
  }

  private ensureBaseline(content: JSONContent): void {
    if (this.versions.has(BASELINE_ID)) return
    const baseline: DocumentVersion = {
      id: BASELINE_ID,
      name: 'Starting version',
      summary: 'Document before the first editing session',
      content: cloneContent(content),
      author: this.author,
      createdAt: Date.now(),
      kind: 'baseline',
    }
    this.doc.transact(() => {
      if (!this.versions.has(BASELINE_ID)) this.versions.set(BASELINE_ID, baseline)
    }, this)
  }

  private createAutomatic(content: JSONContent): void {
    const latest = this.sorted().at(-1)
    const baseline = latest?.content
    if (!baseline || !isMeaningfulChange(baseline, content, this.policy)) return
    const version = this.create('automatic', 'Editing session', content)
    if (version) this.lastAutomaticAt = Date.now()
  }

  private create(
    kind: DocumentVersion['kind'],
    name: string,
    content: JSONContent,
    force = false,
    restoredFrom?: string,
  ): DocumentVersion | null {
    if (!this.started) return null
    const copied = cloneContent(content)
    const duplicate = this.sorted().find(version => areNearDuplicates(version.content, copied, this.policy.duplicateTextTolerance))
    if (duplicate && !force) return null
    const id = `${this.doc.clientID}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`
    const version: DocumentVersion = {
      id, name, summary: name, content: copied, author: this.author,
      createdAt: Date.now(), kind,
      ...(restoredFrom ? { restoredFrom } : {}),
    }
    this.doc.transact(() => this.versions.set(id, version), this)
    return version
  }

  private sorted(): DocumentVersion[] {
    return [...this.versions.values()].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  }

  private refresh(): void {
    const next = this.sorted()
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

function cloneContent(content: JSONContent): JSONContent {
  return JSON.parse(JSON.stringify(content)) as JSONContent
}

function isMeaningfulChange(before: JSONContent, after: JSONContent, policy: VersionCheckpointPolicy): boolean {
  if (JSON.stringify(before) === JSON.stringify(after)) return false
  if (textDelta(before, after) >= policy.minimumChangedCharacters) return true
  if (changedBlockCount(before, after) >= policy.minimumChangedBlocks) return true
  return formattingStructure(before) !== formattingStructure(after)
}

function areNearDuplicates(left: JSONContent, right: JSONContent, tolerance: number): boolean {
  if (JSON.stringify(left) === JSON.stringify(right)) return true
  return formattingStructure(left) === formattingStructure(right) && textDelta(left, right) <= tolerance
}

function textDelta(left: JSONContent, right: JSONContent): number {
  const a = plainText(left)
  const b = plainText(right)
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix += 1
  return (a.length - prefix - suffix) + (b.length - prefix - suffix)
}

function plainText(content: JSONContent): string {
  const parts: string[] = []
  const visit = (node: JSONContent) => {
    if (typeof node.text === 'string') parts.push(node.text)
    else if (node.type === 'hardBreak') parts.push('\n')
    node.content?.forEach(visit)
    if (node.type === 'paragraph' || node.type?.startsWith('heading')) parts.push('\n')
  }
  visit(content)
  return parts.join('')
}

function changedBlockCount(before: JSONContent, after: JSONContent): number {
  const left = textBlocks(before)
  const right = textBlocks(after)
  let changed = Math.abs(left.length - right.length)
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) changed += 1
  }
  return changed
}

function textBlocks(content: JSONContent): string[] {
  const blocks: string[] = []
  const visit = (node: JSONContent) => {
    if (node.type === 'paragraph' || node.type?.startsWith('heading')) blocks.push(JSON.stringify(node))
    else node.content?.forEach(visit)
  }
  visit(content)
  return blocks
}

function formattingStructure(content: JSONContent): string {
  const parts: unknown[] = []
  const visit = (node: JSONContent) => {
    parts.push({ type: node.type, attrs: node.attrs, marks: node.marks })
    node.content?.forEach(visit)
  }
  visit(content)
  return JSON.stringify(parts)
}
