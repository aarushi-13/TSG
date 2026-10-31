import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb'

const DATABASE_NAME = 'tsg-y-update-history'
const DATABASE_VERSION = 1

export type YjsUpdateLogEntry = {
  documentId: string
  kind: 'checkpoint' | 'update'
  update: Uint8Array
  recordedAt: number
}

interface YjsUpdateLogSchema extends DBSchema {
  entries: {
    key: number
    value: YjsUpdateLogEntry
    indexes: { 'by-document': string }
  }
}

/** Append-only update archive. Kept separate because y-indexeddb compacts its restore log. */
export class YjsUpdateLog {
  private database?: Promise<IDBPDatabase<YjsUpdateLogSchema>>

  private open(): Promise<IDBPDatabase<YjsUpdateLogSchema>> {
    if (!this.database) {
      this.database = openDB<YjsUpdateLogSchema>(DATABASE_NAME, DATABASE_VERSION, {
        upgrade(db) {
          const entries = db.createObjectStore('entries', { autoIncrement: true })
          entries.createIndex('by-document', 'documentId')
        },
        blocking: () => { void this.close() },
        terminated: () => { this.database = undefined },
      }).catch(error => {
        this.database = undefined
        throw new Error(`Could not open the Yjs update archive: ${error instanceof Error ? error.message : 'unknown IndexedDB error'}`, { cause: error })
      })
    }
    return this.database
  }

  async append(entry: YjsUpdateLogEntry): Promise<void> {
    try {
      const db = await this.open()
      const tx = db.transaction('entries', 'readwrite')
      tx.store.add({ ...entry, update: entry.update.slice() })
      await tx.done
    } catch (error) {
      throw new Error(`Could not retain a Yjs update for ${entry.documentId}: ${error instanceof Error ? error.message : 'unknown IndexedDB error'}`, { cause: error })
    }
  }

  async list(documentId: string): Promise<YjsUpdateLogEntry[]> {
    try {
      const db = await this.open()
      const tx = db.transaction('entries', 'readonly')
      const entries = await tx.store.index('by-document').getAll(documentId)
      await tx.done
      return entries.map(entry => ({ ...entry, update: entry.update.slice() }))
    } catch (error) {
      throw new Error(`Could not read the Yjs update archive for ${documentId}: ${error instanceof Error ? error.message : 'unknown IndexedDB error'}`, { cause: error })
    }
  }

  async deleteDocument(documentId: string): Promise<void> {
    try {
      const db = await this.open()
      const tx = db.transaction('entries', 'readwrite')
      const keys = await tx.store.index('by-document').getAllKeys(documentId)
      await Promise.all(keys.map(key => tx.store.delete(key)))
      await tx.done
    } catch (error) {
      throw new Error(`Could not delete the Yjs update archive for ${documentId}: ${error instanceof Error ? error.message : 'unknown IndexedDB error'}`, { cause: error })
    }
  }

  async close(): Promise<void> {
    const database = this.database
    this.database = undefined
    if (database) { try { (await database).close() } catch { /* Open failures are reported by callers. */ } }
  }

  async clearAll(): Promise<void> {
    await this.close()
    await deleteDB(DATABASE_NAME)
  }
}
