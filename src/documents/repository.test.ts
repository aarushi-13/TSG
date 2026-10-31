import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexedDBDocumentRepository } from './repository'
import { TsgDatabase } from '../persistence/database'
import { LEGACY_DOCUMENTS_KEY, LEGACY_MIGRATION_ID } from '../persistence/legacyMigration'
import { documentYjsStore, YjsIndexedDBStore } from '../persistence/yjsStore'
import type { DocumentRecord } from './types'

class MemoryStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  putRaw(key: string, value: string) { this.values.set(key, value) }
}

const databases: TsgDatabase[] = []
let databaseNumber = 0
let now = 1_800_000_000_000
let nextId = 0

function createRepository() {
  const database = new TsgDatabase(`tsg-test-db-${++databaseNumber}`)
  databases.push(database)
  return new IndexedDBDocumentRepository(database, () => now, () => `doc-${++nextId}`)
}

function legacyRecord(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: 'legacy-1', title: 'Old title', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Legacy words' }] }] },
    createdAt: 100, updatedAt: 200, ...overrides,
  }
}

beforeEach(() => { now = 1_800_000_000_000; nextId = 0 })
afterEach(async () => { await Promise.all(databases.splice(0).map(database => database.deleteDatabase())) })

describe('IndexedDBDocumentRepository', () => {
  it('creates documents with separate metadata and content records', async () => {
    const repository = createRepository()
    const first = await repository.create()
    now += 100
    const second = await repository.create('  Meeting notes  ')

    expect(first).toMatchObject({ id: 'doc-1', title: 'Untitled document', createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000 })
    expect(second.title).toBe('Meeting notes')
    expect(repository.database.name).toContain('tsg-test-db-')
    const db = await repository.database.open()
    expect(await db.getAll('documents')).toHaveLength(2)
    expect(await db.getAll('content')).toHaveLength(2)
    expect((await repository.list()).map(document => document.id)).toEqual(['doc-2', 'doc-1'])
  })

  it('saves rich content and reopens it through a fresh database connection', async () => {
    const repository = createRepository()
    const document = await repository.create('Draft')
    const content = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Saved heading', marks: [{ type: 'bold' }] }] }] }
    now += 250
    await repository.update(document.id, { content })
    await repository.database.close()

    const reopenedRepository = new IndexedDBDocumentRepository(new TsgDatabase(repository.database.name), () => now)
    databases.push(reopenedRepository.database)
    const stored = await reopenedRepository.list()
    expect(stored[0].content).toEqual(content)
    expect(stored[0].updatedAt).toBe(document.updatedAt + 250)
  })

  it('renames with normalized titles and duplicates content under a new ID', async () => {
    const repository = createRepository()
    const document = await repository.create('Research')
    const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep this' }] }] }
    await repository.update(document.id, { content })
    const copy = await repository.duplicate(document.id)
    expect(copy.title).toBe('Research copy')
    expect(copy.id).not.toBe(document.id)
    expect(copy.content).toEqual(content)
    await repository.update(copy.id, { title: '   ' })
    expect((await repository.list()).find(item => item.id === copy.id)?.title).toBe('Untitled document')
    await repository.update(copy.id, { title: 'x'.repeat(140) })
    expect((await repository.list()).find(item => item.id === copy.id)?.title).toHaveLength(120)
    expect((await repository.list()).find(item => item.id === document.id)?.title).toBe('Research')
  })

  it('deletes the metadata and content atomically', async () => {
    const repository = createRepository()
    const first = await repository.create('Keep')
    const second = await repository.create('Remove')
    const yjs = await documentYjsStore.openDocument(second.id)
    yjs.doc.getText('body').insert(0, 'also remove CRDT content')
    await yjs.flush()
    await repository.delete(second.id)
    const db = await repository.database.open()
    expect((await db.getAll('documents')).map(item => item.id)).toEqual([first.id])
    expect((await db.getAll('content')).map(item => item.id)).toEqual([first.id])
    expect(await documentYjsStore.listUpdateHistory(second.id)).toEqual([])
    const reopened = await documentYjsStore.openDocument(second.id)
    expect(reopened.doc.getText('body').toString()).toBe('')
    await documentYjsStore.deleteDocument(second.id)
  })

  it('migrates legacy documents without changing fields and retains the old key', async () => {
    const repository = createRepository()
    const storage = new MemoryStorage()
    const oldDocument = legacyRecord()
    storage.putRaw(LEGACY_DOCUMENTS_KEY, JSON.stringify([oldDocument]))

    const result = await repository.initialize(storage)
    expect(result).toMatchObject({ sourceCount: 1, importedCount: 1, retainedNewerCount: 0, alreadyCompleted: false })
    expect(await repository.list()).toEqual([oldDocument])
    expect(storage.getItem(LEGACY_DOCUMENTS_KEY)).toBe(JSON.stringify([oldDocument]))
  })

  it('keeps a newer IndexedDB document when migrating older localStorage data', async () => {
    const repository = createRepository()
    const newer = legacyRecord({ title: 'Newer IndexedDB title', updatedAt: 500, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'new content' }] }] } })
    await repository.create(newer.title).then(created => repository.update(created.id, { title: newer.title, content: newer.content }))
    const storedIdb = (await repository.list())[0]
    const legacy = { ...newer, id: storedIdb.id, title: 'Older localStorage title', updatedAt: 300 }
    const storage = new MemoryStorage()
    storage.putRaw(LEGACY_DOCUMENTS_KEY, JSON.stringify([legacy]))

    const result = await repository.initialize(storage)
    expect(result.retainedNewerCount).toBe(1)
    expect((await repository.list())[0]).toMatchObject({ title: 'Newer IndexedDB title', content: newer.content, updatedAt: storedIdb.updatedAt })
    expect(storage.getItem(LEGACY_DOCUMENTS_KEY)).toBe(JSON.stringify([legacy]))
  })

  it('is idempotent on repeated initialization and does not overwrite post-migration edits', async () => {
    const repository = createRepository()
    const storage = new MemoryStorage()
    storage.putRaw(LEGACY_DOCUMENTS_KEY, JSON.stringify([legacyRecord()]))
    await repository.initialize(storage)
    await repository.update('legacy-1', { title: 'Edited after migration' })

    const freshRepository = new IndexedDBDocumentRepository(new TsgDatabase(repository.database.name), () => now)
    databases.push(freshRepository.database)
    const secondAttempt = await freshRepository.initialize(storage)
    expect(secondAttempt.alreadyCompleted).toBe(true)
    expect(await freshRepository.list()).toHaveLength(1)
    expect((await freshRepository.list())[0].title).toBe('Edited after migration')
    const db = await freshRepository.database.open()
    expect(await db.get('migrations', LEGACY_MIGRATION_ID)).toBeDefined()
  })

  it('supports simultaneous migration attempts without duplicate records', async () => {
    const first = createRepository()
    const second = new IndexedDBDocumentRepository(new TsgDatabase(first.database.name), () => now, () => 'another-id')
    databases.push(second.database)
    const storage = new MemoryStorage()
    storage.putRaw(LEGACY_DOCUMENTS_KEY, JSON.stringify([legacyRecord()]))
    await Promise.all([first.initialize(storage), second.initialize(storage)])
    expect(await first.list()).toHaveLength(1)
    expect(await (await first.database.open()).getAll('documents')).toHaveLength(1)
  })

  it('retains corrupt legacy data and allows migration retry after a read failure', async () => {
    const repository = createRepository()
    const corrupt = new MemoryStorage()
    corrupt.putRaw(LEGACY_DOCUMENTS_KEY, '{broken')
    await expect(repository.initialize(corrupt)).rejects.toThrow(/not valid JSON/u)
    expect(corrupt.getItem(LEGACY_DOCUMENTS_KEY)).toBe('{broken')

    const valid = new MemoryStorage()
    valid.putRaw(LEGACY_DOCUMENTS_KEY, JSON.stringify([legacyRecord()]))
    await repository.initialize(valid)
    expect(await repository.list()).toHaveLength(1)
  })

  it('retries migration after localStorage access is temporarily unavailable', async () => {
    const repository = createRepository()
    const unavailable = { getItem: () => { throw new Error('SecurityError') } }
    await expect(repository.initialize(unavailable)).rejects.toThrow(/older browser document list/u)
    const storage = new MemoryStorage()
    storage.putRaw(LEGACY_DOCUMENTS_KEY, JSON.stringify([legacyRecord()]))
    await repository.initialize(storage)
    expect(await repository.list()).toHaveLength(1)
  })

  it('rolls back an interrupted migration, keeps the legacy copy, then recovers', async () => {
    const repository = createRepository()
    const storage = new MemoryStorage()
    const legacy = legacyRecord()
    const raw = JSON.stringify([legacy])
    storage.putRaw(LEGACY_DOCUMENTS_KEY, raw)
    const originalPut = IDBObjectStore.prototype.put
    let callCount = 0
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      callCount += 1
      if (callCount === 2) throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      return originalPut.call(this, value, key)
    })

    await expect(repository.initialize(storage)).rejects.toThrow(/older copy was kept/u)
    expect(storage.getItem(LEGACY_DOCUMENTS_KEY)).toBe(raw)
    await expect(repository.list()).resolves.toEqual([])
    expect(await (await repository.database.open()).get('migrations', LEGACY_MIGRATION_ID)).toBeUndefined()
    put.mockRestore()

    await repository.initialize(storage)
    expect(await repository.list()).toEqual([legacy])
  })

  it('reports IndexedDB write failures and recovers when storage works again', async () => {
    const repository = createRepository()
    const originalAdd = IDBObjectStore.prototype.add
    let callCount = 0
    const add = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      callCount += 1
      if (callCount === 2) throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      return originalAdd.call(this, value, key)
    })
    await expect(repository.create()).rejects.toThrow(/Could not create this document in IndexedDB/u)
    await expect(repository.list()).resolves.toEqual([])
    add.mockRestore()
    expect((await repository.create()).title).toBe('Untitled document')
  })
})

describe('YjsIndexedDBStore', () => {
  it('reuses one provider per document and restores Yjs updates after reopening', async () => {
    const store = new YjsIndexedDBStore()
    const first = await store.openDocument('stable-doc-id')
    expect(await store.openDocument('stable-doc-id')).toBe(first)
    first.doc.getText('body').insert(0, 'persisted Yjs update')
    await first.flush()
    expect((await store.listUpdateHistory('stable-doc-id')).some(entry => entry.kind === 'update')).toBe(true)
    await first.destroy()

    const reopened = await store.openDocument('stable-doc-id')
    expect(reopened.doc.getText('body').toString()).toBe('persisted Yjs update')
    await store.deleteDocument('stable-doc-id')
    expect(await store.listUpdateHistory('stable-doc-id')).toEqual([])
    const empty = await store.openDocument('stable-doc-id')
    expect(empty.doc.getText('body').toString()).toBe('')
    await empty.destroy()
    await store.deleteDocument('stable-doc-id')
  })
})
