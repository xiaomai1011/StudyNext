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
    await page.waitForSelector('.app-shell')
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1080, 700)
    })
    await page.waitForTimeout(450)

    for (const [label, title] of [
      ['总览', '学习总览'],
      ['学习中心', '学习中心'],
      ['任务中心', '任务与 DDL'],
      ['课程中心', '我的课程'],
      ['题目助手', '题目助手'],
      ['日历', '日历与安排'],
      ['官方页面', '官方页面'],
      ['设置', '偏好与数据']
    ] as const) {
      await page.locator('.nav-item', { hasText: label }).click()
      await expect(page.locator('.page-title')).toHaveText(title)
      await page.waitForTimeout(350)
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth
      }))
      expect(overflow.scrollWidth, `页面 ${label} 不应横向溢出`).toBeLessThanOrEqual(
        overflow.innerWidth + 1
      )
    }
    await page.screenshot({ path: 'test-results/view-small-window.png' })
  } finally {
    await app?.close().catch(() => undefined)
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
