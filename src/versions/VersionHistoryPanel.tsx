import { useState, type FormEvent } from 'react'
import { History, Trash2, X } from 'lucide-react'
import type { Editor } from '@tiptap/react'
import type { JSONContent } from '@tiptap/core'
import type { PeerNetworkSnapshot } from '../networking/peerProvider'
import { DocumentVersionHistory, type DocumentVersion } from './documentVersionHistory'

const RESTORE_META = 'tsg-document-version-restore'

type Props = {
  editor: Editor
  history: DocumentVersionHistory
  versions: DocumentVersion[]
  network: PeerNetworkSnapshot
  getCurrentContent: () => JSONContent
  flushPersistence: () => Promise<void>
  suppressConflictRecording: (operation: () => void) => void
}

export function VersionHistoryPanel({ editor, history, versions, network, getCurrentContent, flushPersistence, suppressConflictRecording }: Props) {
  const [open, setOpen] = useState(false)
  const [versionName, setVersionName] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const createNamedVersion = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const created = history.createNamedVersion(versionName, getCurrentContent())
    setMessage(created ? `Saved “${created.name}”.` : 'No version created: this content already has a matching snapshot.')
    if (created) setVersionName('')
  }

  const deleteVersion = async (version: DocumentVersion) => {
    if (!window.confirm(`Delete the saved version “${version.name}”? The current document will not change.`)) return
    const removed = history.deleteVersion(version.id, getCurrentContent())
    if (!removed) {
      setDeleteError('The current document version cannot be deleted. No saved version was removed.')
      return
    }
    setDeleteError(null)
    try {
      await flushPersistence()
      setMessage(`Deleted “${version.name}” from version history.`)
    } catch {
      setDeleteError(`“${version.name}” was removed from shared history, but this device could not confirm the local save. Keep the document open and check storage before closing.`)
    }
  }

  const restore = (version: DocumentVersion) => {
    if (!window.confirm(`Restore “${version.name}” as the current document? This will create a new history entry.`)) return
    try {
      const restoredDocument = editor.schema.nodeFromJSON(version.content)
      if (restoredDocument.type.name !== 'doc') throw new Error('This snapshot is not a valid document.')
      suppressConflictRecording(() => editor.view.dispatch(
        editor.state.tr
          .replaceWith(0, editor.state.doc.content.size, restoredDocument.content)
          .setMeta(RESTORE_META, true),
      ))
      history.createRestoreVersion(editor.getJSON(), version)
      setRestoreError(null)
      setMessage(`Restored “${version.name}”.`)
    } catch (cause) {
      setRestoreError(cause instanceof Error ? cause.message : 'The version could not be restored.')
    }
  }

  const syncLabel = network.connectedPeerCount > 0 && network.syncStatus === 'synced'
    ? 'Synced with connected peers'
    : network.connectedPeerCount > 0
      ? 'Syncing version history to peers…'
      : 'Saved locally · will sync when peers reconnect'

  return <>
    <button className="version-history-button" type="button" onClick={() => setOpen(true)} aria-label="Open version history" title="Version history">
      <History size={14}/><span>History</span>
    </button>
    {open && <div className="version-history-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false) }}>
      <section className="version-history-panel" role="dialog" aria-modal="true" aria-labelledby="version-history-title">
        <header className="version-history-heading">
          <div><span className="eyebrow">DOCUMENT HISTORY</span><h2 id="version-history-title">Version history</h2></div>
          <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Close version history"><X size={16}/></button>
        </header>
        <div className="version-current" aria-label="Current document version">
          <span className="version-current-dot"/><div><b>Current document</b><span>Live content · {network.status === 'offline' ? 'offline' : 'saved on this device'}</span></div>
          <small>{syncLabel}</small>
        </div>
        <form className="version-create-form" onSubmit={createNamedVersion}>
          <label htmlFor="version-name">Create a named version</label>
          <div><input id="version-name" value={versionName} maxLength={100} onChange={event => setVersionName(event.target.value)} placeholder="e.g. Project proposal draft"/><button className="button button-dark" type="submit" disabled={!versionName.trim()}>Save version</button></div>
        </form>
        {message && <p className="version-feedback" role="status">{message}</p>}
        {restoreError && <p className="version-feedback error" role="alert">{restoreError}</p>}
        {deleteError && <p className="version-feedback error" role="alert">{deleteError}</p>}
        <h3 className="version-list-title">Previous versions <span>{versions.length}</span></h3>
        <ol className="version-list">
          {[...versions].reverse().map(version => <li key={version.id}>
            <div className="version-entry-main">
              <b>{version.name}</b>
              <span>{new Date(version.createdAt).toLocaleString()}</span>
              <small>{version.author.name}{version.kind === 'restore' ? ' · restored version' : version.kind === 'automatic' ? ' · automatic checkpoint' : version.kind === 'baseline' ? ' · starting version' : ' · named version'}</small>
              <p>{previewText(version.content) || 'Empty document'}</p>
            </div>
            <div className="version-entry-actions">
              <button className="button button-light" type="button" onClick={() => restore(version)}>Restore</button>
              <button className="version-delete-button" type="button" onClick={() => void deleteVersion(version)} disabled={JSON.stringify(version.content) === JSON.stringify(getCurrentContent())} aria-label={`Delete version ${version.name}`} title={JSON.stringify(version.content) === JSON.stringify(getCurrentContent()) ? 'The current document version cannot be deleted' : 'Delete version'}><Trash2 size={14}/></button>
            </div>
          </li>)}
        </ol>
        {!versions.length && <p className="version-empty">Named checkpoints appear here. Automatic checkpoints are created after substantial editing sessions.</p>}
      </section>
    </div>}
  </>
}

function previewText(content: JSONContent): string {
  const parts: string[] = []
  const visit = (node: JSONContent) => {
    if (typeof node.text === 'string') parts.push(node.text)
    else if (node.type === 'hardBreak') parts.push(' ')
    node.content?.forEach(visit)
    if (node.type === 'paragraph' || node.type?.startsWith('heading')) parts.push(' ')
  }
  visit(content)
  return parts.join('').replace(/\s+/gu, ' ').trim().slice(0, 180)
}
