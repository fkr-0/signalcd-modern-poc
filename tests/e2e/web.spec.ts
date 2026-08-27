import { chromium, expect, firefox, type Page, test, webkit } from '@playwright/test'

const toyPort = process.env.E2E_COL_TEST_TOY_PORT ?? '18080'
const toyBaseUrl = `http://127.0.0.1:${toyPort}`

async function register(page: Page, name: string) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Create your local identity.' })).toBeVisible()
  await page.getByLabel('Display name').fill(name)
  await page.getByRole('button', { name: 'Create identity' }).click()
  const workspaceHeading = page.getByRole('heading', { name: 'Your encrypted workspace.' })
  try {
    await expect(workspaceHeading).toBeVisible()
  } catch {
    const registrationError = await page
      .locator('.error-message')
      .textContent()
      .catch(() => undefined)
    throw new Error(
      `identity registration did not reach workspace${registrationError ? `: ${registrationError}` : ''}`
    )
  }
  await expect(page.locator('textarea')).toHaveCount(1)
  await expect(page.getByRole('status')).toContainText(/ready\s*·\s*online/i)
}

async function collaborationAuthorizationState(
  page: Page,
  userId: string,
  documentId: string
): Promise<{
  readonly revision: number
  readonly selfRole: string
  readonly archived: boolean
  readonly authorizationRoot?: string
  readonly authorizationHead?: string
  readonly authorizationStatus?: string
  readonly anchorKind?: string
}> {
  return page.evaluate(
    async ({ databaseName, targetDocumentId }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () =>
          reject(request.error ?? new Error('collaboration database open failed'))
      })
      const value = await new Promise<
        | {
            state: {
              revision: number
              selfRole: string
              archived: boolean
              authorizationRoot?: string
              authorizationHead?: string
              authorizationStatus?: string
            }
            authorization?: { anchorKind?: string }
          }
        | undefined
      >((resolve, reject) => {
        const request = db
          .transaction('access_control')
          .objectStore('access_control')
          .get(targetDocumentId)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('failed to read access_control'))
      })
      db.close()
      if (!value) throw new Error('authorization state was not persisted')
      return {
        revision: value.state.revision,
        selfRole: value.state.selfRole,
        archived: value.state.archived,
        ...(value.state.authorizationRoot === undefined
          ? {}
          : { authorizationRoot: value.state.authorizationRoot }),
        ...(value.state.authorizationHead === undefined
          ? {}
          : { authorizationHead: value.state.authorizationHead }),
        ...(value.state.authorizationStatus === undefined
          ? {}
          : { authorizationStatus: value.state.authorizationStatus }),
        ...(value.authorization?.anchorKind === undefined
          ? {}
          : { anchorKind: value.authorization.anchorKind })
      }
    },
    { databaseName: `e2e-col-${userId}`, targetDocumentId: documentId }
  )
}

interface StoredIdentityClaim {
  readonly userId: string
  readonly phoneNumber: string
  readonly sessionToken: string
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
    const sessions = await readAll<{ userId: string; sessionToken: string }>('sessions_v2')
    db.close()
    if (
      identities.length !== 1 ||
      sessions.length !== 1 ||
      identities[0]?.userId !== sessions[0]?.userId
    )
      throw new Error('expected exactly one persisted browser identity/session')
    return {
      userId: identities[0]!.userId,
      phoneNumber: identities[0]!.phoneNumber,
      sessionToken: sessions[0]!.sessionToken
    }
  })
}

async function createEncryptedGroup(
  alice: StoredIdentityClaim,
  documentId: string
): Promise<string> {
  const createdResponse = await fetch(`${toyBaseUrl}/api/v1/groups`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${alice.sessionToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ document_id: documentId, name: 'Phase 2 encrypted browser proof' })
  })
  expect(createdResponse.status).toBe(201)
  const created = (await createdResponse.json()) as { group_id: string }
  return created.group_id
}

