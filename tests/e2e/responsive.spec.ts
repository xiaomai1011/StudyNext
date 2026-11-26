import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'

const ROOT = process.cwd()

test('最小窗口尺寸下主要页面无横向溢出', async () => {
  const dataDir = mkdtempSync(join(ROOT, '.tmp-small-'))
  mkdirSync(dataDir, { recursive: true })
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
  env.STUDYNEXT_DATA_DIR = dataDir
  delete env.ELECTRON_RUN_AS_NODE

  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${dataDir}`],
      cwd: ROOT,
      env
    })
    const page: Page = await app.firstWindow()
    await page.waitForSelector('.studio-shell')
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1080, 700)
    })
    await page.waitForTimeout(400)

    const checks: Array<{ name: string; open: () => Promise<void> }> = [
      { name: '今天', open: () => page.locator('.studio-pill-item', { hasText: '今天' }).click() },
      { name: '课程', open: () => page.locator('.studio-pill-item', { hasText: '课程' }).click() },
      { name: '作业', open: () => page.locator('.studio-pill-item', { hasText: '作业' }).click() },
      { name: '通知', open: () => page.locator('button[aria-label="通知收件箱"]').click() },
      { name: '设置', open: () => page.locator('button[aria-label="设置"]').click() }
    ]

    for (const item of checks) {
      await item.open()
      await page.waitForTimeout(300)
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth
      }))
      expect(overflow.scrollWidth, `页面 ${item.name} 不应横向溢出`).toBeLessThanOrEqual(
        overflow.innerWidth + 1
      )
    }
    await page.screenshot({ path: 'test-results/view-small-window.png' })
  } finally {
    await app?.close().catch(() => undefined)
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
