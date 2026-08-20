import { expect, type Page, test } from '@playwright/test'

const toyBaseUrl = 'http://127.0.0.1:18080'

async function register(page: Page, name: string) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Create your local identity.' })).toBeVisible()
  await page.getByLabel('Display name').fill(name)
  await page.getByRole('button', { name: 'Create identity' }).click()
  await expect(page.getByRole('heading', { name: 'Your encrypted workspace.' })).toBeVisible()
  await expect(page.locator('textarea')).toHaveCount(1)
  await expect(page.getByRole('status')).toContainText('Ready')
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
    const identities = await readAll<{ userId: string; phoneNumber: string }>('identities')
    const sessions = await readAll<{ userId: string; sessionToken: string }>('sessions')
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
  bob: StoredIdentityClaim,
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
  const memberResponse = await fetch(`${toyBaseUrl}/api/v1/groups/${created.group_id}/members`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${alice.sessionToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ phone_number: bob.phoneNumber, role: 'writer' })
  })
  expect(memberResponse.status).toBe(200)
  return created.group_id
}

async function openEncryptedGroup(page: Page, groupId: string, documentId: string): Promise<void> {
  await page.goto(
    `/?group=${encodeURIComponent(groupId)}&document=${encodeURIComponent(documentId)}`
  )
  await expect(page.getByRole('heading', { name: 'Your encrypted workspace.' })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('Ready')
  await expect(page.locator('textarea')).toHaveCount(1)
  await expect(page.getByText('Encrypted mock Signal group')).toBeVisible()
}

test('registers one browser-owned identity and exposes one editor session', async ({ page }) => {
  await register(page, 'Ada')

  await expect(page.getByLabel('Current identity')).toContainText('Ada')
  await expect(page.getByTestId('identity-phone')).toHaveText(/^\+1555000\d{4}$/)
  await expect(page.getByText('Browser-owned keys')).toBeVisible()
  await expect(page.getByText('Local-first persistence')).toBeVisible()
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

    const documentId = crypto.randomUUID()
    const groupId = await createEncryptedGroup(alice, bob, documentId)
    await Promise.all([
      openEncryptedGroup(alicePage, groupId, documentId),
      openEncryptedGroup(bobPage, groupId, documentId)
    ])

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
    expect(groupMessages).toHaveLength(2)
    expect(groupMessages[0]).toMatchObject({
      sender_user_id: alice.userId,
      recipients: [
        {
          phone_number: bob.phoneNumber,
          delivery_copies: 2
        }
      ]
    })
    expect(groupMessages[0]!.recipients[0]!.ciphertext_bytes).toBeGreaterThan(16)
    expect(groupMessages[1]).toMatchObject({
      sender_user_id: bob.userId,
      recipients: [
        {
          phone_number: alice.phoneNumber,
          delivery_copies: 1
        }
      ]
    })
    expect(groupMessages[1]!.recipients[0]!.ciphertext_bytes).toBeGreaterThan(16)

    const bobPhoneBeforeReload = await bobPage.getByTestId('identity-phone').textContent()
    await bobPage.reload()
    await expect(bobPage.getByRole('heading', { name: 'Your encrypted workspace.' })).toBeVisible()
    await expect(bobPage.getByRole('status')).toContainText('Ready')
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