async function createLocallyRootedDocument(
  page: Page,
  identity: StoredIdentityClaim
): Promise<string> {
  const priorDocument = new URL(page.url()).searchParams.get('document')
  await page.getByRole('button', { name: 'New', exact: true }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get('document')).not.toBe(priorDocument)
  const documentId = new URL(page.url()).searchParams.get('document')
  if (!documentId) throw new Error('local document creation did not publish a document id')
  await expect
    .poll(() => collaborationAuthorizationState(page, identity.userId, documentId))
    .toMatchObject({
      revision: 0,
      selfRole: 'admin',
      authorizationStatus: 'active',
      anchorKind: 'verified-root'
    })
  return documentId
}

async function renameLocalDocument(page: Page, documentId: string, title: string): Promise<void> {
  const fallback = `Document ${documentId.slice(0, 8)}`
  const row = page.locator('.document-entry').filter({ hasText: fallback })
  await row.getByRole('button', { name: `Rename ${fallback}` }).click()
  await expect(page.getByRole('heading', { name: 'Rename document' })).toBeVisible()
  await expect(page.getByText(/stored only on this browser\/device/i)).toBeVisible()
  await page.getByLabel('Document title').fill(title)
  await page.getByRole('button', { name: 'Save title' }).click()
  await expect(page.getByRole('heading', { name: 'Rename document' })).not.toBeVisible()
  await expect(page.locator('.document-entry').filter({ hasText: title })).toBeVisible()
}

async function inviteEncryptedParticipant(
  page: Page,
  participant: StoredIdentityClaim,
  role: 'reader' | 'writer' | 'admin' = 'writer'
): Promise<void> {
  await page.getByRole('button', { name: 'Share' }).click()
  await page.getByLabel('Phone number').fill(participant.phoneNumber)
  await page.getByLabel('Role').selectOption(role)
  await page.getByRole('button', { name: 'Invite', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Invite participant' })).not.toBeVisible()
}

async function collaborationStorageState(
  page: Page,
  userId: string,
  documentId: string
): Promise<{
  readonly documentCount: number
  readonly outbound: readonly { id: string; kind: string; state: string; attempts?: number }[]
  readonly seen: readonly { messageId: string; seenAt: number }[]
}> {
  return page.evaluate(
    async ({ databaseName, targetDocumentId }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () =>
          reject(request.error ?? new Error('collaboration database open failed'))
      })
      const readAll = <T>(storeName: string) =>
        new Promise<T[]>((resolve, reject) => {
          const request = db.transaction(storeName).objectStore(storeName).getAll()
          request.onsuccess = () => resolve(request.result as T[])
          request.onerror = () =>
            reject(request.error ?? new Error(`failed to read collaboration store ${storeName}`))
        })
      const [documents, outbound, seen] = await Promise.all([
        readAll<{ documentId: string }>('documents'),
        readAll<{
          id: string
          documentId: string
          kind: string
          state: string
          attempts?: number
        }>('outbound'),
        readAll<{ documentId: string; messageId: string; seenAt: number }>('seen_messages')
      ])
      db.close()
      return {
        documentCount: documents.filter((entry) => entry.documentId === targetDocumentId).length,
        outbound: outbound
          .filter((entry) => entry.documentId === targetDocumentId)
          .map(({ id, kind, state, attempts }) => ({
            id,
            kind,
            state,
            ...(attempts === undefined ? {} : { attempts })
          })),
        seen: seen
          .filter((entry) => entry.documentId === targetDocumentId)
          .map(({ messageId, seenAt }) => ({ messageId, seenAt }))
      }
    },
    { databaseName: `e2e-col-${userId}`, targetDocumentId: documentId }
  )
}

function persistentBrowserType(browserName: string) {
  if (browserName === 'chromium') return chromium
  if (browserName === 'firefox') return firefox
  if (browserName === 'webkit') return webkit
  throw new Error(`unsupported Playwright browser ${browserName}`)
}

async function reopenPersistentPage(
  context: import('@playwright/test').BrowserContext,
  targetUrl: string
): Promise<Page> {
  const restored = context.pages()[0]
  if (!restored) {
    const page = await context.newPage()
    await page.goto(targetUrl)
    return page
  }

  // Persistent browsers may restore the prior tab asynchronously. Let that restored
  // page finish startup before navigating it; interrupting startup can expose an
  // empty IndexedDB view even though the profile was durably written on close.
  await restored.waitForLoadState('domcontentloaded')
  if (restored.url() !== targetUrl) await restored.goto(targetUrl)
  return restored
}

