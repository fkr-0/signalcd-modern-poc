import { expect, type Page, test } from '@playwright/test'

const toyPort = process.env.E2E_COL_TEST_PEERJS_TOY_PORT ?? '18081'
const toyBaseUrl = `http://127.0.0.1:${toyPort}`
const rendezvousCapability = 'peerjs-browser-e2e-capability-0123456789abcdef'

interface StoredIdentityClaim {
  readonly userId: string
  readonly phoneNumber: string
}

async function register(page: Page, name: string): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Create your local identity.' })).toBeVisible()
  await page.getByLabel('Display name').fill(name)
  await page.getByRole('button', { name: 'Create identity' }).click()
  await expect(page.getByRole('heading', { name: 'Your encrypted workspace.' })).toBeVisible()
  await expect(page.getByRole('status')).toContainText(/ready\s*·\s*online/i)
}

async function storedIdentity(page: Page): Promise<StoredIdentityClaim> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('e2e-col-identity')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('identity database open failed'))
    })
    const readAll = <T>(store: string) =>
      new Promise<T[]>((resolve, reject) => {
        const request = db.transaction(store).objectStore(store).getAll()
        request.onsuccess = () => resolve(request.result as T[])
        request.onerror = () => reject(request.error ?? new Error(`failed to read ${store}`))
      })
    const identities = await readAll<{ userId: string; phoneNumber: string }>('identities_v2')
    const sessions = await readAll<{
      userId: string
      sessionTokenCiphertext?: Uint8Array
      iv?: Uint8Array
      sessionToken?: string
    }>('sessions_v2')
    db.close()
    if (
      identities.length !== 1 ||
      sessions.length !== 1 ||
      identities[0]?.userId !== sessions[0]?.userId
    )
      throw new Error('expected exactly one persisted browser identity/session')
    if (
      sessions[0]?.sessionToken !== undefined ||
      sessions[0]?.sessionTokenCiphertext === undefined ||
      sessions[0]?.iv === undefined
    )
      throw new Error('browser bearer session was not wrapped at rest')
    return {
      userId: identities[0]!.userId,
      phoneNumber: identities[0]!.phoneNumber
    }
  })
}

async function createLocallyRootedDocument(page: Page): Promise<string> {
  const prior = new URL(page.url()).searchParams.get('document')
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get('document')).not.toBe(prior)
  const documentId = new URL(page.url()).searchParams.get('document')
  if (!documentId) throw new Error('local document creation did not publish a document id')
  return documentId
}

async function createEncryptedGroup(
  page: Page,
  identity: StoredIdentityClaim,
  documentId: string
): Promise<string> {
  const result = await page.evaluate(
    async ({ baseUrl, expectedUserId, targetDocumentId }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('e2e-col-identity')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('identity database open failed'))
      })
      const session = await new Promise<{
        userId: string
        sessionTokenCiphertext: Uint8Array
        iv: Uint8Array
      }>((resolve, reject) => {
        const request = db.transaction('sessions_v2').objectStore('sessions_v2').get(expectedUserId)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('failed to read wrapped session'))
      })
      const wrappingKey = await new Promise<CryptoKey>((resolve, reject) => {
        const request = db
          .transaction('wrapping_keys_v3')
          .objectStore('wrapping_keys_v3')
          .get('x25519-aes-gcm-v1')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('failed to read wrapping key'))
      })
      db.close()
      const plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: session.iv,
            additionalData: new TextEncoder().encode(`e2e-col/session-token/v1:${session.userId}`)
          },
          wrappingKey,
          session.sessionTokenCiphertext
        )
      )
      const token = new TextDecoder().decode(plaintext)
      plaintext.fill(0)
      const response = await fetch(`${baseUrl}/api/v1/groups`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ document_id: targetDocumentId, name: 'PeerJS browser E2E' })
      })
      const body = (await response.json()) as { group_id?: string }
      return { status: response.status, groupId: body.group_id }
    },
    { baseUrl: toyBaseUrl, expectedUserId: identity.userId, targetDocumentId: documentId }
  )
  expect(result.status).toBe(201)
  if (!result.groupId) throw new Error('group creation did not return group_id')
  return result.groupId
}

