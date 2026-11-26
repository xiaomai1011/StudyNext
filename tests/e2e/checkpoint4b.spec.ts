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
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-4b-'))
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

async function openTasks(): Promise<void> {
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: /作业/ })
    .click()
  await expect(page.getByRole('heading', { name: '作业', exact: true })).toBeVisible()
}

test.beforeAll(async () => {
  await launch()
})

test.afterEach(async () => {
  const close = page.locator('.modal-close')
  if ((await close.count()) > 0) {
    await close
      .first()
      .click()
      .catch(() => undefined)
  }
  await page.keyboard.press('Escape').catch(() => undefined)
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('本地任务可以通过 checkbox 标记完成', async () => {
  await openTasks()
  await page.getByRole('button', { name: '新建任务' }).click()
  const modal = page.locator('.modal')
  await expect(modal).toBeVisible()
  await modal.locator('input.input').first().fill('4B 本地任务')
  await modal.getByRole('button', { name: '创建任务' }).click()
  await expect(modal).toHaveCount(0)

  const row = page.locator('.task-row').filter({ hasText: '4B 本地任务' }).first()
  await expect(row).toBeVisible()
  await row.locator('.task-check').click()
  await expect(row.locator('.task-check')).toHaveClass(/checked/)
})

test('未保存的新任务取消时要求确认', async () => {
  await openTasks()
  await page.getByRole('button', { name: '新建任务' }).click()
  const modal = page.locator('.modal')
  await expect(modal).toBeVisible()
  await modal.locator('input.input').first().fill('4B 未保存任务')
  await modal.getByRole('button', { name: '取消' }).click()
  await expect(page.getByText('放弃未保存的修改？')).toBeVisible()
  await page.getByRole('button', { name: '放弃修改' }).click()
  await expect(page.locator('.modal')).toHaveCount(0)
})

test('任务中心提供已提交和已批阅筛选', async () => {
  await openTasks()
  await page.getByRole('button', { name: /^已提交/ }).click()
  await expect(page.getByRole('button', { name: /^已提交/ })).toHaveClass(/active/)
  await page.getByRole('button', { name: /^已批阅/ }).click()
  await expect(page.getByRole('button', { name: /^已批阅/ })).toHaveClass(/active/)
})

test('作业记录提供课程筛选', async () => {
  await openTasks()
  await page.getByRole('tab', { name: '成绩与批语' }).click()
  await expect(page.locator('select[aria-label="按课程筛选作业记录"]')).toBeVisible()
})
