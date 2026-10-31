import { chromium, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSignalingService } from '../signaling/server'

const signaling = createSignalingService(null)
test.beforeAll(async () => {
  await new Promise<void>(resolve => signaling.server.listen(4444, '127.0.0.1', resolve))
})
test.afterAll(async () => { await signaling.close() })

test('independent browser contexts exchange Yjs changes over WebRTC and converge', async ({ browser, baseURL }) => {
  const signalingFrames: string[] = []
  const first = await browser.newContext()
  const second = await browser.newContext()
  const firstPage = await first.newPage()
  const secondPage = await second.newPage()
  firstPage.on('websocket', socket => {
    if (socket.url().includes(':4444/')) socket.on('framesent', frame => signalingFrames.push(String(frame.payload)))
  })

  try {
    await firstPage.goto(`${baseURL}/app`)
    await firstPage.getByRole('button', { name: 'New document', exact: true }).click()
    await expect(firstPage.locator('[contenteditable="true"]')).toBeVisible()
    const roomUrl = firstPage.url()
    const roomId = roomUrl.split('/').pop()!

    await secondPage.goto(roomUrl)
    await secondPage.getByRole('button', { name: 'Join document' }).click()
    await expect(secondPage.locator('[contenteditable="true"]')).toBeVisible()
    await expect(firstPage.locator('[data-network-status="connected"]')).toBeVisible({ timeout: 30_000 })
    await expect(secondPage.locator('[data-network-status="connected"]')).toBeVisible({ timeout: 30_000 })
    await expect(firstPage.locator('.peer-avatar')).toHaveCount(1)

    const firstEditor = firstPage.locator('[contenteditable="true"]')
    const secondEditor = secondPage.locator('[contenteditable="true"]')
    await firstEditor.click()
    await firstPage.keyboard.insertText('changes sent over a WebRTC data channel')
    await expect(secondEditor).toContainText('changes sent over a WebRTC data channel', { timeout: 20_000 })
    await secondEditor.click()
    await expect(firstEditor.locator('.collaboration-carets__caret')).toBeVisible({ timeout: 10_000 })
    await secondPage.keyboard.press('End')
    await secondPage.keyboard.insertText(' and the reply came back')
    await expect(firstEditor).toContainText('and the reply came back', { timeout: 20_000 })
    const firstContent = await normalizedDocumentText(firstEditor)
    await expect.poll(() => normalizedDocumentText(secondEditor)).toBe(firstContent)

    expect(roomId).toMatch(/^[a-zA-Z0-9-]+$/)
    expect(signalingFrames.join('\n')).not.toContain('changes sent over a WebRTC data channel')
    expect(signalingFrames.join('\n')).not.toContain('the reply came back')

    await secondPage.close()
    await expect.poll(() => firstPage.locator('.peer-status').getAttribute('data-network-status'), { timeout: 20_000 }).not.toBe('connected')
    const reopened = await second.newPage()
    await reopened.goto(roomUrl)
    await expect(reopened.locator('[contenteditable="true"]')).toBeVisible()
    await expect(firstPage.locator('[data-network-status="connected"]')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => normalizedDocumentText(reopened.locator('[contenteditable="true"]'))).toBe(firstContent)

    signaling.interrupt()
    await expect(firstPage.locator('.peer-status')).toHaveAttribute('data-signaling-connected', 'false', { timeout: 20_000 })
    signaling.resume()
    await expect(firstPage.locator('.peer-status')).toHaveAttribute('data-signaling-connected', 'true', { timeout: 30_000 })
    await firstEditor.click()
    await firstPage.keyboard.press('End')
    await firstPage.keyboard.insertText(' after signaling recovery')
    await expect(reopened.locator('[contenteditable="true"]')).toContainText('after signaling recovery', { timeout: 20_000 })
  } finally {
    await first.close()
    await second.close()
  }
})

