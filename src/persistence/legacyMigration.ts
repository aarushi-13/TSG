import type { JSONContent } from '@tiptap/core'
import type { DocumentRecord } from '../documents/types'
import { persistenceError, type DocumentContentRecord, type DocumentMetadata, type TsgDatabase } from './database'

export const LEGACY_DOCUMENTS_KEY = 'tsg.documents.v1'
export const LEGACY_MIGRATION_ID = 'phase-2-localstorage-documents-v1'

export interface LegacyDocumentStorage {
  getItem(key: string): string | null
}

export type MigrationResult = {
  sourceCount: number
  importedCount: number
  retainedNewerCount: number
  alreadyCompleted: boolean
}

function isContent(value: unknown): value is JSONContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const content = value as { type?: unknown; content?: unknown; text?: unknown }
  return content.type === 'doc' && (content.content === undefined || Array.isArray(content.content))
}

function isLegacyDocument(value: unknown): value is DocumentRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const document = value as Partial<DocumentRecord>
  return typeof document.id === 'string' && document.id.length > 0
    && typeof document.title === 'string'
    && typeof document.createdAt === 'number' && Number.isFinite(document.createdAt)
    && typeof document.updatedAt === 'number' && Number.isFinite(document.updatedAt)
    && isContent(document.content)
}

function parseLegacyDocuments(raw: string): DocumentRecord[] {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (error) { throw persistenceError('The older browser document list is not valid JSON; it was kept unchanged', error) }
  if (!Array.isArray(parsed) || !parsed.every(isLegacyDocument)) {
    throw new Error('The older browser document list has an unsupported format; it was kept unchanged.')
  }
  const newestById = new Map<string, DocumentRecord>()
  for (const document of parsed) {
    const current = newestById.get(document.id)
    if (!current || document.updatedAt >= current.updatedAt) newestById.set(document.id, document)
  }
  return [...newestById.values()]
}

export async function migrateLegacyDocuments(database: TsgDatabase, storage: LegacyDocumentStorage): Promise<MigrationResult> {
  const db = await database.open()
  const marker = await db.get('migrations', LEGACY_MIGRATION_ID)
  if (marker) return { sourceCount: marker.sourceCount, importedCount: marker.importedCount, retainedNewerCount: marker.retainedNewerCount, alreadyCompleted: true }

  let raw: string | null
  try { raw = storage.getItem(LEGACY_DOCUMENTS_KEY) }
  catch (error) { throw persistenceError('Could not read the older browser document list; it was left untouched', error) }
  if (raw === null) return { sourceCount: 0, importedCount: 0, retainedNewerCount: 0, alreadyCompleted: false }

  const legacyDocuments = parseLegacyDocuments(raw)
  let importedCount = 0
  let retainedNewerCount = 0

  try {
    const tx = db.transaction(['documents', 'content'], 'readwrite')
    const writes: Promise<unknown>[] = []
    try {
      const metadataStore = tx.objectStore('documents')
      const contentStore = tx.objectStore('content')
      for (const legacy of legacyDocuments) {
        const [existingMetadata, existingContent] = await Promise.all([
          metadataStore.get(legacy.id),
          contentStore.get(legacy.id),
        ])
        if (existingMetadata && existingMetadata.updatedAt >= legacy.updatedAt) {
          if (existingContent && existingContent.updatedAt >= legacy.updatedAt) {
            retainedNewerCount += 1
          } else {
            writes.push(contentStore.put({ id: legacy.id, content: legacy.content, updatedAt: legacy.updatedAt }))
            importedCount += 1
          }
          continue
        }
        const metadata: DocumentMetadata = { id: legacy.id, title: legacy.title, createdAt: legacy.createdAt, updatedAt: legacy.updatedAt }
        const content: DocumentContentRecord = { id: legacy.id, content: legacy.content, updatedAt: legacy.updatedAt }
        writes.push(metadataStore.put(metadata))
        writes.push(contentStore.put(content))
        importedCount += 1
      }
      await Promise.all([...writes, tx.done])
    } catch (error) {
      try { tx.abort() } catch { /* The transaction may already have aborted. */ }
      await Promise.allSettled(writes)
      await tx.done.catch(() => undefined)
      throw error
    }
  } catch (error) {
    throw persistenceError('Could not migrate documents into IndexedDB; the older copy was kept', error)
  }

  try {
    const verifyTx = db.transaction(['documents', 'content'], 'readonly')
    const [metadataRows, contentRows] = await Promise.all([
      verifyTx.objectStore('documents').getAll(),
      verifyTx.objectStore('content').getAll(),
    ])
    await verifyTx.done
    const metadataById = new Map(metadataRows.map(document => [document.id, document]))
    const contentById = new Map(contentRows.map(document => [document.id, document]))
    for (const legacy of legacyDocuments) {
      const metadata = metadataById.get(legacy.id)
      const content = contentById.get(legacy.id)
      if (!metadata || !content || metadata.updatedAt < legacy.updatedAt || content.updatedAt < legacy.updatedAt) {
        throw new Error(`Document ${legacy.id} could not be verified after migration.`)
      }
    }

    const markerTx = db.transaction('migrations', 'readwrite')
    markerTx.objectStore('migrations').put({
      id: LEGACY_MIGRATION_ID,
      completedAt: Date.now(),
      sourceCount: legacyDocuments.length,
      importedCount,
      retainedNewerCount,
    })
    await markerTx.done
  } catch (error) {
    throw persistenceError('IndexedDB migration verification failed; the older browser copy was kept', error)
  }

  return { sourceCount: legacyDocuments.length, importedCount, retainedNewerCount, alreadyCompleted: false }
}
