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
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-4c-'))
const DB_PATH = join(DATA_DIR, 'workspaces', 'local.sqlite')

let app: ElectronApplication
let page: Page
let fixture: {
  courseA: { id: string; name: string; chapters: number }
  courseB: { id: string; name: string }
}

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

test.beforeAll(async () => {
  await launch()
  await waitForFile(DB_PATH)
  fixture = await page.evaluate(() => {
    const data = window.studynext as unknown as {
      bootstrap: () => Promise<{
        courses: Array<{ id: string; name: string }>
        chapters: Array<{ courseId: string }>
        studyPoints: Array<{ courseId: string }>
      }>
    }
    return data.bootstrap().then((bootstrap) => {
      const counts = new Map<string, number>()
      for (const chapter of bootstrap.chapters) {
        counts.set(chapter.courseId, (counts.get(chapter.courseId) ?? 0) + 1)
      }
      const candidates = bootstrap.courses.filter(
        (course) =>
          (counts.get(course.id) ?? 0) > 0 &&
          bootstrap.studyPoints.some((point) => point.courseId === course.id)
      )
      const [courseA, courseB] = candidates
      if (!courseA || !courseB) throw new Error('演示数据至少需要两门有章节和任务点的课程')
      return {
        courseA: { id: courseA.id, name: courseA.name, chapters: counts.get(courseA.id) ?? 0 },
        courseB: { id: courseB.id, name: courseB.name }
      }
    })
  })

  await app.close()
  const db = new DatabaseSync(DB_PATH)
  try {
    db.prepare('DELETE FROM study_points WHERE course_id = ?').run(fixture.courseA.id)
    db.prepare(
      "UPDATE courses SET semester = 'E2E 学期 A', semester_start = NULL, max_week = 0 WHERE id = ?"
    ).run(fixture.courseA.id)
    db.prepare(
      "UPDATE courses SET semester = 'E2E 学期 B', semester_start = NULL, max_week = 0 WHERE id = ?"
    ).run(fixture.courseB.id)
  } finally {
    db.close()
  }
  await launch()
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('有章节但没有任务点的课程仍然展示章节和资源，不进入整页空态', async () => {
  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await expect(page.locator('.studio-course-shell')).toBeVisible()

  await page.locator(`.course-rail-item[data-course-id="${fixture.courseA.id}"]`).click()
  await expect(page.locator('.course-hero-title')).toHaveText(fixture.courseA.name)
  await expect(page.locator('.chapter-card')).toHaveCount(fixture.courseA.chapters)
  await expect(page.locator('.course-progress-summary')).toContainText('暂无任务点')
  await expect(page.locator('.chapter-card').first()).toContainText('无任务点')
  await expect(page.locator('.ds-empty-title')).toHaveCount(0)
})

test('多学期课程可以按学期筛选，不把不同学期混在一起', async () => {
  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await expect(page.locator('.studio-course-shell')).toBeVisible()

  const select = page.locator('select[aria-label="筛选课程学期"]')
  await expect(select).toBeVisible()
  await select.selectOption('E2E 学期 A')
  await expect(
    page.locator('.course-rail-item').filter({ hasText: fixture.courseA.name })
  ).toBeVisible()
  await expect(
    page.locator('.course-rail-item').filter({ hasText: fixture.courseB.name })
  ).toHaveCount(0)
})
