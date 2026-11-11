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
  await page.waitForSelector('.app-shell')
})

test.afterAll(async () => {
  if (app) await app.close()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

async function open(label: string, title: string): Promise<void> {
  await page.locator('.nav-item', { hasText: label }).click()
  await expect(page.locator('.page-title')).toHaveText(title)
  await page.waitForTimeout(450)
}

test('所有主要视图在浅色与深色主题下完整渲染', async () => {
  await page.waitForTimeout(450)
  await page.screenshot({ path: 'test-results/view-dashboard-light.png' })

  await open('学习中心', '学习中心')
  await page.screenshot({ path: 'test-results/view-study-light.png' })

  await open('课程中心', '我的课程')
  await page.screenshot({ path: 'test-results/view-courses-light.png' })

  await open('任务中心', '任务与 DDL')
  await page.screenshot({ path: 'test-results/view-tasks-light.png' })

  await open('题目助手', '题目助手')
  await page.screenshot({ path: 'test-results/view-questions-light.png' })

  await open('日历', '日历与安排')
  await page.screenshot({ path: 'test-results/view-calendar-light.png' })
  await page.getByRole('button', { name: '周视图', exact: true }).click()
  await expect(page.locator('.week-grid')).toBeVisible()
  await page.getByRole('button', { name: '月视图', exact: true }).click()
  const firstTask = page.locator('.calendar-event').first()
  await expect(firstTask).toBeVisible()
  await firstTask.click()
  await expect(page.locator('.modal')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.modal')).toHaveCount(0)

  await open('官方页面', '官方页面')
  await page.screenshot({ path: 'test-results/view-portal-light.png' })

  await open('设置', '偏好与数据')
  await page.screenshot({ path: 'test-results/view-settings-light.png' })

  await page.locator('.theme-option.dark').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.waitForTimeout(350)
  await page.screenshot({ path: 'test-results/view-settings-dark.png' })

  await page.locator('.nav-item', { hasText: '总览' }).click()
  await expect(page.locator('.page-title')).toContainText('学习总览')
  await page.waitForTimeout(450)
  await page.screenshot({ path: 'test-results/view-dashboard-dark.png' })
})
