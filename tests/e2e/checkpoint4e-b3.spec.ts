import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
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
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-4e-b3-'))

interface BootstrapCourse {
  id: string
  name: string
  clazzId?: string | null
  className?: string | null
  code?: string | null
}

let app: ElectronApplication
let page: Page
let contentCourses: Array<{
  course: BootstrapCourse
  chapter: { id: string; courseId: string; title: string }
}>

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

test.beforeAll(async () => {
  await launch()
  const data = await page.evaluate(() =>
    (
      window.studynext as unknown as {
        bootstrap: () => Promise<{
          courses: BootstrapCourse[]
          chapters: Array<{ id: string; courseId: string; title: string }>
        }>
      }
    ).bootstrap()
  )

  contentCourses = [...new Set(data.chapters.map((chapter) => chapter.courseId))]
    .map((courseId) => {
      const course = data.courses.find((item) => item.id === courseId)
      const chapter = data.chapters.find((item) => item.courseId === courseId)
      return course && chapter ? { course, chapter } : null
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('跨课程搜索保留课程归属并定位到目标章节', async () => {
  const first = contentCourses[0]
  const second = contentCourses[1]
  test.skip(!first || !second, '演示数据需要至少两门带章节的课程')
  if (!first || !second) return
  await openCourses()

  await page.locator(`.course-rail-item[data-course-id="${first.course.id}"]`).click()
  await page.keyboard.press('Control+K')
  const input = page.locator('.command-input-row input')
  await expect(input).toBeVisible()
  await input.fill(second.chapter.title)

  const result = page
    .locator('.command-item')
    .filter({ hasText: second.chapter.title })
    .filter({ hasText: second.course.name })
    .first()
  await expect(result).toBeVisible()
  await result.click()

  await expect(page.locator('.command-palette')).toHaveCount(0)
  await expect(page.locator('.course-rail-item.active')).toHaveAttribute(
    'data-course-id',
    second.course.id
  )
  await expect(page.locator('.chapter-card.focused')).toHaveAttribute(
    'data-chapter-id',
    second.chapter.id
  )
})

test('手动选择课程跨页面保留', async () => {
  const target = contentCourses[1]?.course
  test.skip(!target, '演示数据需要至少两门带章节的课程')
  if (!target) return
  await openCourses()
  await page.locator(`.course-rail-item[data-course-id="${target.id}"]`).click()
  await expect(page.locator('.course-rail-item.active')).toHaveAttribute(
    'data-course-id',
    target.id
  )

  await page.locator('.studio-pill-item', { hasText: '今天' }).click()
  await openCourses()
  await expect(page.locator('.course-rail-item.active')).toHaveAttribute(
    'data-course-id',
    target.id
  )
})

test('章节手风琴使用独立按钮，支持键盘且不嵌套交互元素', async () => {
  await openCourses()
  const card = page.locator('.chapter-card').first()
  const toggle = card.locator('.chapter-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')

  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')

  await expect(toggle.locator('button')).toHaveCount(0)
  await expect(card.locator('.chapter-open')).toHaveCount(1)
  await expect(card.locator('.chapter-body [role="button"]')).toHaveCount(0)
})

test('900 宽度下课程空间单栏适配且无横向溢出', async () => {
  await openCourses()
  await page.setViewportSize({ width: 900, height: 900 })
  await expect(page.locator('.course-rail')).toBeVisible()
  await expect(page.locator('.course-stage')).toBeVisible()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  ).toBe(true)
})

test('章节进度条在 0%、50%、100% 下渲染真实宽度', async () => {
  const target = contentCourses[0]
  test.skip(!target, '演示数据需要至少一门带三个章节的课程')
  if (!target) return

  const db = new DatabaseSync(join(DATA_DIR, 'workspaces', 'local.sqlite'))
  db.exec('PRAGMA busy_timeout = 5000')

  const chapters = db
    .prepare('SELECT id FROM course_chapters WHERE course_id = ? ORDER BY sort_order, id LIMIT 3')
    .all(target.course.id) as Array<{ id: string }>
  expect(chapters.length).toBe(3)

  const removePoints = db.prepare('DELETE FROM study_points WHERE chapter_id = ?')
  const insertPoint = db.prepare(
    `INSERT INTO study_points
      (id, chapter_id, course_id, external_id, title, kind, status,
       duration_minutes, sort_order, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'reading', ?, NULL, ?, 'chaoxing', ?, ?)`
  )
  const now = new Date().toISOString()
  const doneCounts = [0, 1, 2]

  try {
    chapters.forEach((chapter, chapterIndex) => {
      removePoints.run(chapter.id)
      for (let pointIndex = 0; pointIndex < 2; pointIndex += 1) {
        insertPoint.run(
          randomUUID(),
          chapter.id,
          target.course.id,
          `e2e-progress-${chapterIndex}-${pointIndex}`,
          `进度测试 ${pointIndex + 1}`,
          pointIndex < (doneCounts[chapterIndex] ?? 0) ? 'done' : 'todo',
          pointIndex,
          now,
          now
        )
      }
    })
  } finally {
    db.close()
  }

  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })
  await openCourses()
  await page.locator(`.course-rail-item[data-course-id="${target.course.id}"]`).click()
  await page.getByRole('button', { name: /全部展开/ }).click()

  for (const [index, chapter] of chapters.entries()) {
    const card = page.locator(`.chapter-card[data-chapter-id="${chapter.id}"]`)
    await expect(card).toBeVisible()
    const widths = await card.evaluate((element) => {
      const track = element.querySelector('.progress-track')
      const fill = element.querySelector('.progress-fill')
      if (!track || !fill) return null
      return {
        track: track.getBoundingClientRect().width,
        fill: fill.getBoundingClientRect().width
      }
    })

    expect(widths, `chapter ${chapter.id} should render a progress track`).not.toBeNull()
    if (!widths) continue
    expect(widths.track).toBeGreaterThan(20)
    const expected = (widths.track * (doneCounts[index] ?? 0)) / 2
    expect(Math.abs(widths.fill - expected)).toBeLessThanOrEqual(2)
  }
})
