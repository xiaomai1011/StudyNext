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
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-4d-'))
const DB_PATH = join(DATA_DIR, 'workspaces', 'local.sqlite')

let app: ElectronApplication
let page: Page
let courses: Array<{ id: string; name: string }>

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`等待数据库超时：${path}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function openCourseMaterials(classLabel: string): Promise<void> {
  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await expect(page.locator('.studio-course-shell')).toBeVisible()
  const closeDownloads = page.getByRole('button', { name: '返回课程' })
  if ((await closeDownloads.count()) > 0) await closeDownloads.click()
  await page.locator('.course-rail-item').filter({ hasText: classLabel }).click()
  await page.getByRole('tab', { name: /课件资料/ }).click()
  await expect(page.locator('.course-materials-pane')).toBeVisible()
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

function seed(): void {
  const [courseA, courseB] = courses
  if (!courseA || !courseB) throw new Error('演示数据缺少两门课程')
  const db = new DatabaseSync(DB_PATH)
  const now = new Date().toISOString()
  try {
    db.prepare('UPDATE courses SET name = ?, class_name = ? WHERE id = ?').run(
      '数据结构',
      '2024级1班',
      courseA.id
    )
    db.prepare('UPDATE courses SET name = ?, class_name = ? WHERE id = ?').run(
      '数据结构',
      '2024级2班',
      courseB.id
    )
    const insert = db.prepare(`
      INSERT INTO materials
        (id, course_id, external_id, name, kind, file_type, size, url, source_url, source, updated_at)
      VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, 'chaoxing', ?)
    `)
    insert.run(
      'material-a1',
      courseA.id,
      'material:url:a1',
      '同名讲义.pdf',
      'pdf',
      '1 MB',
      null,
      'https://p.ananas.chaoxing.com/star3/origin/a1.pdf',
      now
    )
    insert.run(
      'material-a2',
      courseA.id,
      'material:url:a2',
      '同名讲义.pdf',
      'pdf',
      '2 MB',
      null,
      'https://p.ananas.chaoxing.com/star3/origin/a2.pdf',
      now
    )
    insert.run(
      'material-b1',
      courseB.id,
      'material:url:b1',
      '同名讲义.pdf',
      'pdf',
      '3 MB',
      null,
      'https://p.ananas.chaoxing.com/star3/origin/b1.pdf',
      now
    )
    insert.run(
      'material-doc',
      courseA.id,
      'material:url:doc',
      '实验指导.docx',
      'docx',
      '512 KB',
      null,
      'https://p.ananas.chaoxing.com/star3/origin/doc.docx',
      now
    )
    insert.run(
      'material-third',
      courseA.id,
      'material:url:third',
      '第三方讲义.pdf',
      'pdf',
      '800 KB',
      'https://example.com/third-party.pdf',
      'https://example.com/third-party.pdf',
      now
    )

    const download = db.prepare(`
      INSERT INTO downloads
        (id, filename, url, state, received_bytes, total_bytes, started_at, completed_at, save_path, material_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    download.run(
      'download-a1',
      '同名讲义.pdf',
      'https://p.ananas.chaoxing.com/star3/origin/a1.pdf',
      'completed',
      1024,
      1024,
      now,
      now,
      join(DATA_DIR, '同名讲义.pdf'),
      'material-a1'
    )
    download.run(
      'download-a2',
      '同名讲义 (1).pdf',
      'https://p.ananas.chaoxing.com/star3/origin/a2.pdf',
      'progressing',
      512,
      1024,
      now,
      null,
      join(DATA_DIR, '同名讲义 (1).pdf'),
      'material-a2'
    )
    download.run(
      'download-b1',
      '同名讲义.pdf',
      'https://p.ananas.chaoxing.com/star3/origin/b1.pdf',
      'interrupted',
      0,
      0,
      now,
      null,
      null,
      'material-b1'
    )
  } finally {
    db.close()
  }
}

