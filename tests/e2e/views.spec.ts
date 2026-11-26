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

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let dataDir: string

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(ROOT, '.tmp-views-'))
  mkdirSync(dataDir, { recursive: true })
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
  await page.waitForSelector('.studio-shell')
})

test.afterAll(async () => {
  if (app) await app.close()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('所有主要视图在浅色与深色主题下完整渲染并支持自由缩放', async () => {
  await page.waitForTimeout(400)
  await expect(page.locator('.studio-pill-item')).toHaveCount(3)
  await expect(page.locator('.studio-full-week-table')).toBeVisible()
  await page.screenshot({ path: 'test-results/studio-today-light.png' })

  await page.getByRole('button', { name: '月视图', exact: true }).click()
  const firstTask = page.locator('.calendar-event').first()
  await expect(firstTask).toBeVisible()
  await firstTask.click()
  await expect(page.locator('.modal')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.modal')).toHaveCount(0)
  await page.getByRole('button', { name: '周课表', exact: true }).click()
  await expect(page.locator('.studio-full-week-table')).toBeVisible()

  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await expect(page.locator('.studio-course-shell')).toBeVisible()
  await page.waitForTimeout(350)
  await page.screenshot({ path: 'test-results/studio-courses-light.png' })

  await page.locator('.studio-pill-item', { hasText: '作业' }).click()
  await expect(page.locator('.page-title')).toHaveText('作业')
  await page.waitForTimeout(350)
  await page.screenshot({ path: 'test-results/studio-tasks-light.png' })

  await page.getByRole('tab', { name: /考试安排/ }).click()
  await expect(page.locator('.studio-exams-embedded')).toBeVisible()
  await page.waitForTimeout(250)
  await page.screenshot({ path: 'test-results/studio-exams-light.png' })
  await page.getByRole('tab', { name: '作业清单', exact: true }).click()

  await page.locator('button[aria-label="设置"]').click()
  await expect(page.locator('.page-title')).toHaveText('偏好与数据')
  await page.waitForTimeout(350)
  await page.screenshot({ path: 'test-results/studio-settings-light.png' })

  await page.locator('.theme-option.dark').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.waitForTimeout(350)
  await page.screenshot({ path: 'test-results/studio-settings-dark.png' })

  await page.locator('.studio-pill-item', { hasText: '作业' }).click()
  await expect(page.locator('.page-title')).toHaveText('作业')
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/studio-tasks-dark.png' })

  await page.getByRole('tab', { name: /考试安排/ }).click()
  await expect(page.locator('.studio-exams-embedded')).toBeVisible()
  await page.waitForTimeout(250)
  await page.screenshot({ path: 'test-results/studio-exams-dark.png' })
  await page.getByRole('tab', { name: '作业清单', exact: true }).click()

  await page.locator('.studio-pill-item', { hasText: '今天' }).click()
  await expect(page.locator('.studio-today')).toBeVisible()
  await expect(page.locator('.studio-full-week-table')).toBeVisible()
  await page.waitForTimeout(350)
  await page.screenshot({ path: 'test-results/studio-today-dark.png' })

  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await expect(page.locator('.studio-course-shell')).toBeVisible()
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/studio-courses-dark.png' })

  await page.locator('.titlebar-zoom-trigger').click()
  await expect(page.locator('.titlebar-zoom-popover')).toBeVisible()
  await page.locator('.titlebar-zoom-popover .zoom-preset-btn', { hasText: '90%' }).click()
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        Number((BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor() ?? 0).toFixed(2))
      )
    )
    .toBe(0.9)
  await page.keyboard.press('Control+0')
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        Number((BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor() ?? 0).toFixed(2))
      )
    )
    .toBe(1)
})
