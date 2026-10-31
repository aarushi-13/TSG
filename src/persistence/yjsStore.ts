import * as Y from 'yjs'
import { clearDocument, IndexeddbPersistence, storeState } from 'y-indexeddb'
import { YjsUpdateLog, type YjsUpdateLogEntry } from './yjsUpdateLog'

export type YjsDocumentSession = {
  documentId: string
  doc: Y.Doc
  ready: Promise<void>
  flush: () => Promise<void>
  destroy: () => Promise<void>
  clearData: () => Promise<void>
}

const updateDatabaseName = (documentId: string) => `tsg-y-updates-${encodeURIComponent(documentId)}`

/** Owns one y-indexeddb provider per document ID in this application runtime. */
export class YjsIndexedDBStore {
  private readonly sessions = new Map<string, Promise<YjsDocumentSession>>()
  private readonly references = new Map<string, number>()
  private readonly updateLog = new YjsUpdateLog()

  openDocument(documentId: string): Promise<YjsDocumentSession> {
    const existing = this.sessions.get(documentId)
    if (existing) return existing

    let opening: Promise<YjsDocumentSession>
    opening = (async () => {
      const doc = new Y.Doc()
      let persistence: IndexeddbPersistence
      try { persistence = new IndexeddbPersistence(updateDatabaseName(documentId), doc) }
      catch (error) { doc.destroy(); throw persistenceError(error) }

      try { await persistence.whenSynced }
      catch (error) {
        await persistence.destroy().catch(() => undefined)
        doc.destroy()
        throw persistenceError(error)
      }

      let archiveError: unknown
      let archived = this.updateLog.append({
        documentId,
        kind: 'checkpoint',
        update: Y.encodeStateAsUpdate(doc),
        recordedAt: Date.now(),
      }).catch(error => { archiveError = error })
      const archiveUpdate = (update: Uint8Array) => {
        archived = archived.catch(() => undefined).then(() => this.updateLog.append({
          documentId, kind: 'update', update, recordedAt: Date.now(),
        })).catch(error => { archiveError = error })
      }
      doc.on('update', archiveUpdate)

      let destroyed = false
      const session: YjsDocumentSession = {
        documentId,
        doc,
        ready: Promise.resolve(),
        flush: async () => {
          if (destroyed) throw new Error('This Yjs persistence session is already closed.')
          try {
            // y-indexeddb may compact its restore log; the independent archive keeps the raw updates.
            await Promise.all([storeState(persistence, false), archived])
            if (archiveError) throw archiveError
          }
          catch (error) { throw persistenceError(error) }
        },
        destroy: async () => {
          if (destroyed) return
          destroyed = true
          if (this.sessions.get(documentId) === opening) this.sessions.delete(documentId)
          doc.off('update', archiveUpdate)
          try {
            await Promise.all([storeState(persistence, false), archived])
            if (archiveError) throw archiveError
          }
          finally {
            await persistence.destroy()
            doc.destroy()
          }
        },
        clearData: async () => {
          if (destroyed) return
          destroyed = true
          if (this.sessions.get(documentId) === opening) this.sessions.delete(documentId)
          doc.off('update', archiveUpdate)
          try { await archived.catch(() => undefined); await persistence.clearData() }
          finally { doc.destroy(); await this.updateLog.deleteDocument(documentId) }
        },
      }
      return session
    })().catch(error => {
      if (this.sessions.get(documentId) === opening) this.sessions.delete(documentId)
      throw error
    })
    this.sessions.set(documentId, opening)
    return opening
  }

  /** Acquire a lifecycle lease. The deferred release also tolerates React StrictMode remounts. */
  acquireDocument(documentId: string): { session: Promise<YjsDocumentSession>; release: () => void } {
    this.references.set(documentId, (this.references.get(documentId) ?? 0) + 1)
    const session = this.openDocument(documentId)
    let released = false
    return {
      session,
      release: () => {
        if (released) return
        released = true
        setTimeout(() => {
          const remaining = Math.max(0, (this.references.get(documentId) ?? 1) - 1)
          if (remaining) this.references.set(documentId, remaining)
          else {
            this.references.delete(documentId)
            void session.then(opened => opened.destroy()).catch(() => undefined)
          }
        }, 0)
      },
    }
  }

  async deleteDocument(documentId: string): Promise<void> {
    this.references.delete(documentId)
    const sessionPromise = this.sessions.get(documentId)
    try {
      if (sessionPromise) {
        const session = await sessionPromise
        await session.clearData()
      } else {
        await clearDocument(updateDatabaseName(documentId))
      }
      await this.updateLog.deleteDocument(documentId)
    } catch (error) { throw persistenceError(error) }
  }

  listUpdateHistory(documentId: string): Promise<YjsUpdateLogEntry[]> {
    return this.updateLog.list(documentId)
  }
}

/** Shared application store so editor teardown and document deletion address the same session cache. */
export const documentYjsStore = new YjsIndexedDBStore()

function persistenceError(cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : 'Unknown IndexedDB error.'
  return new Error(`Yjs updates could not be persisted in IndexedDB: ${message}`, { cause })
}