test('three independent contexts discover each other and document IDs isolate rooms', async ({ browser, baseURL }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()])
  const pages = await Promise.all(contexts.map(context => context.newPage()))
  try {
    await pages[0].goto(`${baseURL}/app`)
    await pages[0].getByRole('button', { name: 'New document', exact: true }).click()
    await expect(pages[0].locator('[contenteditable="true"]')).toBeVisible()
    const sharedUrl = pages[0].url()
    for (const page of pages.slice(1)) {
      await page.goto(sharedUrl)
      await page.getByRole('button', { name: 'Join document' }).click()
      await expect(page.locator('[contenteditable="true"]')).toBeVisible()
    }
    await expect(pages[0].locator('[data-network-status="connected"]')).toBeVisible({ timeout: 30_000 })
    await expect(pages[0].locator('.peer-avatar')).toHaveCount(2, { timeout: 30_000 })
    const editors = pages.map(page => page.locator('[contenteditable="true"]'))
    await Promise.all([editors[0].click(), editors[1].click()])
    await Promise.all([
      pages[0].keyboard.insertText('Concurrent edit from peer one. '),
      pages[1].keyboard.insertText('Concurrent edit from peer two. '),
    ])
    for (const editor of editors) {
      await expect(editor).toContainText('Concurrent edit from peer one.', { timeout: 20_000 })
      await expect(editor).toContainText('Concurrent edit from peer two.', { timeout: 20_000 })
    }
    const expectedConcurrentText = await normalizedDocumentText(editors[0])
    await expect.poll(() => normalizedDocumentText(editors[1])).toBe(expectedConcurrentText)
    await expect.poll(() => normalizedDocumentText(editors[2])).toBe(expectedConcurrentText)
    await pages[1].locator('[contenteditable="true"]').click()
    await pages[1].keyboard.insertText('three peer update')
    await expect(pages[0].locator('[contenteditable="true"]')).toContainText('three peer update', { timeout: 20_000 })
    await expect(pages[2].locator('[contenteditable="true"]')).toContainText('three peer update', { timeout: 20_000 })
    const isolated = await contexts[2].newPage()
    await isolated.goto(`${baseURL}/document/isolated-room-7ca02b`)
    await isolated.getByRole('button', { name: 'Join document' }).click()
    await expect(isolated.locator('[data-network-status="waiting"]')).toBeVisible({ timeout: 20_000 })
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()))
  }
})

test('named version restore synchronizes to an offline peer after reconnecting', async ({ browser, baseURL }) => {
  const first = await browser.newContext()
  const second = await browser.newContext()
  const firstPage = await first.newPage()
  const secondPage = await second.newPage()
  try {
    await firstPage.goto(`${baseURL}/app`)
    await firstPage.getByRole('button', { name: 'New document', exact: true }).click()
    const firstEditor = firstPage.locator('[contenteditable="true"]')
    await expect(firstEditor).toBeVisible()
    const roomUrl = firstPage.url()
    await firstEditor.click()
    await firstPage.keyboard.insertText('The approved proposal keeps its original introduction and detailed project context.')
    await firstEditor.press('Control+A')
    await firstPage.getByRole('button', { name: 'Bold' }).click()
    await expect(firstEditor.locator('strong')).toContainText('approved proposal')
    await firstPage.getByRole('button', { name: 'Open version history' }).click()
    const firstHistory = firstPage.getByRole('dialog', { name: 'Version history' })
    await firstHistory.locator('#version-name').fill('Initial draft')
    await firstHistory.getByRole('button', { name: 'Save version' }).click()
    await expect(firstHistory.locator('.version-list')).toContainText('Initial draft')

    await secondPage.goto(roomUrl)
    await secondPage.getByRole('button', { name: 'Join document' }).click()
    const secondEditor = secondPage.locator('[contenteditable="true"]')
    await expect(secondEditor).toContainText('approved proposal', { timeout: 20_000 })
    await expect(firstPage.locator('[data-network-status="connected"]')).toBeVisible({ timeout: 30_000 })
    await expect(secondPage.locator('.version-history-button')).toBeVisible()

    await second.setOffline(true)
    await expect(secondPage.locator('[data-network-status="offline"]')).toBeVisible({ timeout: 10_000 })
    await firstHistory.getByRole('button', { name: 'Close version history' }).click()
    await firstEditor.click()
    await firstPage.keyboard.press('Control+A')
    await firstPage.keyboard.insertText('A newer draft now contains replacement text that will be rolled back to the approved proposal version.')
    await firstPage.getByRole('button', { name: 'Open version history' }).click()
    const restoreHistory = firstPage.getByRole('dialog', { name: 'Version history' })
    await restoreHistory.locator('#version-name').fill('Newer draft')
    await restoreHistory.getByRole('button', { name: 'Save version' }).click()
    firstPage.on('dialog', dialog => dialog.accept())
    await restoreHistory.locator('.version-list li').filter({ hasText: 'Initial draft' }).getByRole('button', { name: 'Restore' }).click()
    await expect(firstEditor).toContainText('approved proposal')
    await expect(firstEditor.locator('strong')).toContainText('approved proposal')
    await expect(restoreHistory.locator('.version-list')).toContainText('Restored “Initial draft”')

    await second.setOffline(false)
    await expect(firstPage.locator('[data-network-status="connected"]')).toBeVisible({ timeout: 30_000 })
    await expect(secondEditor).toContainText('approved proposal', { timeout: 30_000 })
    await secondPage.getByRole('button', { name: 'Open version history' }).click()
    const recoveredHistory = secondPage.getByRole('dialog', { name: 'Version history' })
    await expect(recoveredHistory.locator('.version-list')).toContainText('Restored “Initial draft”', { timeout: 20_000 })
    await expect(recoveredHistory.locator('.version-current')).toContainText('Synced with connected peers', { timeout: 30_000 })
  } finally {
    await Promise.allSettled([first.close(), second.close()])
  }
})

