import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { IndexedDBDocumentRepository } from './documents/repository'
import { TsgDatabase } from './persistence/database'

function renderApp() {
  return render(<MemoryRouter initialEntries={['/app']}><App/></MemoryRouter>)
}

beforeEach(async () => { await new TsgDatabase().deleteDatabase(); window.localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('document workspace flows', () => {
  it('keeps the Phase 1 landing page and route available', async () => {
    render(<MemoryRouter initialEntries={['/']}><App/></MemoryRouter>)
    expect(await screen.findByRole('heading', { name: /Make room for good thinking/u })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Get started for free/u })).toHaveAttribute('href', '/app')
  })

  it('creates a document, edits it, autosaves it, and lists it after returning home', async () => {
    const user = userEvent.setup()
    renderApp()

    expect(await screen.findByText('Your first page is waiting.')).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Create a document' }))
    const title = await screen.findByRole('textbox', { name: 'Document title' }, { timeout: 5000 })
    await user.clear(title)
    await user.type(title, 'A walk in the garden')
    title.blur()
    await user.click(screen.getByRole('link', { name: 'Back to documents' }))

    expect(await screen.findByRole('link', { name: 'A walk in the garden' })).toBeInTheDocument()
    const stored = await new IndexedDBDocumentRepository().list()
    expect(stored[0].title).toBe('A walk in the garden')
  })

  it('renames, duplicates, and deletes only after an explicit confirmation', async () => {
    const user = userEvent.setup()
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('Field journal')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderApp()

    await user.click(await screen.findByRole('button', { name: 'Create a document' }))
    await screen.findByRole('textbox', { name: 'Document title' }, { timeout: 5000 })
    await user.click(screen.getByRole('link', { name: 'Back to documents' }))
    await user.click(await screen.findByRole('button', { name: 'Options for Untitled document' }))
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    expect(prompt).toHaveBeenCalledOnce()
    expect(await screen.findByRole('link', { name: 'Field journal' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Options for Field journal' }))
    await user.click(screen.getByRole('button', { name: 'Duplicate' }))
    const copyTitle = await screen.findByRole('textbox', { name: 'Document title' }, { timeout: 5000 })
    expect(copyTitle).toHaveValue('Field journal copy')
    await user.click(screen.getByRole('link', { name: 'Back to documents' }))
    expect(await screen.findByText('2 documents saved in this browser.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Options for Field journal copy' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.getByText('1 document saved in this browser.')).toBeInTheDocument())
    expect(confirm).toHaveBeenCalledOnce()
    expect(await new IndexedDBDocumentRepository().list()).toHaveLength(1)
  })

  it('surfaces a browser quota error and leaves the user on the dashboard', async () => {
    const user = userEvent.setup()
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(() => { throw new DOMException('QuotaExceededError', 'QuotaExceededError') })
    renderApp()

    await user.click(await screen.findByRole('button', { name: 'Create a document' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not create this document in IndexedDB')
    expect(screen.getByText('Your first page is waiting.')).toBeInTheDocument()
  })

  it('shows corrupt local data as an error without overwriting it', async () => {
    const corruptData = '{broken local document list'
    window.localStorage.setItem('tsg.documents.v1', corruptData)
    renderApp()

    expect(await screen.findByRole('alert')).toHaveTextContent('not valid JSON')
    expect(window.localStorage.getItem('tsg.documents.v1')).toBe(corruptData)
  })

  it('migrates legacy documents before displaying the dashboard and keeps the source copy', async () => {
    const legacy = {
      id: 'migrated-in-ui', title: 'Pre-existing draft', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep this text' }] }] },
      createdAt: 111, updatedAt: 222,
    }
    window.localStorage.setItem('tsg.documents.v1', JSON.stringify([legacy]))
    renderApp()

    expect(await screen.findByRole('link', { name: 'Pre-existing draft' })).toBeInTheDocument()
    expect(window.localStorage.getItem('tsg.documents.v1')).toBe(JSON.stringify([legacy]))
    await expect(new IndexedDBDocumentRepository().list()).resolves.toEqual([legacy])
  })
})
