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
  dataDir = mkdtempSync(join(ROOT, '.tmp-chaoxing-ui-'))
  mkdirSync(join(ROOT, 'test-results'), { recursive: true })
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

test('课程空间与合并在首页的课表/月视图/时间轴可用', async () => {
  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await expect(page.locator('.studio-course-shell')).toBeVisible()
  await expect(page.locator('.course-rail-item')).toHaveCount(5)
  await page.locator('.course-rail-item').first().click()
  await expect(page.locator('.course-hero-title')).toBeVisible()

  await page.locator('.studio-pill-item', { hasText: '今天' }).click()
  await expect(page.locator('.studio-full-week-table')).toBeVisible()
  await page.getByRole('button', { name: '月视图', exact: true }).click()
  await expect(page.locator('.calendar-month-grid')).toBeVisible()
  await page.getByRole('button', { name: '时间轴', exact: true }).click()
  await expect(page.locator('.week-grid')).toBeVisible()
  await page.screenshot({ path: join(ROOT, 'test-results', 'chaoxing-calendar.png') })
})

test('任务筛选计数、逾期统计与新建逾期任务保持一致', async () => {
  await page.locator('.studio-pill-item', { hasText: '作业' }).click()
  await expect(page.getByRole('heading', { name: '作业', exact: true })).toBeVisible()

  const allTab = page
    .getByRole('group', { name: '按状态筛选' })
    .getByRole('button', { name: /^全部/ })
  const readAllCount = async (): Promise<number> => {
    const text = await allTab.locator('.b2-tab-count').innerText()
    return Number(text.trim())
  }
  const readOverdueCount = async (): Promise<number> => {
    const badge = page.locator('.studio-overdue-hint')
    if ((await badge.count()) === 0) return 0
    const text = await badge.innerText()
    return Number(text.match(/已逾期\s*(\d+)/)?.[1] ?? '0')
  }

  const beforeTotal = await readAllCount()
  const beforeOverdue = await readOverdueCount()
  expect(beforeTotal).toBeGreaterThan(0)

  await page.getByRole('button', { name: '新建任务' }).click()
  await page.getByPlaceholder('例如：完成第 3 章在线作业').fill('E2E 逾期任务')
  await page.locator('input[type="datetime-local"]').fill('2020-01-01T10:00')
  await page.getByRole('button', { name: '创建任务' }).click()
  await expect(page.getByText('任务已创建')).toBeVisible()

  await expect.poll(readAllCount).toBe(beforeTotal + 1)
  await expect.poll(readOverdueCount).toBe(beforeOverdue + 1)
  await expect(page.locator('.task-row').filter({ hasText: 'E2E 逾期任务' })).toHaveCount(1)
})

test('设置页密码显示切换可用', async () => {
  await page.locator('button[aria-label="设置"]').click()
  await expect(page.locator('.page-title')).toHaveText('偏好与数据')
  await page.locator('.settings-nav').getByRole('button', { name: '学习通与同步' }).click()
  const panel = page.locator('.chaoxing-credentials')
  await expect(panel).toBeVisible()
  const password = panel.locator('input[placeholder*="密码"]')
  if ((await password.count()) === 0) {
    test.skip(true, '当前环境已保存凭据，密码输入框不在表单态')
  }
  await password.fill('e2e-secret')
  await expect(password).toHaveAttribute('type', 'password')
  await panel.locator('.password-toggle').click()
  await expect(password).toHaveAttribute('type', 'text')
  await panel.locator('.password-toggle').click()
  await expect(password).toHaveAttribute('type', 'password')
})