test('version deletion confirms, syncs to peers, persists after browser restart, and leaves current content intact', async ({ browser, baseURL }) => {
  const profile = await mkdtemp(join(tmpdir(), 'tsg-version-delete-profile-'))
  let first = await chromium.launchPersistentContext(profile, { headless: true })
  const second = await browser.newContext()
  try {
    let firstPage = first.pages()[0] ?? await first.newPage()
    const secondPage = await second.newPage()
    await firstPage.goto(`${baseURL}/app`)
    await firstPage.getByRole('button', { name: 'New document', exact: true }).click()
    const roomUrl = firstPage.url()
    const firstEditor = firstPage.locator('[contenteditable="true"]')
    await firstEditor.click()
    await firstPage.keyboard.insertText('Historical proposal version with its original detail and formatting.')
    await firstPage.getByRole('button', { name: 'Open version history' }).click()
    const firstHistory = firstPage.getByRole('dialog', { name: 'Version history' })
    await firstHistory.locator('#version-name').fill('Saved proposal')
    await firstHistory.getByRole('button', { name: 'Save version' }).click()

    await secondPage.goto(roomUrl)
    await secondPage.getByRole('button', { name: 'Join document' }).click()
    const secondEditor = secondPage.locator('[contenteditable="true"]')
    await expect(secondEditor).toContainText('Historical proposal', { timeout: 20_000 })
    await expect(firstPage.locator('[data-network-status="connected"]')).toBeVisible({ timeout: 30_000 })
    await secondPage.getByRole('button', { name: 'Open version history' }).click()
    const secondHistory = secondPage.getByRole('dialog', { name: 'Version history' })
    await expect(secondHistory.locator('.version-list')).toContainText('Saved proposal')

    await firstHistory.getByRole('button', { name: 'Close version history' }).click()
    await firstEditor.click()
    await firstPage.keyboard.press('Control+A')
    await firstPage.keyboard.insertText('Current live document content must remain unchanged when history is deleted.')
    await firstPage.getByRole('button', { name: 'Open version history' }).click()
    const activeHistory = firstPage.getByRole('dialog', { name: 'Version history' })
    await activeHistory.locator('#version-name').fill('Current state')
    await activeHistory.getByRole('button', { name: 'Save version' }).click()
    await expect(activeHistory.locator('.version-list li').filter({ hasText: 'Current state' }).getByRole('button', { name: 'Delete version Current state' })).toBeDisabled()

    await expect(secondEditor).toContainText('Current live document content')
    const liveContentBeforeDelete = await normalizedDocumentText(secondEditor)
    const savedDelete = secondHistory.getByRole('button', { name: 'Delete version Saved proposal' })
    secondPage.once('dialog', dialog => dialog.dismiss())
    await savedDelete.click()
    await expect(secondHistory.locator('.version-list')).toContainText('Saved proposal')
    expect(await normalizedDocumentText(secondEditor)).toBe(liveContentBeforeDelete)

    firstPage.once('dialog', dialog => dialog.accept())
    await activeHistory.getByRole('button', { name: 'Delete version Saved proposal' }).click()
    await expect(activeHistory.locator('.version-list')).not.toContainText('Saved proposal')
    await expect(activeHistory.locator('.version-list')).toContainText('Current state')
    await expect(firstEditor).toContainText('Current live document content')
    await expect(secondHistory.locator('.version-list')).not.toContainText('Saved proposal', { timeout: 20_000 })
    expect(await normalizedDocumentText(secondEditor)).toBe(liveContentBeforeDelete)

    await first.close()
    first = await chromium.launchPersistentContext(profile, { headless: true })
    firstPage = first.pages()[0] ?? await first.newPage()
    await firstPage.goto(roomUrl)
    const recoveredEditor = firstPage.locator('[contenteditable="true"]')
    await expect(recoveredEditor).toContainText('Current live document content')
    await firstPage.getByRole('button', { name: 'Open version history' }).click()
    const recoveredHistory = firstPage.getByRole('dialog', { name: 'Version history' })
    await expect(recoveredHistory.locator('.version-list')).not.toContainText('Saved proposal')
    await expect(recoveredHistory.locator('.version-list')).toContainText('Current state')
    await expect(recoveredEditor).toContainText('Current live document content')
  } finally {
    await Promise.allSettled([first.close(), second.close()])
    await rm(profile, { recursive: true, force: true })
  }
})

