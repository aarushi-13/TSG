import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { JSONContent } from '@tiptap/core'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { AlignCenter, AlignLeft, AlignRight, ArrowLeft, Bold, Check, Code2, Heading1, Heading2, Italic, Link2, List as ListIcon, ListChecks, ListOrdered, LoaderCircle, Minus, Quote, Redo2, Share2, Sparkles, Strikethrough, Table2, Underline, Undo2, WifiOff } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { DocumentRecord } from '../documents/types'
import { createEditorExtensions } from './extensions'
import { initializeSharedContent, readSharedContent } from '../crdt/document'
import { documentYjsStore, type YjsDocumentSession } from '../persistence/yjsStore'
import { getLocalCollaborator } from '../networking/config'
import { peerProviderStore, type PeerNetworkSession } from '../networking/peerProvider'
import { ConflictManager, type ConflictRecord } from '../conflicts/conflictManager'
import { consumeLocalEditContext } from './extensions'
import { adoptBlockIdentity, getRichTextBlocks } from '../conflicts/blockIdentity'
import { DocumentVersionHistory } from '../versions/documentVersionHistory'
import { VersionHistoryPanel } from '../versions/VersionHistoryPanel'
import SummaryPanel from '../ai/SummaryPanel'
import { extractDocumentText } from '../ai/documentText'

type Props = { document: DocumentRecord; onSave: (patch: Pick<Partial<DocumentRecord>, 'title' | 'content'>) => Promise<boolean> }

/** Shortest document the summarizer accepts, matching the server-side floor. */
const MIN_SUMMARY_CHARACTERS = 20

const OFFLINE_SUMMARY_HINT = 'Summaries need an internet connection'

/** Tracks browser connectivity for the summarizer only; peer sync has its own offline handling. */
function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    update()
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
}

function safeHref(input: string): string | null {
  try {
    const url = new URL(input.trim(), window.location.origin)
    if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:') return input.trim()
    return null
  } catch { return null }
}

