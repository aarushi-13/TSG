import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { JSONContent } from '@tiptap/core'

export const DATABASE_NAME = 'tsg-local-workspace'
export const DATABASE_VERSION = 1

export type DocumentMetadata = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export type DocumentContentRecord = {
  id: string
  content: JSONContent
  updatedAt: number
}

export type MigrationMarker = {
  id: string
  completedAt: number
  sourceCount: number
  importedCount: number
  retainedNewerCount: number
}

export interface TsgDatabaseSchema extends DBSchema {
  documents: { key: string; value: DocumentMetadata }
  content: { key: string; value: DocumentContentRecord }
  migrations: { key: string; value: MigrationMarker }
}

export class TsgDatabase {
  private connection?: Promise<IDBPDatabase<TsgDatabaseSchema>>

  constructor(readonly name = DATABASE_NAME) {}

  open(): Promise<IDBPDatabase<TsgDatabaseSchema>> {
    if (!this.connection) {
      let rejectBlocked!: (error: Error) => void
      let blocked = false
      const blockedRequest = new Promise<never>((_, reject) => { rejectBlocked = reject })
      const opening = openDB<TsgDatabaseSchema>(this.name, DATABASE_VERSION, {
        upgrade(database, oldVersion) {
          if (oldVersion < 1) {
            database.createObjectStore('documents', { keyPath: 'id' })
            database.createObjectStore('content', { keyPath: 'id' })
            database.createObjectStore('migrations', { keyPath: 'id' })
          }
        },
        blocking: () => {
          void this.close()
        },
        blocked: () => {
          blocked = true
          rejectBlocked(new Error('Another open tab is blocking the local database upgrade. Close that tab and retry.'))
        },
        terminated: () => {
          this.connection = undefined
        },
      })
      void opening.then(database => { if (blocked) database.close() }).catch(() => undefined)
      this.connection = Promise.race([opening, blockedRequest]).catch(error => {
        this.connection = undefined
        throw persistenceError('Could not initialize the local database', error)
      })
    }
    return this.connection
  }

  async close(): Promise<void> {
    const connection = this.connection
    this.connection = undefined
    if (!connection) return
    try { (await connection).close() } catch { /* Failed opens have already been reported to callers. */ }
  }

  async deleteDatabase(): Promise<void> {
    await this.close()
    try { await deleteDB(this.name) }
    catch (error) { throw persistenceError('Could not remove the local database', error) }
  }
}

export function persistenceError(message: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : 'Unknown browser storage error.'
  return new Error(`${message}: ${detail}`, { cause })
}