test('offline overlapping edits survive browser restarts, prompt for resolution, and converge', async ({ browser, baseURL }) => {
  const first = await browser.newContext()
  const secondProfile = await mkdtemp(join(tmpdir(), 'tsg-conflict-profile-'))
  let second = await chromium.launchPersistentContext(secondProfile, { headless: true })
  const firstPage = await first.newPage()
  let secondPage = second.pages()[0] ?? await second.newPage()
  try {
    await firstPage.goto(`${baseURL}/app`)
    await firstPage.getByRole('button', { name: 'New document', exact: true }).click()
    const firstEditor = firstPage.locator('[contenteditable="true"]')
    await expect(firstEditor).toBeVisible()
    const roomUrl = firstPage.url()
    await firstEditor.click()
    await firstPage.keyboard.insertText('Formatted intro')
    await firstEditor.press('Control+A')
    await firstPage.getByRole('button', { name: 'Bold' }).click()
    await firstEditor.evaluate(element => {
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(element)
      range.collapse(false)
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
    await firstPage.keyboard.press('Enter')
    await expect(firstEditor.locator('p')).toHaveCount(2)
    await firstPage.getByRole('button', { name: 'Bold' }).click()
    await firstPage.keyboard.insertText('hello world')
    await expect(firstEditor.locator('p').first().locator('strong')).toHaveText('Formatted intro')
    await firstEditor.locator('p').filter({ hasText: 'hello world' }).click()
    await firstPage.keyboard.press('Home')
    await firstPage.keyboard.press('Shift+End')
    await firstPage.getByRole('button', { name: 'Bold' }).click()
    await expect(firstEditor.locator('p').filter({ hasText: 'hello world' }).locator('strong')).toHaveText('hello world')
    await secondPage.goto(roomUrl)
    await secondPage.getByRole('button', { name: 'Join document' }).click()
    let secondEditor = secondPage.locator('[contenteditable="true"]')
    await expect(secondEditor).toBeVisible()
    await expect(firstPage.locator('[data-network-status="connected"]')).toBeVisible({ timeout: 30_000 })
    await expect(secondEditor).toContainText('hello world', { timeout: 20_000 })

    await Promise.all([first.setOffline(true), second.setOffline(true)])
    await expect(firstPage.locator('[data-network-status="offline"]')).toBeVisible({ timeout: 10_000 })
    await expect(secondPage.locator('[data-network-status="offline"]')).toBeVisible({ timeout: 10_000 })
    await firstEditor.locator('p').filter({ hasText: 'hello world' }).click()
    await firstPage.keyboard.press('Home')
    await firstPage.keyboard.press('Shift+End')
    await firstPage.keyboard.insertText('hullo world')
    await secondEditor.locator('p').filter({ hasText: 'hello world' }).click()
    await secondPage.keyboard.press('Home')
    await secondPage.keyboard.press('Shift+End')
    await secondPage.keyboard.insertText('hallo world')
    await new Promise(resolve => setTimeout(resolve, 1_500))

    await second.close()
    second = await chromium.launchPersistentContext(secondProfile, { headless: true })
    await second.setOffline(false)
    secondPage = await second.newPage()
    await secondPage.goto(roomUrl)
    secondEditor = secondPage.locator('[contenteditable="true"]')
    await expect(secondEditor).toContainText('hallo world', { timeout: 20_000 })
    await expect(firstPage.locator('[data-network-status="offline"]')).toBeVisible()
    await first.setOffline(false)

    await expect(firstPage.locator('.conflict-toggle')).toHaveText('Review conflicts · 1', { timeout: 30_000 })
    await expect(secondPage.locator('.conflict-toggle')).toHaveText('Review conflicts · 1', { timeout: 30_000 })
    await second.close()
    second = await chromium.launchPersistentContext(secondProfile, { headless: true })
    secondPage = await second.newPage()
    await secondPage.goto(roomUrl)
    secondEditor = secondPage.locator('[contenteditable="true"]')
    await expect(secondPage.locator('.conflict-toggle')).toHaveText('Review conflicts · 1', { timeout: 20_000 })
    await secondPage.locator('.conflict-toggle').click()
    const recoveredDialog = secondPage.getByRole('dialog', { name: 'Conflict review' })
    await expect(recoveredDialog).toContainText('hullo world')
    await expect(recoveredDialog).toContainText('hallo world')
    await recoveredDialog.getByRole('button', { name: 'Close conflict review' }).click()
    await firstPage.locator('.conflict-toggle').click()
    const dialog = firstPage.getByRole('dialog', { name: 'Conflict review' })
    await expect(dialog).toContainText('hullo world')
    await expect(dialog).toContainText('hallo world')
    await expect(dialog.locator('.conflict-history')).toHaveCount(0)
    await expect(dialog.locator('.conflict-versions article')).toHaveCount(2)
    await dialog.getByRole('button', { name: /Keep version A|Keep version B/u }).first().click()
    await expect(firstPage.locator('.conflict-toggle')).toContainText('Conflict history', { timeout: 20_000 })
    await expect(secondPage.locator('.conflict-toggle')).toContainText('Conflict history', { timeout: 20_000 })
    await expect.poll(() => normalizedDocumentText(firstEditor)).toBe(await normalizedDocumentText(secondEditor))
    await expect(firstEditor).toContainText('Formatted intro')
    await expect(firstEditor.locator('p').filter({ hasText: 'Formatted intro' }).locator('strong')).toHaveText('Formatted intro')
    await expect(secondEditor.locator('p').filter({ hasText: 'Formatted intro' }).locator('strong')).toHaveText('Formatted intro')
    await expect(firstEditor.locator('p').filter({ hasText: /hullo world|hallo world/u }).locator('strong')).toHaveText(/hullo world|hallo world/u)
    await expect(secondEditor.locator('p').filter({ hasText: /hullo world|hallo world/u }).locator('strong')).toHaveText(/hullo world|hallo world/u)
  } finally {
    await Promise.allSettled([first.close(), second.close()])
    await rm(secondProfile, { recursive: true, force: true })
  }
})

test('two conflicting paragraphs produce two independent browser conflict entries', async ({ browser, baseURL }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()])
  const pages = await Promise.all(contexts.map(context => context.newPage()))
  const editors = pages.map(page => page.locator('[contenteditable="true"]'))
  try {
    await pages[0]!.goto(`${baseURL}/app`)
    await pages[0]!.getByRole('button', { name: 'New document', exact: true }).click()
    await expect(editors[0]!).toBeVisible()
    const roomUrl = pages[0]!.url()
    await editors[0]!.click()
    await pages[0]!.keyboard.insertText('First line')
    await editors[0]!.evaluate(element => {
      const selection = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(element)
      range.collapse(false)
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
    await pages[0]!.keyboard.press('Enter')
    await expect(editors[0]!.locator('p')).toHaveCount(2)
    await pages[0]!.keyboard.insertText('Second line')

    await pages[1]!.goto(roomUrl)
    await pages[1]!.getByRole('button', { name: 'Join document' }).click()
    await expect(editors[1]!).toContainText('Second line')
    await expect(pages[0]!.locator('[data-network-status="connected"]')).toBeVisible({ timeout: 30_000 })
    await Promise.all(contexts.map(context => context.setOffline(true)))
    for (const page of pages) await expect(page.locator('[data-network-status="offline"]')).toBeVisible()

    for (const [index, page] of pages.entries()) {
      const suffix = index === 0 ? ' A' : ' B'
      for (const original of ['First line', 'Second line']) {
        await editors[index]!.locator('p').filter({ hasText: original }).click()
        await page.keyboard.press('Home')
        await page.keyboard.press('Shift+End')
        await page.keyboard.insertText(`${original}${suffix}`)
      }
    }
    await Promise.all(contexts.map(context => context.setOffline(false)))
    await expect(pages[0]!.locator('.conflict-toggle')).toHaveText('Review conflicts · 2', { timeout: 30_000 })
    await expect(pages[1]!.locator('.conflict-toggle')).toHaveText('Review conflicts · 2', { timeout: 30_000 })
    await pages[0]!.locator('.conflict-toggle').click()
    const dialog = pages[0]!.getByRole('dialog', { name: 'Conflict review' })
    await expect(dialog.locator('.conflict-history button')).toHaveCount(2)
    const reviewed = await dialog.locator('.conflict-summary').first().innerText()
    const resolvedParagraphIndex = Number(reviewed.match(/Paragraph (\d+)/u)?.[1] ?? '1') - 1
    const untouchedParagraphIndex = resolvedParagraphIndex === 0 ? 1 : 0
    const untouchedParagraph = (await editors[0]!.locator('p').allInnerTexts())[untouchedParagraphIndex]
    await dialog.getByRole('button', { name: /Keep version A|Keep version B/u }).first().click()
    await expect(pages[0]!.locator('.conflict-toggle')).toHaveText('Review conflicts · 1')
    await expect(pages[1]!.locator('.conflict-toggle')).toHaveText('Review conflicts · 1')
    expect(reviewed).toContain('Paragraph')
    await expect.poll(() => normalizedDocumentText(editors[0]!)).toBe(await normalizedDocumentText(editors[1]!))
    await expect(editors[0]!.locator('p').nth(untouchedParagraphIndex)).toHaveText(untouchedParagraph ?? '')
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()))
  }
})

