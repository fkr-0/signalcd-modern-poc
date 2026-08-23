import { mkdir } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'

const baseURL = process.env.DOCS_CAPTURE_BASE_URL ?? 'http://127.0.0.1:4175'
const toyBaseUrl = process.env.DOCS_CAPTURE_TOY_URL ?? 'http://127.0.0.1:28184'
const outDir = new URL('../docs/assets/', import.meta.url)

await mkdir(outDir, { recursive: true })

async function register(page, name) {
  await page.goto(baseURL)
  await expect(page.getByRole('heading', { name: 'Create your local identity.' })).toBeVisible()
  await page.getByLabel('Display name').fill(name)
  await page.getByRole('button', { name: 'Create identity' }).click()
  await expect(page.getByRole('heading', { name: 'Your encrypted workspace.' })).toBeVisible()
  await expect(page.getByRole('status')).toContainText(/ready\s*·\s*online/i)
}

async function storedIdentity(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('e2e-col-identity')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('identity database open failed'))
    })
    const identities = await new Promise((resolve, reject) => {
      const request = db.transaction('identities').objectStore('identities').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('failed to read identities'))
    })
    const sessions = await new Promise((resolve, reject) => {
      const request = db.transaction('sessions').objectStore('sessions').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('failed to read sessions'))
    })
    db.close()
    if (identities.length !== 1 || sessions.length !== 1) throw new Error('expected one identity')
    return {
      userId: identities[0].userId,
      phoneNumber: identities[0].phoneNumber,
      sessionToken: sessions[0].sessionToken
    }
  })
}

async function createLocallyRootedDocument(page) {
  const before = new URL(page.url()).searchParams.get('document')
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get('document')).not.toBe(before)
  const documentId = new URL(page.url()).searchParams.get('document')
  if (!documentId) throw new Error('document id missing after New')
  return documentId
}

async function createEncryptedGroup(identity, documentId) {
  const response = await fetch(`${toyBaseUrl}/api/v1/groups`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${identity.sessionToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ document_id: documentId, name: 'Documentation PoC proof' })
  })
  if (response.status !== 201) throw new Error(`group creation failed: ${response.status}`)
  return (await response.json()).group_id
}

async function openEncryptedGroup(page, groupId, documentId) {
  await page.goto(
    `${baseURL}/?group=${encodeURIComponent(groupId)}&document=${encodeURIComponent(documentId)}`
  )
  await expect(page.getByRole('heading', { name: 'Your encrypted workspace.' })).toBeVisible()
  await expect(page.getByRole('status')).toContainText(/ready\s*·\s*online/i)
  await expect(page.getByText('Encrypted mock Signal group')).toBeVisible()
}

async function invite(page, participant) {
  await page.getByRole('button', { name: 'Share' }).click()
  await page.getByLabel('Phone number').fill(participant.phoneNumber)
  await page.getByLabel('Role').selectOption('writer')
  await page.getByRole('button', { name: 'Invite', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Invite participant' })).not.toBeVisible()
}

const browser = await chromium.launch({ headless: true })
const aliceContext = await browser.newContext({ viewport: { width: 1440, height: 980 } })
const bobContext = await browser.newContext({ viewport: { width: 1440, height: 980 } })
const alicePage = await aliceContext.newPage()
const bobPage = await bobContext.newPage()

try {
  await register(alicePage, 'PoC Alice')
  await register(bobPage, 'PoC Bob')
  const alice = await storedIdentity(alicePage)
  const bob = await storedIdentity(bobPage)
  const documentId = await createLocallyRootedDocument(alicePage)
  const groupId = await createEncryptedGroup(alice, documentId)

  await openEncryptedGroup(alicePage, groupId, documentId)
  await invite(alicePage, bob)
  await openEncryptedGroup(bobPage, groupId, documentId)

  const proofText = 'Successful encrypted PoC convergence\nAlice → toy Signal → Bob'
  await alicePage.locator('textarea').fill(proofText)
  await expect(bobPage.locator('textarea')).toHaveValue(proofText)

  await alicePage.screenshot({
    path: new URL('poc-e2e-alice.png', outDir).pathname,
    fullPage: true
  })
  await bobPage.screenshot({
    path: new URL('poc-e2e-bob.png', outDir).pathname,
    fullPage: true
  })

  await alicePage.getByRole('button', { name: 'Dashboard' }).click()
  await expect(alicePage.getByText('Sidecar dashboard')).toBeVisible()
  await alicePage.screenshot({
    path: new URL('poc-e2e-inspector.png', outDir).pathname,
    fullPage: true
  })

  console.log(`captured successful two-client PoC for document ${documentId}`)
} finally {
  await Promise.all([aliceContext.close(), bobContext.close()])
  await browser.close()
}