async function openEncryptedGroup(page: Page, groupId: string, documentId: string): Promise<void> {
  await page.goto(
    `/?group=${encodeURIComponent(groupId)}&document=${encodeURIComponent(documentId)}`
  )
  await expect(page.getByRole('heading', { name: 'Your encrypted workspace.' })).toBeVisible()
  await expect
    .poll(async () => {
      const status = (await page.getByRole('status').textContent()) ?? ''
      if (/error/i.test(status)) {
        const detail =
          (await page
            .getByRole('alert')
            .textContent()
            .catch(() => undefined)) ?? status
        throw new Error(`encrypted group open failed: ${detail}`)
      }
      return status
    })
    .toMatch(/ready\s*·\s*online/i)
  await expect(page.locator('textarea')).toHaveCount(1)
  await expect(page.getByText('Encrypted mock Signal group')).toBeVisible()
}

test('registers one browser-owned identity and exposes one editor session', async ({ page }) => {
  await register(page, 'Ada')

  await expect(page.getByLabel('Current identity')).toContainText('Ada')
  await expect(page.getByTestId('identity-phone')).toHaveText(/^\+1555000\d{4}$/)
  await expect(page.getByText('Browser-owned keys')).toBeVisible()
  await expect(page.getByText(/Documents stay local-first/i)).toBeVisible()
})

test('restores the same identity and local document after browser reload', async ({ page }) => {
  await register(page, 'Grace')
  const phone = await page.getByTestId('identity-phone').textContent()
  const editor = page.locator('textarea')
  await editor.fill('durable local draft')
  await expect(editor).toHaveValue('durable local draft')

  await page.reload()

  await expect(page.getByRole('heading', { name: 'Your encrypted workspace.' })).toBeVisible()
  await expect(page.getByTestId('identity-phone')).toHaveText(phone ?? '')
  await expect(page.locator('textarea')).toHaveValue('durable local draft')
})

test('keeps separate browser contexts as separate clients', async ({ browser }) => {
  const firstContext = await browser.newContext()
  const secondContext = await browser.newContext()
  const firstPage = await firstContext.newPage()
  const secondPage = await secondContext.newPage()

  try {
    await register(firstPage, 'Alice')
    await register(secondPage, 'Bob')
    const firstPhone = await firstPage.getByTestId('identity-phone').textContent()
    const secondPhone = await secondPage.getByTestId('identity-phone').textContent()
    expect(firstPhone).not.toBe(secondPhone)

    await firstPage.locator('textarea').fill('client one only')
    await expect(firstPage.locator('textarea')).toHaveValue('client one only')
    await expect(secondPage.locator('textarea')).toHaveValue('')
  } finally {
    await Promise.all([firstContext.close(), secondContext.close()])
  }
})

