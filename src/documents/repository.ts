import type { IDBPTransaction } from 'idb'
import { EMPTY_DOCUMENT, type DocumentRecord } from './types'
import { migrateLegacyDocuments, type LegacyDocumentStorage, type MigrationResult } from '../persistence/legacyMigration'
import { persistenceError, TsgDatabase, type DocumentContentRecord, type DocumentMetadata, type TsgDatabaseSchema } from '../persistence/database'

export interface DocumentRepository {
  initialize(legacyStorage: LegacyDocumentStorage): Promise<MigrationResult>
  list(): Promise<DocumentRecord[]>
  create(title?: string): Promise<DocumentRecord>
  join(documentId: string, title?: string): Promise<DocumentRecord>
  update(id: string, patch: Pick<Partial<DocumentRecord>, 'title' | 'content'>): Promise<DocumentRecord>
  duplicate(id: string): Promise<DocumentRecord>
  delete(id: string): Promise<void>
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function toDocument(metadata: DocumentMetadata, content: DocumentContentRecord | undefined): DocumentRecord {
  if (!content) throw new Error(`The content for document ${metadata.id} is missing from IndexedDB.`)
  return { ...metadata, content: content.content }
}

export class IndexedDBDocumentRepository implements DocumentRepository {
  private migration?: Promise<MigrationResult>

  constructor(readonly database = new TsgDatabase(), private readonly now: () => number = Date.now, private readonly id: () => string = makeId) {}

  initialize(legacyStorage: LegacyDocumentStorage): Promise<MigrationResult> {
    if (!this.migration) {
      const attempt = migrateLegacyDocuments(this.database, legacyStorage)
      this.migration = attempt.catch(error => {
        this.migration = undefined
        throw error
      })
    }
    return this.migration
  }

  async list(): Promise<DocumentRecord[]> {
    try {
      const db = await this.database.open()
      const tx = db.transaction(['documents', 'content'], 'readonly')
      const [metadataRows, contentRows] = await Promise.all([
        tx.objectStore('documents').getAll(),
        tx.objectStore('content').getAll(),
      ])
      await tx.done
      const contents = new Map(contentRows.map(record => [record.id, record]))
      return metadataRows.map(metadata => toDocument(metadata, contents.get(metadata.id))).sort((a, b) => b.updatedAt - a.updatedAt)
    } catch (error) {
      throw persistenceError('Could not load documents from IndexedDB', error)
    }
  }

  async create(title = 'Untitled document'): Promise<DocumentRecord> {
    return this.createWithId(this.id(), title)
  }

  async join(documentId: string, title = 'Shared document'): Promise<DocumentRecord> {
    const current = (await this.list()).find(document => document.id === documentId)
    if (current) return current
    try { return await this.createWithId(documentId, title) }
    catch (error) {
      // A second tab may have joined concurrently; only return it if the record now exists.
      const raced = (await this.list()).find(document => document.id === documentId)
      if (raced) return raced
      throw error
    }
  }

  private async createWithId(id: string, title: string): Promise<DocumentRecord> {
    const cleanTitle = normalizeTitle(title)
    const timestamp = this.now()
    const document: DocumentRecord = {
      id, title: cleanTitle, content: structuredClone(EMPTY_DOCUMENT), createdAt: timestamp, updatedAt: timestamp,
    }
    try {
      const db = await this.database.open()
      const tx = db.transaction(['documents', 'content'], 'readwrite')
      const writes: Promise<unknown>[] = []
      try {
        writes.push(tx.objectStore('documents').add(metadataFor(document)))
        writes.push(tx.objectStore('content').add(contentFor(document)))
        await Promise.all([...writes, tx.done])
        return document
      } catch (error) {
        try { tx.abort() } catch { /* The transaction may already have aborted. */ }
        await Promise.allSettled(writes)
        await tx.done.catch(() => undefined)
        throw error
      }
    } catch (error) {
      throw persistenceError('Could not create this document in IndexedDB', error)
    }
  }