test('three offline peers reconnect in a different order and converge on independent edits', async ({ browser, baseURL }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()])
  const pages = await Promise.all(contexts.map(context => context.newPage()))
  try {
    await pages[0].goto(`${baseURL}/app`)
    await pages[0].getByRole('button', { name: 'New document', exact: true }).click()
    const editors = pages.map(page => page.locator('[contenteditable="true"]'))
    await expect(editors[0]).toBeVisible()
    const roomUrl = pages[0].url()
    await editors[0].click()
    await pages[0].keyboard.insertText('Section one')
    await pages[0].keyboard.press('Enter')
    await pages[0].keyboard.insertText('Section two')
    await pages[0].keyboard.press('Enter')
    await pages[0].keyboard.insertText('Section three')
    for (const page of pages.slice(1)) {
      await page.goto(roomUrl)
      await page.getByRole('button', { name: 'Join document' }).click()
      await expect(page.locator('[contenteditable="true"]')).toContainText('Section three', { timeout: 20_000 })
    }
    await expect(pages[0].locator('.peer-avatar')).toHaveCount(2, { timeout: 30_000 })
    await Promise.all(contexts.map(context => context.setOffline(true)))
    for (const page of pages) await expect(page.locator('[data-network-status="offline"]')).toBeVisible({ timeout: 10_000 })

    for (const [index, suffix] of [[0, ' edited by A'], [1, ' edited by B'], [2, ' edited by C']] as const) {
      await editors[index].locator('p').nth(index).click()
      await pages[index].keyboard.press('End')
      await pages[index].keyboard.insertText(suffix)
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
    for (const index of [2, 0, 1]) {
      await contexts[index]!.setOffline(false)
      await new Promise(resolve => setTimeout(resolve, 700))
    }
    for (const editor of editors) {
      await expect(editor).toContainText('edited by A', { timeout: 30_000 })
      await expect(editor).toContainText('edited by B', { timeout: 30_000 })
      await expect(editor).toContainText('edited by C', { timeout: 30_000 })
    }
    const converged = await normalizedDocumentText(editors[0]!)
    await expect.poll(() => normalizedDocumentText(editors[1]!)).toBe(converged)
    await expect.poll(() => normalizedDocumentText(editors[2]!)).toBe(converged)
    for (const page of pages) await expect(page.locator('[data-sync-status="synced"]')).toBeVisible({ timeout: 30_000 })
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()))
  }
})

async function normalizedDocumentText(editor: import('@playwright/test').Locator): Promise<string> {
  return editor.evaluate(element => {
    const clone = element.cloneNode(true) as HTMLElement
    clone.querySelectorAll('.collaboration-carets__caret, .collaboration-carets__selection').forEach(node => node.remove())
    return clone.innerText
  })
}