test('persists two local titles across profile restart and keeps group binding pinned to one UUID', async ({
  browserName,
  baseURL
}, testInfo) => {
  if (!baseURL) throw new Error('Playwright baseURL is required for persistent metadata coverage')
  const profileDir = testInfo.outputPath('metadata-profile')
  const browserType = persistentBrowserType(browserName)
  let context = await browserType.launchPersistentContext(profileDir, { baseURL })

  try {
    let page = context.pages()[0] ?? (await context.newPage())
    await register(page, `Metadata ${browserName}`)
    const identity = await storedIdentity(page)

    const alphaId = await createLocallyRootedDocument(page, identity)
    await page.locator('textarea').fill('alpha browser body')
    await renameLocalDocument(page, alphaId, 'Alpha local title')

    const betaId = await createLocallyRootedDocument(page, identity)
    await page.locator('textarea').fill('beta browser body')
    await renameLocalDocument(page, betaId, 'Beta local title')
    expect(betaId).not.toBe(alphaId)

    await page.locator('.document-row').filter({ hasText: 'Alpha local title' }).click()
    await expect(page.locator('textarea')).toHaveValue('alpha browser body')
    expect(new URL(page.url()).searchParams.get('document')).toBe(alphaId)
    await page.locator('.document-row').filter({ hasText: 'Beta local title' }).click()
    await expect(page.locator('textarea')).toHaveValue('beta browser body')
    expect(new URL(page.url()).searchParams.get('document')).toBe(betaId)

    const restartUrl = page.url()
    await context.close()
    context = await browserType.launchPersistentContext(profileDir, { baseURL })
    page = await reopenPersistentPage(context, restartUrl)
    await expect(page.getByRole('heading', { name: 'Your encrypted workspace.' })).toBeVisible()
    await expect(
      page.locator('.document-entry').filter({ hasText: 'Alpha local title' })
    ).toBeVisible()
    await expect(
      page.locator('.document-entry').filter({ hasText: 'Beta local title' })
    ).toBeVisible()
    await expect(page.locator('textarea')).toHaveValue('beta browser body')

    await page.locator('.document-row').filter({ hasText: 'Alpha local title' }).click()
    await expect(page.locator('textarea')).toHaveValue('alpha browser body')
    expect(new URL(page.url()).searchParams.get('document')).toBe(alphaId)

    const groupId = await createEncryptedGroup(identity, alphaId)
    await openEncryptedGroup(page, groupId, alphaId)
    await expect(page.getByRole('button', { name: 'New', exact: true })).toBeDisabled()
    await expect(
      page.locator('.document-row').filter({ hasText: 'Beta local title' })
    ).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Rename Beta local title' })).toBeDisabled()

    const groupUrl = page.url()
    await page.getByRole('button', { name: 'Rename Alpha local title' }).click()
    await page.getByLabel('Document title').fill('Alpha group-local title')
    await page.getByRole('button', { name: 'Save title' }).click()
    await expect(page.getByRole('heading', { name: 'Alpha group-local title' })).toBeVisible()
    expect(page.url()).toBe(groupUrl)
    expect(new URL(page.url()).searchParams.get('document')).toBe(alphaId)
    expect(new URL(page.url()).searchParams.get('group')).toBe(groupId)
  } finally {
    await context.close()
  }
})

