import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import DocumentEditor from './DocumentEditor'
import type { DocumentRecord } from '../documents/types'

const blankDocument: DocumentRecord = {
  id: 'test-document', title: 'Field notes', content: { type: 'doc', content: [{ type: 'paragraph' }] },
  createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000,
}
let documentSequence = 0

afterEach(() => cleanup())

function renderEditor(onSave: (patch: { title?: string; content?: DocumentRecord['content'] }) => Promise<boolean> = vi.fn(async () => true)) {
  return render(<MemoryRouter><DocumentEditor document={{ ...blankDocument, id: `${blankDocument.id}-${++documentSequence}` }} onSave={onSave}/></MemoryRouter>)
}

describe('DocumentEditor', () => {
  it('renders the rich text toolbar and local save status', async () => {
    renderEditor()

    expect(await screen.findByRole('toolbar', { name: 'Text formatting' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Checklist' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Insert table' })).toBeInTheDocument()
    expect(screen.getByText('Saved on this device')).toBeInTheDocument()
  })

  it('applies heading and inline-format commands', async () => {
    const user = userEvent.setup()
    renderEditor()

    await screen.findByRole('toolbar', { name: 'Text formatting' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Text style' }), 'h1')
    await waitFor(() => expect(document.querySelector('.ProseMirror h1')).toBeTruthy())
    await user.click(screen.getByRole('button', { name: 'Bold' }))
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('debounces editor changes into an autosaved rich-text document', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => true)
    renderEditor(onSave)

    await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy())
    const editable = document.querySelector<HTMLElement>('.ProseMirror')!
    await user.click(editable)
    await user.type(editable, 'A thoughtful local draft')

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ content: expect.objectContaining({ type: 'doc' }) })), { timeout: 3000 })
    expect(screen.getByText(/4 words/u)).toBeInTheDocument()
    expect(screen.getByText(/24 characters/u)).toBeInTheDocument()
  })

  it('autosaves a renamed title and enforces the title length limit', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => true)
    renderEditor(onSave)

    const title = await screen.findByRole('textbox', { name: 'Document title' })
    await user.clear(title)
    await user.type(title, 'A better title')
    fireEvent.blur(title)

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ title: 'A better title' }))
    expect(title).toHaveAttribute('maxLength', '120')
  })

  it('shows a save failure when the local repository rejects a write', async () => {
    const user = userEvent.setup()
    renderEditor(async () => false)
    const title = await screen.findByRole('textbox', { name: 'Document title' })
    await user.clear(title)
    await user.type(title, 'Unsaved change')
    fireEvent.blur(title)
    expect(await screen.findByText('Save failed')).toBeInTheDocument()
  })
})
