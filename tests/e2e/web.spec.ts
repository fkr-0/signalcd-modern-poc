import { expect, type Page, test } from '@playwright/test'

async function register(page: Page, name: string) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Create your local identity.' })).toBeVisible()
  await page.getByLabel('Display name').fill(name)
  await page.getByRole('button', { name: 'Create identity' }).click()
  await expect(page.getByRole('heading', { name: 'Your encrypted workspace.' })).toBeVisible()
  await expect(page.locator('textarea')).toHaveCount(1)
  await expect(page.getByRole('status')).toContainText('Ready')
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