async function openPeerJsGroup(page: Page, groupId: string, documentId: string): Promise<void> {
  await page.goto(
    `/?group=${encodeURIComponent(groupId)}&document=${encodeURIComponent(documentId)}#peerjs=${encodeURIComponent(rendezvousCapability)}`
  )
  await expect(page.getByRole('heading', { name: 'Your encrypted workspace.' })).toBeVisible()
  await expect
    .poll(
      async () => {
        const alerts = page.getByRole('alert')
        const alert = (await alerts.count()) > 0 ? await alerts.first().textContent() : null
        return alert ? `ERROR: ${alert}` : ((await page.getByRole('status').textContent()) ?? '')
      },
      { timeout: 15_000 }
    )
    .toMatch(/ready\s*·\s*online/i)
  await expect(page.getByText('Encrypted PeerJS Signal-semantics demo')).toBeVisible()
}

async function waitForPeerJsReconnect(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click()
  const reconnectValue = page
    .getByText('reconnect_count', { exact: true })
    .locator('..')
    .locator('code')
  await expect
    .poll(async () => Number(await reconnectValue.textContent()), { timeout: 55_000 })
    .toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Workspace', exact: true }).click()
  await expect(page.getByRole('status')).toContainText(/ready\s*·\s*online/i, { timeout: 10_000 })
}

async function expectEditorValueOrError(
  page: Page,
  expected: string,
  label: string,
  timeout = 15_000
): Promise<void> {
  await expect
    .poll(
      async () => {
        const alerts = page.getByRole('alert')
        const alert = (await alerts.count()) > 0 ? await alerts.first().textContent() : null
        if (alert) return `ERROR(${label}): ${alert}`
        return await page.locator('textarea').inputValue()
      },
      { timeout }
    )
    .toBe(expected)
}

async function invite(page: Page, identity: StoredIdentityClaim): Promise<void> {
  await page.getByRole('button', { name: 'Share' }).click()
  await page.getByLabel('Phone number').fill(identity.phoneNumber)
  await page.getByLabel('Role').selectOption('writer')
  await page.getByRole('button', { name: 'Invite', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Invite participant' })).not.toBeVisible()
}

test('three encrypted browser clients converge through local PeerServer and survive hub loss', async ({
  browser
}) => {
  const aliceContext = await browser.newContext()
  const bobContext = await browser.newContext()
  const charlieContext = await browser.newContext()
  const alicePage = await aliceContext.newPage()
  const bobPage = await bobContext.newPage()
  const charliePage = await charlieContext.newPage()

  try {
    await register(alicePage, 'PeerJS Alice')
    await register(bobPage, 'PeerJS Bob')
    await register(charliePage, 'PeerJS Charlie')
    const alice = await storedIdentity(alicePage)
    const bob = await storedIdentity(bobPage)
    const charlie = await storedIdentity(charliePage)

    const documentId = await createLocallyRootedDocument(alicePage)
    const groupId = await createEncryptedGroup(alicePage, alice, documentId)
    await openPeerJsGroup(alicePage, groupId, documentId)
    await invite(alicePage, bob)
    await openPeerJsGroup(bobPage, groupId, documentId)

    const aliceText = `peerjs-alice-${documentId}`
    await alicePage.locator('textarea').fill(aliceText)
    await expectEditorValueOrError(alicePage, aliceText, 'alice-send')
    await expectEditorValueOrError(bobPage, aliceText, 'bob-receive')

    await invite(alicePage, charlie)
    await openPeerJsGroup(charliePage, groupId, documentId)
    await expect(charliePage.locator('textarea')).toHaveValue(aliceText, { timeout: 15_000 })

    // The first browser owns the well-known room id. Closing it exercises the
    // real WebRTC close -> peerjslib re-election path against local PeerServer.
    await aliceContext.close()
    await Promise.all([waitForPeerJsReconnect(bobPage), waitForPeerJsReconnect(charliePage)])

    const charlieText = `${aliceText}\npeerjs-charlie-after-hub-loss`
    await charliePage.locator('textarea').fill(charlieText)
    await expect(bobPage.locator('textarea')).toHaveValue(charlieText, { timeout: 20_000 })

    // The toy service is still used for identity/group/evidence metadata, but
    // PeerJS transport must not accidentally route document ciphertext through
    // the mock Signal message endpoint.
    const stateResponse = await fetch(`${toyBaseUrl}/__toy__/v1/state`)
    expect(stateResponse.status).toBe(200)
    const stateText = await stateResponse.text()
    expect(stateText).not.toContain(aliceText)
    expect(stateText).not.toContain('peerjs-charlie-after-hub-loss')
    const state = JSON.parse(stateText) as {
      collaboration: { messages: Array<{ group_id: string }> }
    }
    expect(state.collaboration.messages.filter((message) => message.group_id === groupId)).toEqual(
      []
    )
  } finally {
    await Promise.allSettled([aliceContext.close(), bobContext.close(), charlieContext.close()])
  }
})