  async update(id: string, patch: Pick<Partial<DocumentRecord>, 'title' | 'content'>): Promise<DocumentRecord> {
    try {
      const db = await this.database.open()
      const tx = db.transaction(['documents', 'content'], 'readwrite')
      const [metadata, content] = await Promise.all([
        tx.objectStore('documents').get(id),
        tx.objectStore('content').get(id),
      ])
      const writes: Promise<unknown>[] = []
      try {
        if (!metadata || !content) throw new Error('This document no longer exists or is incomplete in this browser.')
        const next: DocumentRecord = {
          ...metadata,
          ...(patch.title !== undefined ? { title: normalizeTitle(patch.title) } : {}),
          content: patch.content !== undefined ? patch.content : content.content,
          updatedAt: this.now(),
        }
        writes.push(tx.objectStore('documents').put(metadataFor(next)))
        writes.push(tx.objectStore('content').put(contentFor(next)))
        await Promise.all([...writes, tx.done])
        return next
      } catch (error) {
        try { tx.abort() } catch { /* The transaction may already have aborted. */ }
        await Promise.allSettled(writes)
        await tx.done.catch(() => undefined)
        throw error
      }
    } catch (error) {
      throw persistenceError('Could not save changes to this document', error)
    }
  }

  async duplicate(id: string): Promise<DocumentRecord> {
    const original = (await this.list()).find(document => document.id === id)
    if (!original) throw new Error('This document no longer exists in this browser.')
    const timestamp = this.now()
    const copy: DocumentRecord = {
      ...structuredClone(original),
      id: this.id(),
      title: normalizeTitle(`${original.title} copy`),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    try {
      const db = await this.database.open()
      const tx = db.transaction(['documents', 'content'], 'readwrite')
      const writes: Promise<unknown>[] = []
      try {
        writes.push(tx.objectStore('documents').add(metadataFor(copy)))
        writes.push(tx.objectStore('content').add(contentFor(copy)))
        await Promise.all([...writes, tx.done])
        return copy
      } catch (error) {
        try { tx.abort() } catch { /* The transaction may already have aborted. */ }
        await Promise.allSettled(writes)
        await tx.done.catch(() => undefined)
        throw error
      }
    } catch (error) {
      throw persistenceError('Could not duplicate this document', error)
    }
  }

  async delete(id: string): Promise<void> {
    let documentDeleted = false
    try {
      const db = await this.database.open()
      const tx = db.transaction(['documents', 'content'], 'readwrite')
      const writes: Promise<unknown>[] = []
      try {
        writes.push(tx.objectStore('documents').delete(id))
        writes.push(tx.objectStore('content').delete(id))
        await Promise.all([...writes, tx.done])
        documentDeleted = true
      } catch (error) {
        try { tx.abort() } catch { /* The transaction may already have aborted. */ }
        await Promise.allSettled(writes)
        await tx.done.catch(() => undefined)
        throw error
      }
      const { peerProviderStore } = await import('../networking/peerProvider')
      peerProviderStore.closeDocument(id)
      const { documentYjsStore } = await import('../persistence/yjsStore')
      await documentYjsStore.deleteDocument(id)
    } catch (error) {
      if (documentDeleted) throw persistenceError('The document was removed from the workspace, but its local Yjs data could not be cleared', error)
      throw persistenceError('Could not delete this document from IndexedDB', error)
    }
  }
}

function normalizeTitle(title: string): string {
  return title.trim().slice(0, 120) || 'Untitled document'
}

function metadataFor(document: DocumentRecord): DocumentMetadata {
  return { id: document.id, title: document.title, createdAt: document.createdAt, updatedAt: document.updatedAt }
}

function contentFor(document: DocumentRecord): DocumentContentRecord {
  return { id: document.id, content: document.content, updatedAt: document.updatedAt }
}

export type { IDBPTransaction, TsgDatabaseSchema }
