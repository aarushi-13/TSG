import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { IndexedDBDocumentRepository } from './repository'
import type { DocumentRecord } from './types'

type DocumentContextValue = {
  documents: DocumentRecord[]
  loading: boolean
  createDocument: (title?: string) => Promise<DocumentRecord | null>
  joinDocument: (id: string) => Promise<DocumentRecord | null>
  updateDocument: (id: string, patch: Pick<Partial<DocumentRecord>, 'title' | 'content'>) => Promise<DocumentRecord | null>
  duplicateDocument: (id: string) => Promise<DocumentRecord | null>
  deleteDocument: (id: string) => Promise<boolean>
  refresh: () => Promise<void>
  error: string | null
  clearError: () => void
}

const DocumentContext = createContext<DocumentContextValue | null>(null)

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

export function DocumentProvider({ children }: { children: ReactNode }) {
  const repository = useMemo(() => new IndexedDBDocumentRepository(), [])
  const [snapshot, setSnapshot] = useState({ documents: [] as DocumentRecord[], loading: true, error: null as string | null })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      let migrationError: string | null = null
      try { await repository.initialize(window.localStorage) }
      catch (cause) { migrationError = errorMessage(cause, 'Could not migrate older local documents.') }
      try {
        const documents = await repository.list()
        if (!cancelled) setSnapshot({ documents, loading: false, error: migrationError })
      } catch (cause) {
        const readError = errorMessage(cause, 'Could not open the local document database.')
        if (!cancelled) setSnapshot({ documents: [], loading: false, error: migrationError ? `${migrationError} ${readError}` : readError })
      }
    })()
    return () => { cancelled = true }
  }, [repository])

  const refresh = useCallback(async () => {
    try { const documents = await repository.list(); setSnapshot(previous => ({ ...previous, documents, error: null })) }
    catch (cause) { setSnapshot(previous => ({ ...previous, error: errorMessage(cause, 'Could not refresh local documents.') })) }
  }, [repository])

  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T | null> => {
    try {
      const result = await operation()
      const documents = await repository.list()
      setSnapshot(previous => ({ ...previous, documents, error: null }))
      return result
    } catch (cause) {
      setSnapshot(previous => ({ ...previous, error: errorMessage(cause, 'The document could not be saved.') }))
      return null
    }
  }, [repository])

  const value = useMemo<DocumentContextValue>(() => ({
    documents: snapshot.documents,
    loading: snapshot.loading,
    createDocument: title => run(() => repository.create(title)),
    joinDocument: id => run(() => repository.join(id)),
    updateDocument: (id, patch) => run(() => repository.update(id, patch)),
    duplicateDocument: id => run(() => repository.duplicate(id)),
    deleteDocument: async id => (await run(async () => { await repository.delete(id); return true })) ?? false,
    refresh,
    error: snapshot.error,
    clearError: () => setSnapshot(previous => ({ ...previous, error: null })),
  }), [refresh, repository, run, snapshot])

  return <DocumentContext.Provider value={value}>{children}</DocumentContext.Provider>
}

export function useDocuments(): DocumentContextValue {
  const context = useContext(DocumentContext)
  if (!context) throw new Error('useDocuments must be used inside DocumentProvider')
  return context
}
