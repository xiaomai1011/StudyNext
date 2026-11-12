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
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-'))
const TASK_TITLE = 'E2E 持久化任务'
const EDITED_TITLE = 'E2E 持久化任务（已编辑）'
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
    .getByRole('button', { name: /任务中心/ })
    .click()
  await expect(page.getByRole('heading', { name: '任务与 DDL' })).toBeVisible()
}

test.beforeAll(async () => {
  mkdirSync(join(ROOT, 'test-results'), { recursive: true })
  await launch()
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('无账号启动、仪表盘、任务 CRUD、重启持久化与渲染进程隔离', async () => {
  await expect(page.locator('.titlebar-brand')).toContainText('StudyNext')
  await expect(page.getByRole('heading', { name: '学习总览' })).toBeVisible()
  await expect(page.getByText('本地模式 · 未连接学习通')).toBeVisible()
  const courseMetric = page.locator('.metric-card').filter({ hasText: '本学期课程' })
  await expect(courseMetric.locator('.metric-value')).toContainText('5')
  await expect(page.locator('.notice-item').first()).toBeVisible()
  await page.screenshot({ path: join(ROOT, 'test-results', 'dashboard.png') })

  const exposedKeys = await page.evaluate(() =>
    Object.keys((window as unknown as { studynext: Record<string, unknown> }).studynext).sort()
  )
  expect(exposedKeys).toContain('bootstrap')
  expect(
    await page.evaluate(() => typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer)
  ).toBe('undefined')
  expect(
    await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)
  ).toBe('undefined')

  await openTasks()
  const initialTaskCount = await page.locator('.task-row').count()
  expect(initialTaskCount).toBeGreaterThan(0)

  await page.getByRole('button', { name: '新建任务' }).click()
  await page.getByPlaceholder('例如：完成第 3 章在线作业').fill(TASK_TITLE)
  await page.locator('input[type="datetime-local"]').fill('2030-06-01T22:00')
  await page.getByRole('button', { name: '创建任务' }).click()
  await expect(page.getByText('任务已创建')).toBeVisible()
  const createdRow = page.locator('.task-row').filter({ hasText: TASK_TITLE })
  await expect(createdRow).toBeVisible()

  await createdRow.getByRole('button', { name: '编辑任务' }).click()
  await page.getByPlaceholder('例如：完成第 3 章在线作业').fill(EDITED_TITLE)
  await page.getByRole('button', { name: '保存修改' }).click()
  await expect(page.getByText('任务修改已保存，提醒已重新调度')).toBeVisible()
  await expect(page.locator('.task-row').filter({ hasText: EDITED_TITLE })).toBeVisible()

  await page.screenshot({ path: join(ROOT, 'test-results', 'tasks.png') })

  await app.close()
  await launch()
  await openTasks()
  await expect(page.locator('.task-row')).toHaveCount(initialTaskCount + 1)
  const persistedRow = page.locator('.task-row').filter({ hasText: EDITED_TITLE })
  await expect(persistedRow).toBeVisible()

  await persistedRow.getByRole('button', { name: '标记为完成' }).click()
  await expect(page.getByText('任务已标记为完成')).toBeVisible()
  await persistedRow.getByRole('button', { name: '删除任务' }).click()
  await page.locator('.modal').getByRole('button', { name: '删除任务', exact: true }).click()
  await expect(page.getByText('任务已删除')).toBeVisible()
  await expect(page.locator('.task-row')).toHaveCount(initialTaskCount)

  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '设置' })
    .click()
  await expect(page.getByRole('heading', { name: '偏好与数据' })).toBeVisible()
  await page.screenshot({ path: join(ROOT, 'test-results', 'settings.png') })
})
