import { expect, test } from '@playwright/test'

test('renders two collaborative replicas', async ({ page }) => {
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: 'Encrypted transport, CRDT editor.' })
  ).toBeVisible()
  await expect(page.getByRole('textbox')).toHaveCount(2)
})

test('synchronizes edits between independent browser replicas', async ({ page }) => {
  await page.goto('/')
  const editors = page.getByRole('textbox')
  const left = editors.nth(0)
  const right = editors.nth(1)

  await expect(page.getByText('connected', { exact: true })).toHaveCount(2)
  await left.fill('private collaboration')
  await expect(right).toHaveValue('private collaboration')

  await right.fill('private collaborative state')
  await expect(left).toHaveValue('private collaborative state')
})

test('isolates separate browser contexts before a shared sidecar is connected', async ({
  browser
}) => {
  const firstContext = await browser.newContext()
  const secondContext = await browser.newContext()
  const firstPage = await firstContext.newPage()
  const secondPage = await secondContext.newPage()

  try {
    await Promise.all([firstPage.goto('/'), secondPage.goto('/')])
    await firstPage.getByRole('textbox').first().fill('local session one')

    await expect(firstPage.getByRole('textbox').nth(1)).toHaveValue('local session one')
    await expect(secondPage.getByRole('textbox').first()).toHaveValue('')
  } finally {
    await Promise.all([firstContext.close(), secondContext.close()])
  }
})
