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

async function open(label: string, title: string): Promise<void> {
  await page.locator('.nav-item', { hasText: label }).click()
  await expect(page.locator('.page-title')).toHaveText(title)
  await page.waitForTimeout(300)
}

test('课程卡片、详情与课表视图可用', async () => {
  await open('课程中心', '我的课程')
  await expect(page.locator('.course-card')).toHaveCount(5)
  await page.locator('.course-card').first().click()
  await expect(page.locator('.modal .detail-title')).toBeVisible()
  await expect(page.locator('.modal .detail-item').filter({ hasText: '学期' })).toBeVisible()
  await page.locator('.modal-close').click()

  await open('日历', '日历与安排')
  await expect(page.locator('.calendar-month-grid')).toBeVisible()
  await page.getByRole('button', { name: '周视图', exact: true }).click()
  await expect(page.locator('.week-grid')).toBeVisible()
  await page.screenshot({ path: join(ROOT, 'test-results', 'chaoxing-calendar.png') })
})

test('任务计数区分同步总数、显示数与隐藏逾期数', async () => {
  await open('任务中心', '任务与 DDL')
  const subtitle = page.locator('.page-subtitle').filter({ hasText: '隐藏逾期' })
  const readCounts = async (): Promise<{ total: number; visible: number; hidden: number }> => {
    const text = await subtitle.innerText()
    const match = text.match(/同步 (\d+) 项 · 实际显示 (\d+) 项 · 隐藏逾期 (\d+) 项/)
    if (!match) throw new Error(`无法解析任务计数：${text}`)
    return { total: Number(match[1]), visible: Number(match[2]), hidden: Number(match[3]) }
  }
  const before = await readCounts()
  expect(before.total).toBe(before.visible + before.hidden)
  expect(before.visible).toBeGreaterThan(0)

  await page.getByRole('button', { name: '新建任务' }).click()
  await page.getByPlaceholder('例如：完成第 3 章在线作业').fill('E2E 逾期任务')
  await page.locator('input[type="datetime-local"]').fill('2020-01-01T10:00')
  await page.getByRole('button', { name: '创建任务' }).click()
  await expect(page.getByText('任务已创建')).toBeVisible()

  await expect
    .poll(async () => (await readCounts()).total)
    .toBe(before.total + 1)
  const after = await readCounts()
  expect(after.hidden).toBe(before.hidden + 1)
  expect(after.visible).toBe(before.visible)
  await expect(page.locator('.task-row').filter({ hasText: 'E2E 逾期任务' })).toHaveCount(0)
})

test('设置页密码显示切换可用', async () => {
  await open('设置', '偏好与数据')
  await page.locator('.settings-nav').getByRole('button', { name: '学习通' }).click()
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
