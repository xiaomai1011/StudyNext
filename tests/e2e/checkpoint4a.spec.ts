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
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-4a-'))
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

async function openCourses(): Promise<void> {
  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await expect(page.locator('.studio-course-shell')).toBeVisible()
}

async function searchChapter(
  courseName: string,
  chapterTitle: string,
  chapterId: string
): Promise<void> {
  await page.keyboard.press('Control+K')
  const input = page.locator('.command-input-row input')
  await expect(input).toBeVisible()
  await input.fill(chapterTitle)
  const item = page
    .locator('.command-item')
    .filter({ hasText: chapterTitle })
    .filter({ hasText: courseName })
    .first()
  await expect(item).toBeVisible()
  await item.click()
  await expect(page.locator('.studio-course-shell')).toBeVisible()
  await expect(page.locator('.chapter-card.focused')).toHaveAttribute('data-chapter-id', chapterId)
}

async function chapterFixture(): Promise<{
  courseA: { id: string; name: string }
  courseB: { id: string; name: string }
  chapterA: { id: string; courseId: string; title: string }
  chapterB: { id: string; courseId: string; title: string }
}> {
  const bootstrap = await page.evaluate(() => window.studynext.bootstrap())
  const byCourse = new Map<string, typeof bootstrap.chapters>()
  for (const chapter of bootstrap.chapters) {
    const list = byCourse.get(chapter.courseId) ?? []
    list.push(chapter)
    byCourse.set(chapter.courseId, list)
  }
  const courseIds = [...byCourse.keys()].filter((courseId) =>
    bootstrap.courses.some((course) => course.id === courseId)
  )
  const [courseA, courseB] = courseIds
  if (!courseA || !courseB) throw new Error('演示数据至少需要两门有章节的课程')
  const courseById = (id: string) => bootstrap.courses.find((course) => course.id === id)!
  const chapterA = byCourse.get(courseA)![0]!
  const chapterB = byCourse.get(courseB)![0]!
  return {
    courseA: { id: courseA, name: courseById(courseA).name },
    courseB: { id: courseB, name: courseById(courseB).name },
    chapterA,
    chapterB
  }
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

test('课程空间切换课件资料标签保留当前课程上下文', async () => {
  await openCourses()
  const firstCourse = page.locator('.course-rail-item').first()
  const courseName = (await firstCourse.locator('.course-rail-name').innerText()).trim()
  await firstCourse.click()
  await expect(page.locator('.course-hero-title')).toHaveText(courseName)

  await page.getByRole('tab', { name: /课件资料/ }).click()
  await expect(page.locator('.course-materials-pane')).toBeVisible()
  await expect(page.locator('.course-hero-title')).toHaveText(courseName)
})

test('课程空间官方入口缺少可靠 URL 时禁用', async () => {
  await openCourses()
  await page.locator('.course-rail-item').first().click()
  const officialBtn = page.getByRole('button', { name: '进入学习通课堂' })
  await expect(officialBtn).toHaveCount(1)
  await expect(officialBtn).toBeDisabled()
})

test('首页课表时间轴课程块支持点击与键盘打开对应课程空间', async () => {
  await page.locator('.studio-pill-item', { hasText: '今天' }).click()
  await expect(page.locator('.studio-today')).toBeVisible()
  await page.getByRole('button', { name: '时间轴', exact: true }).click()
  const block = page.locator('.week-course-block').first()
  await expect(block).toBeVisible()
  const courseName = (await block.locator('strong').innerText()).trim()

  await block.click()
  await expect(page.locator('.studio-course-shell')).toBeVisible()
  await expect(page.locator('.course-hero-title')).toHaveText(courseName)

  await page.locator('.studio-pill-item', { hasText: '今天' }).click()
  await page.getByRole('button', { name: '时间轴', exact: true }).click()
  const keyboardBlock = page.locator('.week-course-block').first()
  await expect(keyboardBlock).toBeVisible()
  await keyboardBlock.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.studio-course-shell')).toBeVisible()
  await expect(page.locator('.course-hero-title')).toHaveText(courseName)
})

test('命令面板章节结果定位到课程空间并展开对应章节', async () => {
  const bootstrap = await page.evaluate(() => window.studynext.bootstrap())
  const chapter = bootstrap.chapters[0]
  if (!chapter) throw new Error('演示数据中没有章节')
  const course = bootstrap.courses.find((item) => item.id === chapter.courseId)
  expect(course).toBeTruthy()

  await page.keyboard.press('Control+K')
  const input = page.locator('.command-input-row input')
  await expect(input).toBeVisible()
  await input.fill(chapter.title)
  const item = page.locator('.command-item').filter({ hasText: chapter.title }).first()
  await expect(item).toBeVisible()
  await item.click()

  await expect(page.locator('.studio-course-shell')).toBeVisible()
  await expect(page.locator('.course-rail-item.active')).toContainText(course!.name)
  const chapterCard = page.locator(`.chapter-card[data-chapter-id="${chapter.id}"]`)
  await expect(chapterCard).toBeVisible()
  await expect(chapterCard).toHaveClass(/focused/)
})

test('4A-01 A：定位后切换到另一课程不会重放旧章节高亮', async () => {
  const { courseA, courseB, chapterA } = await chapterFixture()
  await searchChapter(courseA.name, chapterA.title, chapterA.id)

  await page.locator(`.course-rail-item[data-course-id="${courseB.id}"]`).click()
  await expect(page.locator('.course-rail-item.active')).toContainText(courseB.name)
  await expect(page.locator('.chapter-card.focused')).toHaveCount(0)
})

test('4A-01 B：连续搜索不同课程章节时只定位最新请求', async () => {
  const { courseA, courseB, chapterA, chapterB } = await chapterFixture()
  await searchChapter(courseA.name, chapterA.title, chapterA.id)
  await searchChapter(courseB.name, chapterB.title, chapterB.id)

  const focused = page.locator('.chapter-card.focused')
  await expect(focused).toHaveCount(1)
  await expect(focused).toHaveAttribute('data-chapter-id', chapterB.id)
  await expect(page.locator('.course-rail-item.active')).toContainText(courseB.name)
})

test('4A-01 C：章节高亮计时结束后正常清除', async () => {
  const bootstrap = await page.evaluate(() => window.studynext.bootstrap())
  const chapter = bootstrap.chapters[0]
  if (!chapter) throw new Error('演示数据中没有章节')
  const course = bootstrap.courses.find((item) => item.id === chapter.courseId)!
  await searchChapter(course.name, chapter.title, chapter.id)
  await expect(page.locator('.chapter-card.focused')).toHaveCount(1)
  await page.waitForTimeout(3100)
  await expect(page.locator('.chapter-card.focused')).toHaveCount(0)
})