test.beforeAll(async () => {
  await launch()
  await waitForFile(DB_PATH)
  courses = await page.evaluate(() => {
    const api = window.studynext as unknown as {
      bootstrap: () => Promise<{ courses: Array<{ id: string; name: string }> }>
    }
    return api.bootstrap().then((data) => data.courses.slice(0, 2))
  })
  await app.close()
  seed()
  await launch()
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('课程空间按课程与教学班隔离资料，同名资料不合并', async () => {
  await openCourseMaterials('2024级1班')
  await expect(
    page.locator('.course-rail-item').filter({ hasText: '教学班 2024级1班' })
  ).toHaveCount(1)
  await expect(
    page.locator('.course-rail-item').filter({ hasText: '教学班 2024级2班' })
  ).toHaveCount(1)
  await expect(page.locator('.materials-item')).toHaveCount(4)
  await expect(page.locator('.materials-item').filter({ hasText: '同名讲义.pdf' })).toHaveCount(2)

  await openCourseMaterials('2024级2班')
  await expect(page.locator('.materials-item')).toHaveCount(1)
  await expect(page.locator('.materials-item').filter({ hasText: '同名讲义.pdf' })).toHaveCount(1)
})

test('资料行展示下载状态，中断任务在重启后恢复为可重试状态', async () => {
  await openCourseMaterials('2024级1班')
  const completed = page
    .locator('.materials-item')
    .filter({ hasText: '同名讲义.pdf' })
    .filter({ hasText: '已完成' })
  await expect(completed).toHaveCount(1)
  await expect(completed.locator('.download-inline-state.completed')).toContainText('已完成')

  const interruptedA = page
    .locator('.materials-item')
    .filter({ hasText: '同名讲义.pdf' })
    .filter({ hasText: '下载失败或中断' })
  await expect(interruptedA).toHaveCount(1)

  await page.locator('.rail-downloads-btn').click()
  const queue = page.getByRole('region', { name: '下载队列' })
  await expect(queue).toBeVisible()
  await expect(queue.locator('.download-queue-item')).toHaveCount(3)
  await expect(queue).toContainText('下载失败或中断')
  await expect(queue.getByRole('button', { name: '重试下载' })).toHaveCount(2)
  await expect(queue.getByRole('button', { name: '再次下载' })).toHaveCount(1)

  await queue.getByRole('button', { name: '清除已结束' }).click()
  await expect(page.locator('.download-queue-empty')).toBeVisible()
})

test('不支持内嵌预览的官方文件在官方页面打开，第三方文件在系统浏览器打开', async () => {
  await openCourseMaterials('2024级1班')
  const doc = page.locator('.materials-item').filter({ hasText: '实验指导.docx' })
  await expect(doc.locator('.materials-main')).toHaveAttribute(
    'title',
    '该文件不支持应用内预览，将在学习通官方页面打开'
  )
  await expect(doc.getByRole('button', { name: /在官方页面打开 实验指导.docx/ })).toBeVisible()
  await expect(doc.getByRole('button', { name: /下载 实验指导.docx/ })).toBeVisible()

  const thirdParty = page.locator('.materials-item').filter({ hasText: '第三方讲义.pdf' })
  await expect(thirdParty.locator('.materials-main')).toHaveAttribute(
    'title',
    '该链接不在学习通域名，将在系统浏览器打开'
  )
  await expect(
    thirdParty.getByRole('button', { name: /在浏览器打开 第三方讲义.pdf/ })
  ).toBeVisible()

  await app.evaluate(({ shell }) => {
    const scope = globalThis as unknown as { __d002OpenedExternal?: string[] }
    scope.__d002OpenedExternal = []
    const shellApi = shell as unknown as { openExternal: (url: string) => Promise<void> }
    shellApi.openExternal = async (url: string) => {
      scope.__d002OpenedExternal?.push(url)
    }
  })
  await thirdParty.getByRole('button', { name: /在浏览器打开 第三方讲义.pdf/ }).click()
  const opened = await app.evaluate(() => {
    const scope = globalThis as unknown as { __d002OpenedExternal?: string[] }
    return scope.__d002OpenedExternal ?? []
  })
  expect(opened).toEqual(['https://example.com/third-party.pdf'])
})
