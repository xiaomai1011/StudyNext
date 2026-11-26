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
let app: ElectronApplication
let page: Page
let dataDir: string

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(ROOT, '.tmp-navigation-'))
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
  env.STUDYNEXT_DATA_DIR = dataDir
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${dataDir}`],
    cwd: ROOT,
    env
  })
  page = await app.firstWindow()
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('顶栏胶囊导航、精简入口与全局搜索可用', async () => {
  await expect(page.locator('.studio-pill-item')).toHaveCount(3)
  await expect(page.locator('.sidebar')).toHaveCount(0)
  await expect(page.locator('.sidebar-search-trigger')).toBeVisible()
  await expect(page.locator('.studio-pill-nav')).not.toContainText('题目助手')
  await expect(page.locator('.studio-pill-nav')).not.toContainText('课表')

  await page.keyboard.press('Control+K')
  await expect(page.locator('.command-palette')).toBeVisible()
  await page.locator('.command-input-row input').fill('设置')
  await expect(page.locator('.command-item').first()).toBeVisible()
  await page.locator('.command-item').first().click()

  await expect(page.locator('.page-title')).toHaveText('偏好与数据')
})
