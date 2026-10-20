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
