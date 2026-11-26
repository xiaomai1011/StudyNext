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
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-4e-b1-'))
const DB_PATH = join(DATA_DIR, 'workspaces', 'local.sqlite')

let app: ElectronApplication
let page: Page
let courseA = ''
let courseB = ''

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

async function openCourses(): Promise<void> {
  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await expect(page.locator('.studio-course-shell')).toBeVisible()
}

function seed(): void {
  const db = new DatabaseSync(DB_PATH)
  try {
    db.prepare(
      "UPDATE courses SET name = '数据结构', clazz_id = 'class-a', class_name = '2024级1班', source_url = NULL WHERE id = ?"
    ).run(courseA)
    db.prepare(
      "UPDATE courses SET name = '数据结构', clazz_id = 'class-b', class_name = '2024级2班', source_url = 'https://mooc1.chaoxing.com/course/999999' WHERE id = ?"
    ).run(courseB)
  } finally {
    db.close()
  }
}

test.beforeAll(async () => {
  await launch()
  await waitForFile(DB_PATH)
  const ids = await page.evaluate(() => {
    const api = window.studynext as unknown as {
      bootstrap: () => Promise<{ courses: Array<{ id: string }> }>
    }
    return api.bootstrap().then((data) => data.courses.slice(0, 2).map((course) => course.id))
  })
  courseA = ids[0] ?? ''
  courseB = ids[1] ?? ''
  if (!courseA || !courseB) throw new Error('演示数据缺少两门课程')
  await app.close()
  seed()
  await launch()
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('同名课程在课程目录中按教学班区分且无嵌套交互元素', async () => {
  await openCourses()

  const items = page.locator('.course-rail-item').filter({ hasText: '数据结构' })
  await expect(items).toHaveCount(2)
  await expect(items.filter({ hasText: '2024级1班' })).toHaveCount(1)
  await expect(items.filter({ hasText: '2024级2班' })).toHaveCount(1)

  for (let index = 0; index < 2; index += 1) {
    const item = items.nth(index)
    await expect(item.locator('button')).toHaveCount(0)
    await expect(item.locator('a')).toHaveCount(0)
  }
})

test('收藏按钮支持键盘操作，不触发多余弹窗', async () => {
  await openCourses()
  await page.locator(`.course-rail-item[data-course-id="${courseA}"]`).click()
  const favorite = page.locator('.course-fav-toggle')

  const before = await favorite.getAttribute('aria-pressed')
  await favorite.focus()
  await page.keyboard.press('Enter')
  await expect(favorite).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true')
  await expect(page.locator('.modal')).toHaveCount(0)

  await page.keyboard.press('Space')
  await expect(favorite).toHaveAttribute('aria-pressed', before ?? 'false')
  await expect(page.locator('.modal')).toHaveCount(0)
})

test('课程目录支持键盘切换并保留课件上下文', async () => {
  await openCourses()
  const item = page.locator(`.course-rail-item[data-course-id="${courseA}"]`)
  await item.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.course-hero-title')).toHaveText('数据结构')
  await expect(page.locator('.course-hero-meta')).toContainText('2024级1班')

  await page.getByRole('tab', { name: /课件资料/ }).click()
  await expect(page.locator('.course-materials-pane')).toBeVisible()
  await expect(page.locator('.course-hero-meta')).toContainText('2024级1班')
})

test('官方入口按可靠 URL 启用或禁用', async () => {
  await openCourses()

  await page.locator(`.course-rail-item[data-course-id="${courseA}"]`).click()
  const officialBtn = page.getByRole('button', { name: '进入学习通课堂' })
  await expect(officialBtn).toBeDisabled()

  await page.locator(`.course-rail-item[data-course-id="${courseB}"]`).click()
  await expect(officialBtn).toBeEnabled()
})
