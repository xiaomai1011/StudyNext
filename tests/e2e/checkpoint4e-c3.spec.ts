import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'

const ROOT = process.cwd()
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-4e-c3-'))
let app: ElectronApplication
let page: Page

async function launch(): Promise<void> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
  env.STUDYNEXT_DATA_DIR = DATA_DIR
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${DATA_DIR}`],
    cwd: ROOT,
    env
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })
}

async function noHorizontalOverflow(): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  await launch()
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(DATA_DIR, { recursive: true, force: true })
})

test('C3 shell uses one active navigation item and keeps keyboard focus visible', async () => {
  await expect(page.locator('.app-shell.c3-shell')).toHaveCount(1)
  await expect(page.locator('.nav-item[aria-current="page"]')).toHaveCount(1)

  const firstNav = page.locator('.nav-item').first()
  await firstNav.focus()
  await expect(firstNav).toBeFocused()
  const shadow = await firstNav.evaluate((element) => getComputedStyle(element).boxShadow)
  expect(shadow).not.toBe('none')

  await firstNav.press('Enter')
  await expect(page.locator('.nav-item[aria-current="page"]')).toHaveCount(1)
})

test('Today and Settings stay usable at 1024 and 900 without page overflow', async () => {
  for (const width of [1024, 900]) {
    await page.setViewportSize({ width, height: 900 })
    await page.locator('.studio-pill-item', { hasText: '今天' }).click()
    await expect(page.locator('.studio-today')).toBeVisible()
    expect(await noHorizontalOverflow()).toBe(true)

    await page.locator('button[aria-label="设置"]').click()
    await expect(page.getByRole('heading', { name: '偏好与数据' })).toBeVisible()
    expect(await noHorizontalOverflow()).toBe(true)
    await expect(page.locator('.ds-settings-page .settings-content')).toBeVisible()
    await expect(page.locator('.settings-nav-item')).toHaveCount(6)
  }
  await page.setViewportSize({ width: 1280, height: 900 })
})

test('Settings scroll-spy still marks exactly one section after C3 chrome changes', async () => {
  await page.locator('button[aria-label="设置"]').click()
  await expect(page.getByRole('heading', { name: '偏好与数据' })).toBeVisible()
  await page.getByRole('button', { name: '数据与关于' }).click()
  await expect(page.getByRole('button', { name: '数据与关于' })).toHaveAttribute(
    'aria-current',
    'location'
  )
  await expect(page.getByRole('button', { name: '数据与关于' })).toBeInViewport()
})

test('C3 modal enter animation preserves C2 focus trap and Escape restoration', async () => {
  await page.locator('.studio-pill-item', { hasText: '作业' }).click()
  const trigger = page.getByRole('button', { name: '新建任务' }).first()
  await trigger.click()

  const modal = page.locator('.c3-modal')
  await expect(modal).toBeVisible()
  await expect(page.locator('.c3-modal-backdrop')).toBeVisible()
  expect(await modal.evaluate((element) => getComputedStyle(element).animationName)).toBe(
    'c3-dialog-in'
  )
  expect(await page.evaluate(() => document.querySelector('#root')?.hasAttribute('inert'))).toBe(
    true
  )
  await expect(page.locator('.modal-body input').first()).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
  await expect(trigger).toBeFocused()
  expect(await page.evaluate(() => document.querySelector('#root')?.hasAttribute('inert'))).toBe(
    false
  )
})

test('C3 modal entry motion is disabled for prefers-reduced-motion', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.locator('.studio-pill-item', { hasText: '作业' }).click()
  await page.getByRole('button', { name: '新建任务' }).first().click()
  const modal = page.locator('.c3-modal')
  await expect(modal).toBeVisible()
  expect(await modal.evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
  await page.keyboard.press('Escape')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
})