test('explicit toy debug mode decrypts only the separate observer copy into the sync-log preview', async ({
  browser
}) => {
  const aliceContext = await browser.newContext()
  const bobContext = await browser.newContext()
  const alicePage = await aliceContext.newPage()
  const bobPage = await bobContext.newPage()

  try {
    await register(alicePage, 'Debug observer Alice')
    await register(bobPage, 'Debug observer Bob')
    const alice = await storedIdentity(alicePage)
    const bob = await storedIdentity(bobPage)
    const documentId = await createLocallyRootedDocument(alicePage, alice)
    const groupId = await createEncryptedGroup(alice, documentId)

    const enableResponse = await fetch(`${toyBaseUrl}/__toy__/v1/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ debugDecrypt: true })
    })
    expect(enableResponse.status).toBe(200)
    const capability = (await (
      await fetch(`${toyBaseUrl}/__toy__/v1/debug/observer-key`)
    ).json()) as Record<string, unknown>
    expect(Object.keys(capability).sort()).toEqual(['algorithm', 'key_id', 'public_key', 'version'])
    expect(JSON.stringify(capability)).not.toMatch(/private|session.?token|secret/i)

    await openEncryptedGroup(alicePage, groupId, documentId)
    await inviteEncryptedParticipant(alicePage, bob)
    await openEncryptedGroup(bobPage, groupId, documentId)

    const [aliceAuthorization, bobAuthorization] = await Promise.all([
      collaborationAuthorizationState(alicePage, alice.userId, documentId),
      collaborationAuthorizationState(bobPage, bob.userId, documentId)
    ])
    expect(aliceAuthorization).toMatchObject({
      revision: 1,
      selfRole: 'admin',
      authorizationStatus: 'active',
      anchorKind: 'verified-root'
    })
    expect(bobAuthorization).toMatchObject({
      revision: 1,
      selfRole: 'writer',
      authorizationRoot: aliceAuthorization.authorizationRoot,
      authorizationHead: aliceAuthorization.authorizationHead,
      authorizationStatus: 'active',
      anchorKind: 'verified-root'
    })
    const knownPlaintext = `observer-preview-${documentId}`
    await alicePage.locator('textarea').fill(knownPlaintext)
    await expect(bobPage.locator('textarea')).toHaveValue(knownPlaintext)

    await expect
      .poll(async () => {
        const entries = (await (
          await fetch(`${toyBaseUrl}/__toy__/v1/sync-log/export`)
        ).json()) as Array<Record<string, unknown>>
        return entries
          .filter(
            (entry) =>
              entry.level === 'decrypted' &&
              entry.documentId === documentId &&
              entry.signatureValid === true
          )
          .map((entry) => String(entry.preview ?? ''))
          .join('\n')
      })
      .toContain(knownPlaintext)

    const stateText = await (await fetch(`${toyBaseUrl}/__toy__/v1/state`)).text()
    expect(stateText).not.toContain(knownPlaintext)
    expect(stateText).not.toContain(alice.sessionToken)
    expect(stateText).not.toContain(bob.sessionToken)
    const entries = (await (
      await fetch(`${toyBaseUrl}/__toy__/v1/sync-log/export`)
    ).json()) as Array<Record<string, unknown>>
    const stripped = entries.map(({ preview: _preview, ...entry }) => entry)
    expect(JSON.stringify(stripped)).not.toContain(knownPlaintext)
    expect(JSON.stringify(entries)).not.toContain(alice.sessionToken)
    expect(JSON.stringify(entries)).not.toContain(bob.sessionToken)

    const disableResponse = await fetch(`${toyBaseUrl}/__toy__/v1/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ debugDecrypt: false })
    })
    expect(disableResponse.status).toBe(200)
    const disabledEntries = (await (
      await fetch(`${toyBaseUrl}/__toy__/v1/sync-log/export`)
    ).json()) as Array<Record<string, unknown>>
    expect(
      disabledEntries.some(
        (entry) => entry.documentId === documentId && entry.preview !== undefined
      )
    ).toBe(false)
    expect(JSON.stringify(disabledEntries)).not.toContain(knownPlaintext)
  } finally {
    await fetch(`${toyBaseUrl}/__toy__/v1/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ debugDecrypt: false })
    }).catch(() => undefined)
    await Promise.all([aliceContext.close(), bobContext.close()])
  }
})

test('two isolated browser clients converge through recipient-bound encrypted toy Signal routing', async ({
  browser
}) => {
  const aliceContext = await browser.newContext()
  const bobContext = await browser.newContext()
  const alicePage = await aliceContext.newPage()
  const bobPage = await bobContext.newPage()

  try {
    await register(alicePage, 'Alice encrypted')
    await register(bobPage, 'Bob encrypted')
    const alice = await storedIdentity(alicePage)
    const bob = await storedIdentity(bobPage)
    expect(alice.userId).not.toBe(bob.userId)
    expect(alice.phoneNumber).not.toBe(bob.phoneNumber)

    const documentId = await createLocallyRootedDocument(alicePage, alice)
    const groupId = await createEncryptedGroup(alice, documentId)
    await openEncryptedGroup(alicePage, groupId, documentId)
    await inviteEncryptedParticipant(alicePage, bob)
    await openEncryptedGroup(bobPage, groupId, documentId)

    const [aliceBootstrap, bobBootstrap] = await Promise.all([
      collaborationAuthorizationState(alicePage, alice.userId, documentId),
      collaborationAuthorizationState(bobPage, bob.userId, documentId)
    ])
    expect(aliceBootstrap).toMatchObject({
      revision: 1,
      selfRole: 'admin',
      archived: false,
      authorizationStatus: 'active',
      anchorKind: 'verified-root'
    })
    expect(bobBootstrap).toMatchObject({
      revision: 1,
      selfRole: 'writer',
      archived: false,
      authorizationRoot: aliceBootstrap.authorizationRoot,
      authorizationHead: aliceBootstrap.authorizationHead,
      authorizationStatus: 'active',
      anchorKind: 'verified-root'
    })

    await alicePage.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(bobPage.locator('textarea')).toBeDisabled()
    await alicePage.getByRole('button', { name: 'Unarchive', exact: true }).click()
    await expect(bobPage.locator('textarea')).toBeEnabled()
    await expect
      .poll(async () => {
        const [aliceState, bobState] = await Promise.all([
          collaborationAuthorizationState(alicePage, alice.userId, documentId),
          collaborationAuthorizationState(bobPage, bob.userId, documentId)
        ])
        return {
          aliceRevision: aliceState.revision,
          bobRevision: bobState.revision,
          sameRoot: aliceState.authorizationRoot === bobState.authorizationRoot,
          sameHead: aliceState.authorizationHead === bobState.authorizationHead,
          archived: aliceState.archived || bobState.archived
        }
      })
      .toEqual({
        aliceRevision: 3,
        bobRevision: 3,
        sameRoot: true,
        sameHead: true,
        archived: false
      })

    const faultsResponse = await fetch(`${toyBaseUrl}/__toy__/v1/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ duplicateNextDeliveries: 1, deliveryDelayMs: 25 })
    })
    expect(faultsResponse.status).toBe(200)

    const aliceText = `alice-encrypted-${groupId}`
    await alicePage.locator('textarea').fill(aliceText)
    await expect(bobPage.locator('textarea')).toHaveValue(aliceText)

    const clearFaultsResponse = await fetch(`${toyBaseUrl}/__toy__/v1/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(clearFaultsResponse.status).toBe(200)

    const bobText = `${aliceText}\nbob-encrypted-${documentId}`
    await bobPage.locator('textarea').fill(bobText)
    await expect(alicePage.locator('textarea')).toHaveValue(bobText)
    await expect(alicePage.locator('textarea')).toHaveCount(1)
    await expect(bobPage.locator('textarea')).toHaveCount(1)

    const stateResponse = await fetch(`${toyBaseUrl}/__toy__/v1/state`)
    expect(stateResponse.status).toBe(200)
    const stateText = await stateResponse.text()
    expect(stateText).not.toContain(aliceText)
    expect(stateText).not.toContain(`bob-encrypted-${documentId}`)
    const state = JSON.parse(stateText) as {
      identity: { identities: Array<{ user_id: string; phone_number: string }> }
      collaboration: {
        messages: Array<{
          group_id: string
          sender_user_id: string
          recipients: Array<{
            phone_number: string
            ciphertext_bytes: number
            delivery_copies: number
          }>
        }>
      }
    }
    const groupMessages = state.collaboration.messages.filter(
      (message) => message.group_id === groupId
    )
    expect(groupMessages.length).toBeGreaterThanOrEqual(4)
    const editMessages = groupMessages.slice(-2)
    expect(editMessages[0]).toMatchObject({
      sender_user_id: alice.userId,
      recipients: [
        {
          phone_number: bob.phoneNumber,
          delivery_copies: 2
        }
      ]
    })
    expect(editMessages[0]!.recipients[0]!.ciphertext_bytes).toBeGreaterThan(16)
    expect(editMessages[1]).toMatchObject({
      sender_user_id: bob.userId,
      recipients: [
        {
          phone_number: alice.phoneNumber,
          delivery_copies: 1
        }
      ]
    })
    expect(editMessages[1]!.recipients[0]!.ciphertext_bytes).toBeGreaterThan(16)

    const bobPhoneBeforeReload = await bobPage.getByTestId('identity-phone').textContent()
    await bobPage.reload()
    await expect(bobPage.getByRole('heading', { name: 'Your encrypted workspace.' })).toBeVisible()
    await expect(bobPage.getByRole('status')).toContainText(/ready\s*·\s*online/i)
    await expect(bobPage.getByTestId('identity-phone')).toHaveText(bobPhoneBeforeReload ?? '')
    await expect(bobPage.locator('textarea')).toHaveValue(bobText)
    await expect(bobPage.locator('textarea')).toHaveCount(1)
    const bobAfterReload = await storedIdentity(bobPage)
    expect(bobAfterReload.userId).toBe(bob.userId)
    expect(bobAfterReload.sessionToken).toBe(bob.sessionToken)

    const afterReloadState = (await (
      await fetch(`${toyBaseUrl}/__toy__/v1/state`)
    ).json()) as typeof state
    expect(
      afterReloadState.identity.identities.filter((entry) => entry.user_id === bob.userId)
    ).toHaveLength(1)
  } finally {
    await Promise.all([aliceContext.close(), bobContext.close()])
    await fetch(`${toyBaseUrl}/__toy__/v1/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    }).catch(() => undefined)
  }
})