function Toolbar({ editor }: { editor: Editor }) {
  const active = useEditorState({ editor, selector: ({ editor: current }) => ({
    bold: current.isActive('bold'), italic: current.isActive('italic'), underline: current.isActive('underline'),
    strike: current.isActive('strike'), bullet: current.isActive('bulletList'), ordered: current.isActive('orderedList'),
    task: current.isActive('taskList'), quote: current.isActive('blockquote'), code: current.isActive('codeBlock'),
    heading: current.isActive('heading', { level: 1 }) ? 'h1' : current.isActive('heading', { level: 2 }) ? 'h2' : 'p',
    align: current.getAttributes('paragraph').textAlign ?? current.getAttributes('heading').textAlign ?? 'left',
    canUndo: current.can().undo(), canRedo: current.can().redo(),
  }) })
  const toggle = (label: string, isActive: boolean, action: () => void, disabled = false) => (
    <button type="button" className={`toolbar-button ${isActive ? 'is-active' : ''}`} aria-label={label} title={label} aria-pressed={isActive} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={action}>{iconFor(label)}</button>
  )
  const setLink = () => {
    const current = editor.getAttributes('link').href as string | undefined
    const value = window.prompt('Paste a link (https:// or mailto:)', current ?? 'https://')
    if (value === null) return
    const href = safeHref(value)
    if (!href) { window.alert('Please use a valid http, https, or mailto link.'); return }
    editor.chain().focus().extendMarkRange('link').setLink({ href, target: '_blank', rel: 'noopener noreferrer' }).run()
  }
  return <div className="editor-toolbar" role="toolbar" aria-label="Text formatting">
    {toggle('Undo', false, () => editor.chain().focus().undo().run(), !active?.canUndo)}
    {toggle('Redo', false, () => editor.chain().focus().redo().run(), !active?.canRedo)}
    <span className="toolbar-divider"/>
    <select aria-label="Text style" className="style-select" value={active?.heading ?? 'p'} onChange={event => {
      const value = event.target.value
      if (value === 'p') editor.chain().focus().setParagraph().run()
      else editor.chain().focus().toggleHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 }).run()
    }}>
      <option value="p">Paragraph</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option>
    </select>
    <span className="toolbar-divider"/>
    {toggle('Bold', !!active?.bold, () => editor.chain().focus().toggleBold().run())}
    {toggle('Italic', !!active?.italic, () => editor.chain().focus().toggleItalic().run())}
    {toggle('Underline', !!active?.underline, () => editor.chain().focus().toggleUnderline().run())}
    {toggle('Strikethrough', !!active?.strike, () => editor.chain().focus().toggleStrike().run())}
    {toggle('Add link', editor.isActive('link'), setLink)}
    <span className="toolbar-divider"/>
    {toggle('Align left', active?.align === 'left', () => editor.chain().focus().setTextAlign('left').run())}
    {toggle('Align center', active?.align === 'center', () => editor.chain().focus().setTextAlign('center').run())}
    {toggle('Align right', active?.align === 'right', () => editor.chain().focus().setTextAlign('right').run())}
    <span className="toolbar-divider"/>
    {toggle('Bulleted list', !!active?.bullet, () => editor.chain().focus().toggleBulletList().run())}
    {toggle('Numbered list', !!active?.ordered, () => editor.chain().focus().toggleOrderedList().run())}
    {toggle('Checklist', !!active?.task, () => editor.chain().focus().toggleTaskList().run())}
    <span className="toolbar-divider"/>
    {toggle('Blockquote', !!active?.quote, () => editor.chain().focus().toggleBlockquote().run())}
    {toggle('Code block', !!active?.code, () => editor.chain().focus().toggleCodeBlock().run())}
    {toggle('Insert table', false, () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
  </div>
}

function iconFor(label: string) {
  const props = { size: 15, strokeWidth: 1.8 }
  switch (label) {
    case 'Undo': return <Undo2 {...props}/>; case 'Redo': return <Redo2 {...props}/>; case 'Bold': return <Bold {...props}/>;
    case 'Italic': return <Italic {...props}/>; case 'Underline': return <Underline {...props}/>; case 'Strikethrough': return <Strikethrough {...props}/>;
    case 'Add link': return <Link2 {...props}/>; case 'Align left': return <AlignLeft {...props}/>; case 'Align center': return <AlignCenter {...props}/>;
    case 'Align right': return <AlignRight {...props}/>; case 'Bulleted list': return <ListIcon {...props}/>; case 'Numbered list': return <ListOrdered {...props}/>;
    case 'Checklist': return <ListChecks {...props}/>; case 'Blockquote': return <Quote {...props}/>; case 'Code block': return <Code2 {...props}/>;
    case 'Insert table': return <Table2 {...props}/>; case 'Heading 1': return <Heading1 {...props}/>; case 'Heading 2': return <Heading2 {...props}/>;
    default: return <Minus {...props}/>;
  }
}

type InlineJson = { type: string; text?: string; attrs?: Record<string, unknown>; marks?: Array<{ type: string; attrs?: Record<string, unknown> }>; content?: InlineJson[] }

function resolvedBlockJson(conflict: ConflictRecord, resolution: 'version-a' | 'version-b' | 'custom', text: string): Record<string, unknown> | null {
  const source = resolution === 'version-a' ? conflict.versionAContent
    : resolution === 'version-b' ? conflict.versionBContent
      : conflict.baseContent ?? conflict.versionAContent ?? conflict.versionBContent
  if (!source) return null
  return resolution === 'custom' ? customBlockJson(source, text) : source
}

function replaceConflictBlock(editor: Editor, conflict: ConflictRecord, json: Record<string, unknown>): boolean {
  const block = getRichTextBlocks(editor.state).find(candidate => candidate.blockId === conflict.blockId)
  if (!block) return false
  const node = editor.schema.nodeFromJSON(json)
  if (!node.isTextblock) return false
  editor.view.dispatch(editor.state.tr.replaceWith(block.from, block.to, node))
  return true
}

function customBlockJson(source: Record<string, unknown>, customText: string): Record<string, unknown> {
  const content = Array.isArray(source.content) ? source.content as InlineJson[] : []
  const characters: Array<{ text: string; marks?: InlineJson['marks']; atom?: InlineJson }> = []
  const append = (items: InlineJson[]) => items.forEach(item => {
    if (item.type === 'text' && typeof item.text === 'string') {
      for (const char of item.text.split('')) characters.push({ text: char, marks: item.marks })
    } else if (item.type === 'hardBreak') characters.push({ text: '\n', marks: item.marks, atom: item })
    else characters.push({ text: '\u0000', atom: item })
  })
  append(content)
  const oldText = characters.map(character => character.text).join('')
  const common = commonRange(oldText, customText)
  const inheritedMarks = characters[common.start]?.marks ?? characters[Math.max(0, common.start - 1)]?.marks
  const next: Array<{ text: string; marks?: InlineJson['marks']; atom?: InlineJson }> = [
    ...characters.slice(0, common.start),
    ...customText.slice(common.start, customText.length - common.suffix).split('').map(char => ({ text: char, marks: inheritedMarks })),
    ...characters.slice(oldText.length - common.suffix),
  ]
  const nextContent: InlineJson[] = []
  for (const character of next) {
    if (character.atom && character.text === '\u0000') { nextContent.push(character.atom); continue }
    if (character.atom && character.text === '\n') { nextContent.push(character.atom); continue }
    const prior = nextContent[nextContent.length - 1]
    if (prior?.type === 'text' && JSON.stringify(prior.marks ?? []) === JSON.stringify(character.marks ?? [])) prior.text = `${prior.text ?? ''}${character.text}`
    else nextContent.push({ type: 'text', text: character.text, ...(character.marks?.length ? { marks: character.marks } : {}) })
  }
  return { ...source, content: nextContent }
}

function commonRange(before: string, after: string): { start: number; suffix: number } {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1
  let suffix = 0
  while (suffix < before.length - start && suffix < after.length - start && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix += 1
  return { start, suffix }
}

function renderRichText(content: Record<string, unknown> | undefined, fallback: string): ReactNode {
  if (!content || !Array.isArray(content.content)) return fallback || <i>Deleted this text</i>
  const renderNode = (node: InlineJson, index: number): ReactNode => {
    if (node.type === 'hardBreak') return <br key={index}/>
    if (node.type !== 'text') return node.text ?? ''
    let child: ReactNode = node.text ?? ''
    for (const mark of [...(node.marks ?? [])].reverse()) {
      if (mark.type === 'bold') child = <strong key={`${index}-bold`}>{child}</strong>
      else if (mark.type === 'italic') child = <em key={`${index}-italic`}>{child}</em>
      else if (mark.type === 'underline') child = <u key={`${index}-underline`}>{child}</u>
      else if (mark.type === 'strike') child = <s key={`${index}-strike`}>{child}</s>
      else if (mark.type === 'code') child = <code key={`${index}-code`}>{child}</code>
      else if (mark.type === 'link') {
        const href = typeof mark.attrs?.href === 'string' ? safeHref(mark.attrs.href) : null
        if (href) child = <a key={`${index}-link`} href={href} rel="noreferrer">{child}</a>
      }
    }
    return <span key={index}>{child}</span>
  }
  return (content.content as InlineJson[]).map(renderNode)
}

function ConflictReview({ manager, conflicts, editor }: { manager: ConflictManager; conflicts: ConflictRecord[]; editor: Editor }) {
  const [open, setOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [customText, setCustomText] = useState('')
  const [resolutionError, setResolutionError] = useState<string | null>(null)
  const unresolved = conflicts.filter(conflict => conflict.status === 'unresolved')
  const selected = conflicts.find(conflict => conflict.id === selectedId) ?? unresolved[0] ?? null

  const resolve = (conflict: ConflictRecord, choice: 'version-a' | 'version-b' | 'custom', text: string) => {
    const json = resolvedBlockJson(conflict, choice, text)
    if (!json) { setResolutionError('The preserved rich-text paragraph is unavailable. Both original versions remain in conflict history.'); return }
    const applied = manager.resolve(conflict.id, choice, text, () => replaceConflictBlock(editor, conflict, json), json)
    if (!applied) { setResolutionError('The affected paragraph is no longer available at its saved position. Both original versions remain in conflict history.'); return }
    setSelectedId(null)
    setCustomText('')
    setResolutionError(null)
    if (unresolved.length <= 1) setOpen(false)
  }

  return <>
    {conflicts.length > 0 && <button className={`conflict-toggle ${unresolved.length ? 'has-unresolved' : ''}`} type="button" onClick={() => { setOpen(true); setSelectedId(unresolved[0]?.id ?? conflicts[0]?.id ?? null) }} aria-label={`${unresolved.length} unresolved conflicts; open conflict history`}>
      {unresolved.length ? `Review conflicts · ${unresolved.length}` : `Conflict history · ${conflicts.length}`}
    </button>}
    {open && <div className="conflict-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false) }}>
      <section className="conflict-dialog" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
        <header><div><span className="eyebrow">DOCUMENT HISTORY</span><h2 id="conflict-title">Conflict review</h2></div><button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Close conflict review">×</button></header>
        {selected ? <>
          <div className="conflict-summary"><b>{selected.status === 'resolved' ? 'Resolved paragraph conflict' : `Paragraph ${selected.blockIndex + 1} has overlapping edits`}</b><span>{new Date(selected.createdAt).toLocaleString()}</span><small>Both rich-text paragraph versions are preserved. Choose one or write a custom resolution.</small></div>
          {resolutionError && <p role="alert" className="conflict-resolution-error">{resolutionError}</p>}
          <div className="conflict-versions">
            {(['A', 'B'] as const).map((version, index) => {
              const text = index === 0 ? selected.versionA : selected.versionB
              const author = selected.authors[index]
              const richContent = index === 0 ? selected.versionAContent : selected.versionBContent
              return <article key={version}><span>VERSION {version} · {author.name}</span><blockquote>{renderRichText(richContent, text)}</blockquote>{selected.status === 'unresolved' && <button className="button button-light" type="button" onClick={() => resolve(selected, index === 0 ? 'version-a' : 'version-b', text)}>Keep version {version}</button>}</article>
            })}
          </div>
          {selected.status === 'unresolved' ? <div className="conflict-custom"><label htmlFor="conflict-resolution">Or write a custom resolution</label><textarea id="conflict-resolution" rows={4} value={customText} onChange={event => setCustomText(event.target.value)} placeholder="Combine the edits in your own words…"/><button className="button button-dark" type="button" onClick={() => resolve(selected, 'custom', customText)} disabled={!customText.trim()}>Use custom resolution</button><button className="text-link conflict-later" type="button" onClick={() => { setOpen(false); setSelectedId(null) }}>Resolve later</button></div> : <div className="conflict-summary"><b>Resolution: {selected.resolution === 'custom' ? 'Custom' : selected.resolution === 'version-a' ? 'Version A' : 'Version B'}</b><span>By {selected.resolvedBy?.name ?? 'a collaborator'} · {selected.resolvedAt ? new Date(selected.resolvedAt).toLocaleString() : ''}</span><blockquote>{selected.resolvedText}</blockquote></div>}
        </> : <p>No conflict history is available.</p>}
        {conflicts.length > 1 && <nav className="conflict-history" aria-label="Conflict history"><b>Conflict history</b>{conflicts.map(conflict => <button key={conflict.id} type="button" className={conflict.id === selected?.id ? 'selected' : ''} onClick={() => { setSelectedId(conflict.id); setCustomText('') }}><span>{conflict.status === 'resolved' ? 'Resolved' : 'Needs review'}</span><small>{new Date(conflict.createdAt).toLocaleString()} · {conflict.authors.map(author => author.name).join(' and ')}</small></button>)}</nav>}
      </section>
    </div>}
  </>
}

export default function DocumentEditor({ document, onSave }: Props) {
  const [loaded, setLoaded] = useState<{ session: YjsDocumentSession; network: PeerNetworkSession } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const lease = documentYjsStore.acquireDocument(document.id)
    let networkLease: ReturnType<typeof peerProviderStore.acquire> | undefined
    void lease.session.then(async opened => {
      initializeSharedContent(opened, document.content)
      await opened.flush()
      const sharedContent = readSharedContent(opened)
      if (JSON.stringify(sharedContent) !== JSON.stringify(document.content)) await onSave({ content: sharedContent })
      if (!active) return
      networkLease = peerProviderStore.acquire(opened, getLocalCollaborator())
      setLoaded({ session: opened, network: networkLease.network })
    }).catch(error => {
      if (active) setLoadError(error instanceof Error ? error.message : 'Could not open the local collaborative document.')
    })
    return () => {
      active = false
      networkLease?.release()
      lease.release()
    }
  }, [document.id])

  if (loadError) return <div className="editor-loading" role="alert">{loadError}</div>
  if (!loaded) return <div className="editor-loading"><LoaderCircle size={18}/> Preparing your local document…</div>
  return <CollaborativeEditor document={document} onSave={onSave} session={loaded.session} network={loaded.network}/>
}

function CollaborativeEditor({ document, onSave, session, network }: Props & { session: YjsDocumentSession; network: PeerNetworkSession }) {
  const [title, setTitle] = useState(document.title)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [savedAt, setSavedAt] = useState(document.updatedAt)
  const [contentStats, setContentStats] = useState({ words: 0, characters: 0 })
  const [inviteCopied, setInviteCopied] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const online = useOnlineStatus()
  const collaborator = useMemo(() => getLocalCollaborator(), [])
  const conflictManager = useMemo(() => new ConflictManager(session.doc, { id: collaborator.id, name: collaborator.name }, document.id), [session.doc, collaborator, document.id])
  const versionHistory = useMemo(() => new DocumentVersionHistory(session.doc, collaborator), [session.doc, collaborator])
  const conflictState = useSyncExternalStore(conflictManager.subscribe, conflictManager.getSnapshot, conflictManager.getSnapshot)
  const versionState = useSyncExternalStore(versionHistory.subscribe, versionHistory.getSnapshot, versionHistory.getSnapshot)
  const appliedResolutions = useRef(new Set<string>())
  const networkState = useSyncExternalStore(network.subscribe, network.getSnapshot, network.getSnapshot)
  const contentTimer = useRef<number | undefined>(undefined)
  const titleTimer = useRef<number | undefined>(undefined)
  const saveSequence = useRef(0)
  const latestSave = useRef(onSave)
  latestSave.current = onSave
  const savePatch = useCallback((patch: Pick<Partial<DocumentRecord>, 'title' | 'content'>) => {
    const sequence = ++saveSequence.current
    setSaveState('saving')
    void latestSave.current(patch).then(saved => {
      if (sequence !== saveSequence.current) return
      if (!saved) { setSaveState('error'); return }
      setSaveState('saved')
      setSavedAt(Date.now())
    }).catch(() => {
      if (sequence === saveSequence.current) setSaveState('error')
    })
  }, [])

  const editor = useEditor({
    extensions: createEditorExtensions(session.doc, network.provider, collaborator),
    immediatelyRender: false,
    onUpdate: ({ editor: current, transaction }) => {
      const text = current.getText()
      setContentStats({ words: text.trim() ? text.trim().split(/\s+/u).length : 0, characters: text.length })
      setSaveState('saving')
      const localContext = consumeLocalEditContext(transaction)
      if (localContext) {
        if (!transaction.getMeta('tsg-document-version-restore')) {
          versionHistory.recordLocalEdit(transaction.before.toJSON(), current.getJSON(), () => current.getJSON())
        }
        const observedBlocks = getRichTextBlocks(current.state)
        for (const beforeBlock of localContext.blocks) {
          const afterBlock = observedBlocks[beforeBlock.index]
          if (beforeBlock.blockId.startsWith('relative:') && afterBlock?.sourceId.startsWith('y:')) {
            adoptBlockIdentity(current.state, beforeBlock.index, beforeBlock.blockId)
          }
        }
        conflictManager.recordLocalEdit(
          localContext,
          getRichTextBlocks(current.state).map(({ blockId, index, text, json }) => ({ blockId, index, text, json })),
        )
      }
    },
  }, [document.id, session.doc, network.provider, conflictManager, versionHistory, collaborator])

  useEffect(() => {
    if (editor) getRichTextBlocks(editor.state).forEach(block => conflictManager.bindLegacyBlock(block.index, block.blockId))
    conflictManager.start()
    return () => conflictManager.destroy()
  }, [editor, conflictManager])

  useEffect(() => {
    versionHistory.start()
    return () => versionHistory.destroy()
  }, [versionHistory])

  useEffect(() => {
    if (!editor) return
    for (const conflict of conflictState.conflicts) {
      if (conflict.status !== 'resolved' || conflict.resolvedText === undefined) continue
      const resolutionKey = `${conflict.id}|${conflict.resolvedBy?.id ?? ''}|${conflict.resolvedAt ?? 0}|${conflict.resolvedText}`
      if (appliedResolutions.current.has(resolutionKey)) continue
      appliedResolutions.current.add(resolutionKey)
      const currentBlock = getRichTextBlocks(editor.state).find(block => block.blockId === conflict.blockId)
      const resolvedContent = conflict.resolvedContent ?? resolvedBlockJson(conflict, conflict.resolution ?? 'custom', conflict.resolvedText)
      if (currentBlock && resolvedContent && JSON.stringify(currentBlock.json) === JSON.stringify(resolvedContent)) continue
      conflictManager.runWithoutRecording(() => {
        if (resolvedContent) replaceConflictBlock(editor, conflict, resolvedContent)
      })
    }
  }, [editor, conflictManager, conflictState.conflicts])

  const editorTextState = useEditorState({ editor, selector: ({ editor: current }) => current?.getText() ?? '' })
  useEffect(() => {
    const text = editorTextState ?? ''
    setContentStats({ words: text.trim() ? text.trim().split(/\s+/u).length : 0, characters: text.length })
  }, [editorTextState])

  // Structured plain text of the live document, recomputed per editor transaction so the panel can
  // send the current revision and notice when the document has moved past a finished summary.
  // Read-only: it serializes editor state and never writes to the editor or the Y.Doc behind it.
  const summaryText = useEditorState({ editor, selector: ({ editor: current }) => extractDocumentText(current?.getJSON()) }) ?? ''
  const summaryTooShort = summaryText.trim().length < MIN_SUMMARY_CHARACTERS
  const summaryDisabled = !online || summaryTooShort
  const summaryHint = !online
    ? OFFLINE_SUMMARY_HINT
    : summaryTooShort ? `Write at least ${MIN_SUMMARY_CHARACTERS} characters to summarize` : 'Summarize this document'
  const readDocumentText = useCallback(() => extractDocumentText(editor?.getJSON()), [editor])
  const closeSummary = useCallback(() => setSummaryOpen(false), [])

  /**
   * Appends a finished summary as its own section, only ever from an explicit click. Being a real
   * local edit it syncs to peers, autosaves and becomes versionable exactly like typed text; nothing
   * is inserted while a summary is merely generated.
   */
  const insertSummary = useCallback((text: string) => {
    if (!editor) return
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
    if (!lines.length) return
    const content: JSONContent[] = [{ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'AI summary' }] }]
    for (const line of lines) {
      const bullet = /^[-*\u2022]\s+(.*)$/u.exec(line)
      if (!bullet) { content.push({ type: 'paragraph', content: [{ type: 'text', text: line }] }); continue }
      const item: JSONContent = { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: bullet[1] }] }] }
      const previous = content[content.length - 1]
      if (previous?.type === 'bulletList' && previous.content) previous.content.push(item)
      else content.push({ type: 'bulletList', content: [item] })
    }
    editor.chain().focus('end').insertContentAt(editor.state.doc.content.size, content).run()
  }, [editor])

  useEffect(() => {
    let disposed = false
    const persistProjection = () => {
      window.clearTimeout(contentTimer.current)
      contentTimer.current = window.setTimeout(() => {
        void session.flush().then(() => {
          if (!disposed) savePatch({ content: readSharedContent(session) })
        }).catch(() => {
          if (!disposed) setSaveState('error')
        })
      }, 350)
    }
    session.doc.on('update', persistProjection)
    return () => {
      disposed = true
      session.doc.off('update', persistProjection)
      window.clearTimeout(contentTimer.current)
    }
  }, [savePatch, session])

  useEffect(() => {
    setTitle(document.title)
    setSavedAt(document.updatedAt)
  }, [document.id])

  useEffect(() => () => {
    window.clearTimeout(titleTimer.current)
  }, [document.id])

  const copyInviteLink = async () => {
    const invite = window.location.href
    try {
      await navigator.clipboard.writeText(invite)
      setInviteCopied(true)
      window.setTimeout(() => setInviteCopied(false), 1800)
    } catch {
      window.prompt('Copy this peer-to-peer document invite link', invite)
    }
  }

  if (!editor) return <div className="editor-loading"><LoaderCircle size={18}/> Preparing your document…</div>

  const syncLabel = synchronizationLabel(networkState, saveState, conflictState.unresolvedCount)
  const syncKind = saveState === 'error' ? 'error' : networkState.status === 'offline' ? 'offline' : networkState.syncStatus

  return <div className="editor-page">
    <header className="editor-topbar"><Link to="/app" className="editor-back" aria-label="Back to documents"><ArrowLeft size={17}/></Link><Link to="/app" className="editor-brand"><span className="brand-mark"><span/></span><span>TSG</span></Link><span className="editor-top-divider"/><input aria-label="Document title" className="document-title-input" value={title} maxLength={120} onChange={event => {
      const next = event.target.value; setTitle(next); setSaveState('saving'); window.clearTimeout(titleTimer.current)
      titleTimer.current = window.setTimeout(() => savePatch({ title: next }), 300)
      }} onBlur={() => { window.clearTimeout(titleTimer.current); const normalized = title.trim().slice(0, 120) || 'Untitled document'; setTitle(normalized); savePatch({ title: normalized }) }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}/><span className={`editor-save-state ${saveState}`}>{saveState === 'saving' ? <><LoaderCircle size={13}/> Saving…</> : saveState === 'error' ? <><WifiOff size={13}/> Save failed</> : <><Check size={13}/> Saved on this device</>}</span><span className="peer-status" role="status" aria-label="Peer connection status" data-network-status={networkState.status} data-signaling-connected={networkState.signalingConnected}><i className={networkState.status}/>{networkStatusLabel(networkState)}</span><span className={`sync-indicator ${syncKind}`} role="status" aria-label="Document synchronization status" data-sync-status={syncKind}>{syncLabel}</span><ConflictReview manager={conflictManager} conflicts={conflictState.conflicts} editor={editor}/><VersionHistoryPanel editor={editor} history={versionHistory} versions={versionState} network={networkState} getCurrentContent={() => editor.getJSON()} flushPersistence={session.flush} suppressConflictRecording={operation => conflictManager.runWithoutRecording(operation)}/><div className="peer-avatars" aria-label="Connected collaborators">{networkState.collaborators.slice(0, 5).map(user => <span className="peer-avatar" key={user.clientId} title={user.name} aria-label={user.name} style={{ backgroundColor: user.color }}>{user.name.slice(0, 1).toUpperCase()}</span>)}</div><button className={`summary-button ${summaryOpen ? 'is-active' : ''}`} type="button" onClick={() => setSummaryOpen(open => !open)} disabled={summaryDisabled} aria-label="Summarize" title={summaryHint} aria-pressed={summaryOpen}><Sparkles size={14}/><span>Summarize</span></button><button className="peer-share" type="button" onClick={() => void copyInviteLink()} aria-label="Copy invite link" title="Copy invite link"><Share2 size={14}/><span>{inviteCopied ? 'Copied' : 'Share'}</span></button></header>
    <div className="toolbar-wrap"><Toolbar editor={editor}/></div>
    <main className="editor-scroll"><article className="editor-paper"><div className="paper-eyebrow">DOCUMENT · LOCAL-FIRST PEER ROOM</div><EditorContent editor={editor} className="tiptap-content"/><div className="paper-footer">Made for your thoughts, wherever they find you.</div></article></main>
    <footer className="editor-statusbar"><span>{contentStats.words} words <i/> {contentStats.characters} characters</span><span>Saved {new Date(savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></footer>
    {summaryOpen && <SummaryPanel getText={readDocumentText} currentText={summaryText} onInsert={insertSummary} onClose={closeSummary}/>}
  </div>
}

function networkStatusLabel(state: ReturnType<PeerNetworkSession['getSnapshot']>): string {
  switch (state.status) {
    case 'offline': return 'Offline · saved locally'
    case 'signaling-unavailable': return 'Signaling unavailable · retrying'
    case 'waiting': return 'Waiting for collaborators'
    case 'connecting': return 'Connecting to peers…'
    case 'connected': return `Connected · ${state.connectedPeerCount} peer${state.connectedPeerCount === 1 ? '' : 's'}`
  }
}

function synchronizationLabel(
  state: ReturnType<PeerNetworkSession['getSnapshot']>,
  saveState: 'saved' | 'saving' | 'error',
  unresolvedConflicts: number,
): string {
  const base = saveState === 'error'
    ? 'Synchronization error'
    : saveState === 'saving'
      ? 'Saving locally…'
      : state.status === 'offline'
        ? 'Offline · saved locally'
        : state.syncStatus === 'synced'
          ? 'Synced'
          : state.connectedPeerCount > 0
            ? 'Synchronizing…'
            : state.status === 'waiting' || state.status === 'signaling-unavailable'
              ? 'Online · waiting for peers'
              : 'Connecting…'
  return unresolvedConflicts ? `Unresolved conflicts · ${base}` : base
}
