import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'

const ROOT = process.cwd()
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-4e-b4-'))
const DB_PATH = join(DATA_DIR, 'workspaces', 'local.sqlite')
let app: ElectronApplication
let page: Page

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`等待数据库超时：${path}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

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

async function openDashboard(): Promise<void> {
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: /今天/ })
    .click()
  await expect(page.locator('.studio-today')).toBeVisible()
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  await launch()
  await waitForFile(DB_PATH)
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(DATA_DIR, { recursive: true, force: true })
})

test('通知预览支持 Tab、Enter、Space 和鼠标激活', async () => {
  const notice = page.locator('.today-side-col .notice-item').first()
  await expect(notice).toBeVisible()

  await page.locator('.today-side-col .text-link').focus()
  await page.keyboard.press('Tab')
  await expect(notice).toBeFocused()
  expect(await notice.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe('none')
  const labelBeforeKeyboard = await notice.getAttribute('aria-label')

  await notice.press('Enter')
  await expect(page.getByRole('heading', { name: '通知中心' })).toBeVisible()

  await openDashboard()
  await page.locator('.today-side-col .notice-item').first().focus()
  await page.locator('.today-side-col .notice-item').first().press('Space')
  await expect(page.getByRole('heading', { name: '通知中心' })).toBeVisible()

  await openDashboard()
  const noticeAfterKeyboard = page.locator('.today-side-col .notice-item').first()
  expect(labelBeforeKeyboard).not.toBeNull()
  await expect(noticeAfterKeyboard).toHaveAttribute('aria-label', labelBeforeKeyboard ?? '')
  await noticeAfterKeyboard.click()
  await expect(page.getByRole('heading', { name: '通知中心' })).toBeVisible()
})

test('1024 下首页布局合理且没有横向溢出', async () => {
  await page.setViewportSize({ width: 1024, height: 900 })
  await openDashboard()
  const work = await page.locator('.today-work-col').boundingBox()
  const notice = await page.locator('.today-side-col').boundingBox()
  expect(work).not.toBeNull()
  expect(notice).not.toBeNull()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  ).toBe(true)
})

test('跨过截止时间后待办保持可见并标记为逾期', async () => {
  const start = '2026-11-19T10:00:00+08:00'
  const startMs = Date.parse(start)
  const dueAt = new Date(startMs + 30_000).toISOString()
  const db = new DatabaseSync(DB_PATH)
  try {
    // Isolate the bucket transition from the six-item dashboard preview: with
    // demo tasks present, a newly overdue task can be pushed out by upcoming
    // tasks before this assertion sees its row.
    db.exec('DELETE FROM tasks')
    db.prepare(
      `INSERT INTO tasks
        (id, title, course_id, priority, kind, status, due_at, source, created_at, updated_at)
       VALUES (?, ?, NULL, 'high', 'homework', 'todo', ?, 'manual', ?, ?)`
    ).run(
      'b4-time-task',
      'B4 跨时任务',
      dueAt,
      new Date(startMs).toISOString(),
      new Date(startMs).toISOString()
    )
  } finally {
    db.close()
  }

  await page.addInitScript(
    ({ startTime }) => {
      const RealDate = Date
      const startMs = RealDate.parse(startTime)
      let offset = startMs - RealDate.now()
      const FakeDate = function (...args: unknown[]) {
        return args.length > 0
          ? (Reflect.construct(RealDate, args) as Date)
          : new RealDate(RealDate.now() + offset)
      } as unknown as DateConstructor
      FakeDate.now = () => RealDate.now() + offset
      FakeDate.parse = RealDate.parse
      FakeDate.UTC = RealDate.UTC
      ;(FakeDate as unknown as { prototype: Date }).prototype = RealDate.prototype
      Object.setPrototypeOf(FakeDate, RealDate)
      window.Date = FakeDate
      ;(window as Window & { __b4Advance?: (ms: number) => void }).__b4Advance = (ms) => {
        offset += ms
      }
      const realSetInterval = window.setInterval.bind(window)
      window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
        realSetInterval(
          handler,
          timeout === 60_000 ? 50 : timeout,
          ...args
        )) as typeof window.setInterval
    },
    { startTime: start }
  )
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })
  await openDashboard()

  const countPill = page.locator('.today-work-col .studio-count-pill').first()
  await expect(countPill).toBeVisible()
  const before = Number((await countPill.innerText()).trim())
  const pendingTask = page.locator('.today-work-col .today-task-title', { hasText: 'B4 跨时任务' })
  const pendingRow = page.locator('.today-work-col .today-task-row', { hasText: 'B4 跨时任务' })
  await expect(pendingTask).toBeVisible()
  await expect(pendingRow).not.toHaveClass(/is-overdue/)

  await page.evaluate(() => {
    ;(window as Window & { __b4Advance?: (ms: number) => void }).__b4Advance?.(120_000)
  })
  // The dashboard samples `now` on mount and then refreshes it on a timer.
  // Re-enter the route so this assertion does not depend on timer throttling.
  await openDashboard()
  await expect(pendingTask).toBeVisible()
  await expect(pendingRow).toHaveClass(/is-overdue/)
  await expect.poll(async () => Number((await countPill.innerText()).trim())).toBe(before)
})

test('仅有演示通知时明确标注来源，不冒充平台通知', async () => {
  const db = new DatabaseSync(DB_PATH)
  try {
    db.exec('DELETE FROM app_notices')
  } finally {
    db.close()
  }
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })
  await openDashboard()

  const notices = page.locator('.today-side-col')
  await expect(notices.locator('.notice-item').first()).toBeVisible()
  await expect(notices).toContainText('本地演示通知，不代表学习通平台数据')
  await expect(notices).not.toContainText('来自学习通 Web Session 的只读通知')
  await expect(notices.locator('.notice-item').first()).toContainText('演示通知')
})