test('reopens the same persistent browser profile with document, queue replay, and durable dedup intact', async ({
  browser,
  browserName,
  baseURL
}, testInfo) => {
  if (!baseURL) throw new Error('Playwright baseURL is required for persistent restart coverage')
  const profileDir = testInfo.outputPath('persistent-profile')
  const aliceContext = await browser.newContext()
  const alicePage = await aliceContext.newPage()
  const browserType = persistentBrowserType(browserName)
  let bobContext = await browserType.launchPersistentContext(profileDir, { baseURL })

  try {
    const bobPage = bobContext.pages()[0] ?? (await bobContext.newPage())
    await register(alicePage, `Persistent Alice ${browserName}`)
    await register(bobPage, `Persistent Bob ${browserName}`)
    const alice = await storedIdentity(alicePage)
    const bob = await storedIdentity(bobPage)
    const documentId = await createLocallyRootedDocument(alicePage, alice)
    const groupId = await createEncryptedGroup(alice, documentId)
    await openEncryptedGroup(alicePage, groupId, documentId)
    await inviteEncryptedParticipant(alicePage, bob)
    await openEncryptedGroup(bobPage, groupId, documentId)

    const inboundText = `durable-seen-${documentId}`
    await alicePage.locator('textarea').fill(inboundText)
    await expect(bobPage.locator('textarea')).toHaveValue(inboundText)

    await bobPage.getByLabel('Sync mode').selectOption('manual')
    const pendingText = `${inboundText}\npending-across-profile-restart`
    await bobPage.locator('textarea').fill(pendingText)
    await expect(bobPage.getByTestId('pending-outbound')).toHaveText('1 pending')
    await expect(bobPage.getByTestId('sync-state')).toContainText('1 queued locally')

    const beforeRestart = await collaborationStorageState(bobPage, bob.userId, documentId)
    expect(beforeRestart.documentCount).toBe(1)
    expect(beforeRestart.outbound).toEqual([
      expect.objectContaining({ kind: 'automerge-change', state: 'pending' })
    ])
    expect(beforeRestart.seen.length).toBeGreaterThanOrEqual(1)
    const queuedId = beforeRestart.outbound[0]!.id
    const seenMessageIds = beforeRestart.seen.map((entry) => entry.messageId).sort()

    await bobContext.close()
    bobContext = await browserType.launchPersistentContext(profileDir, { baseURL })
    const reopenedBobPage = await reopenPersistentPage(
      bobContext,
      `/?group=${encodeURIComponent(groupId)}&document=${encodeURIComponent(documentId)}`
    )
    await openEncryptedGroup(reopenedBobPage, groupId, documentId)

    const restoredBob = await storedIdentity(reopenedBobPage)
    expect(restoredBob.userId).toBe(bob.userId)
    expect(restoredBob.sessionToken).toBe(bob.sessionToken)
    await expect(reopenedBobPage.locator('textarea')).toHaveValue(pendingText)
    await expect(alicePage.locator('textarea')).toHaveValue(pendingText)
    await expect(reopenedBobPage.getByTestId('sync-state')).toContainText('Replay complete 1/1')
    await expect(reopenedBobPage.getByTestId('sync-state')).toContainText(
      'remote merge is not implied'
    )

    await expect
      .poll(async () => {
        const state = await collaborationStorageState(reopenedBobPage, bob.userId, documentId)
        return {
          documentCount: state.documentCount,
          outbound: state.outbound,
          priorSeenRetained: seenMessageIds.every((messageId) =>
            state.seen.some((entry) => entry.messageId === messageId)
          )
        }
      })
      .toMatchObject({
        documentCount: 1,
        outbound: [expect.objectContaining({ id: queuedId, state: 'attempted', attempts: 1 })],
        priorSeenRetained: true
      })
    await expect(reopenedBobPage.getByLabel('Sync mode')).toHaveValue('manual')
  } finally {
    await Promise.all([aliceContext.close(), bobContext.close()])
  }
})
