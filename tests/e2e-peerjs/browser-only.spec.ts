import { expect, test } from '@playwright/test'

// This is the actual static GitHub-Pages-shaped build, not the toy identity API.
const url = 'http://127.0.0.1:4182/peerjs-demo.html'

test('static browser-only PeerJS demo converges and restores encrypted local state', async ({
  browser
}) => {
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  try {
    const a = await alice.newPage()
    const b = await bob.newPage()
    await a.goto(url)
    await expect(a.getByRole('heading', { name: 'Private collaborative draft' })).toBeVisible()
    await expect(a.getByRole('status')).toContainText('online', { timeout: 30_000 })
    const invitation = a.url()
    expect(invitation).toMatch(/#peerjs=[0-9a-f]{64}$/)
    await b.goto(invitation)
    await expect(b.getByRole('status')).toContainText('online', { timeout: 30_000 })

    await a.getByRole('textbox', { name: 'Shared document' }).fill('encrypted hello from alice')
    await expect(b.getByRole('textbox', { name: 'Shared document' })).toHaveValue(
      'encrypted hello from alice',
      { timeout: 30_000 }
    )

    await b
      .getByRole('textbox', { name: 'Shared document' })
      .fill('encrypted hello from alice\nand bob')
    await expect(a.getByRole('textbox', { name: 'Shared document' })).toHaveValue(
      'encrypted hello from alice\nand bob',
      { timeout: 30_000 }
    )

    // A private room only stores encrypted binary frames, not plaintext.
    const raw = await b.evaluate(async () => {
      const req = indexedDB.open('signalcd-peerjs-browser-demo-v1')
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      const saved = await new Promise<ArrayBuffer>((resolve, reject) => {
        const tx = db.transaction('snapshots')
        const get = tx
          .objectStore('snapshots')
          .get(new URL(location.href).searchParams.get('document'))
        get.onsuccess = () => resolve(get.result as ArrayBuffer)
        get.onerror = () => reject(get.error)
      })
      db.close()
      return new TextDecoder().decode(new Uint8Array(saved))
    })
    expect(raw).not.toContain('encrypted hello')

    await b.reload()
    await expect(b.getByRole('textbox', { name: 'Shared document' })).toHaveValue(
      'encrypted hello from alice\nand bob',
      { timeout: 30_000 }
    )
  } finally {
    await Promise.allSettled([alice.close(), bob.close()])
  }
})

test('truncated invitation fails closed instead of silently joining a different room', async ({
  page
}) => {
  const missingSecret = `${url}?document=11111111-1111-4111-8111-111111111111`
  await page.goto(missingSecret)
  await expect(page.getByRole('heading', { name: 'Cannot join this room' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText(
    'Some browsers or messaging applications strip'
  )
  expect(page.url()).toBe(missingSecret)
  await expect(page.getByRole('textbox', { name: 'Shared document' })).toHaveCount(0)
})

test('browser displays peer diagnostics and never treats signaling alone as collaboration', async ({
  page
}) => {
  await page.goto(url)
  await expect(page.getByRole('status')).toContainText('online', { timeout: 30_000 })
  await expect(page.getByLabel('Connection diagnostics')).toContainText('Connected peers')
  await expect(page.getByLabel('Connection diagnostics')).toContainText('Room')
})

test('mobile Chromium client joins an existing desktop invitation and receives encrypted edits', async ({
  browser,
  browserName
}) => {
  test.skip(browserName !== 'chromium', 'Mobile Chrome emulation belongs to Chromium')
  const desktop = await browser.newContext()
  const mobile = await browser.newContext({
    viewport: { width: 393, height: 852 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3
  })
  try {
    const a = await desktop.newPage()
    const b = await mobile.newPage()
    const diagnostics: string[] = []
    a.on('pageerror', (event) => diagnostics.push(`page: ${event.message}`))
    a.on('console', (event) => {
      if (event.type() === 'error') diagnostics.push(`console: ${event.text()}`)
    })
    await a.goto(url)
    try {
      await expect(a.getByRole('status')).toContainText('online', { timeout: 40_000 })
    } catch (cause) {
      console.log('Chrome initial signaling diagnostics:', diagnostics)
      console.log('Page alerts:', await a.locator('[role="alert"]').allTextContents())
      console.log('Peer health:', await a.getByLabel('Connection diagnostics').allTextContents())
      throw cause
    }
    const inviteUrl = a.url()
    await b.goto(inviteUrl)
    await expect(b.getByRole('status')).toContainText('online', { timeout: 30_000 })
    await a.getByRole('textbox', { name: 'Shared document' }).fill('desktop to mobile chrome')
    await expect(b.getByRole('textbox', { name: 'Shared document' })).toHaveValue(
      'desktop to mobile chrome',
      { timeout: 30_000 }
    )
    await expect(b.getByLabel('Connection diagnostics')).toContainText('Connected peers')
    await expect(b.getByLabel('Connection diagnostics')).toContainText(
      'Connected peers connected to hub'
    )
    await expect(b.getByLabel('Connection diagnostics')).not.toContainText(
      'no other browser is connected'
    )
  } finally {
    await Promise.allSettled([desktop.close(), mobile.close()])
  }
})
