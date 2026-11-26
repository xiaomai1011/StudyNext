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
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-4dfix-'))
const DB_PATH = join(DATA_DIR, 'workspaces', 'local.sqlite')

let app: ElectronApplication
let page: Page
let courseId = ''

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

async function gotoMaterials(): Promise<void> {
  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await expect(page.locator('.studio-course-shell')).toBeVisible()
  await page.locator(`.course-rail-item[data-course-id="${courseId}"]`).click()
  await page.getByRole('tab', { name: /课件资料/ }).click()
  await expect(page.locator('.course-materials-pane')).toBeVisible()
}

function seed(): void {
  const db = new DatabaseSync(DB_PATH)
  const now = new Date().toISOString()
  try {
    const insertMaterial = db.prepare(`
      INSERT INTO materials
        (id, course_id, external_id, name, kind, file_type, size, url, source_url, source, updated_at)
      VALUES (?, ?, ?, ?, 'file', 'pdf', '1 MB', NULL, ?, 'chaoxing', ?)
    `)
    insertMaterial.run(
      'material-url-retry',
      courseId,
      'material:url:retry',
      '可重试讲义.pdf',
      'https://invalid.chaoxing.com/star3/origin/retry.pdf',
      now
    )
    insertMaterial.run(
      'material-url-ipc',
      courseId,
      'material:url:ipc',
      'URL 文件.pdf',
      'https://invalid.chaoxing.com/star3/origin/ipc.pdf',
      now
    )

    const insertDownload = db.prepare(`
      INSERT INTO downloads
        (id, filename, url, state, received_bytes, total_bytes, started_at, completed_at, save_path, material_id)
      VALUES (?, ?, ?, 'completed', 2048, 2048, ?, ?, ?, ?)
    `)
    insertDownload.run(
      'download-completed',
      '可重试讲义.pdf',
      'https://invalid.chaoxing.com/star3/origin/retry.pdf',
      now,
      now,
      join(DATA_DIR, '可重试讲义.pdf'),
      'material-url-retry'
    )
  } finally {
    db.close()
  }
}

test.beforeAll(async () => {
  await launch()
  await waitForFile(DB_PATH)
  courseId = await page.evaluate(async () => {
    const api = window.studynext as unknown as {
      bootstrap: () => Promise<{ courses: Array<{ id: string }> }>
    }
    const data = await api.bootstrap()
    return data.courses[0]?.id ?? ''
  })
  if (!courseId) throw new Error('缺少演示课程')
  await app.close()
  seed()
  await launch()
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('URL 型文件通过生产 IPC 创建下载任务，完成后可基于当前资料再次下载', async () => {
  await gotoMaterials()

  const row = page.locator('.materials-item').filter({ hasText: '可重试讲义.pdf' })
  await expect(row).toBeVisible()
  await expect(row.locator('.download-inline-state.completed')).toContainText('已完成')
  await page.locator('.rail-downloads-btn').click()
  const queue = page.getByRole('region', { name: '下载队列' })
  await expect(queue).toBeVisible()

  const before = await page.evaluate(() => window.studynext.portal.downloads())
  const completed = before.find((item) => item.id === 'download-completed')
  expect(completed?.materialId).toBe('material-url-retry')

  await queue
    .locator('.download-queue-item')
    .filter({ hasText: '可重试讲义.pdf' })
    .getByRole('button', { name: '再次下载' })
    .click()

  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const records = await window.studynext.portal.downloads()
          return records.filter((item) => item.materialId === 'material-url-retry').length
        }),
      { timeout: 20_000 }
    )
    .toBe(2)

  const afterAgain = await page.evaluate(() => window.studynext.portal.downloads())
  const newTask = afterAgain.find(
    (item) => item.materialId === 'material-url-retry' && item.id !== 'download-completed'
  )
  expect(newTask).toBeTruthy()
  expect(newTask?.filename).toBe('可重试讲义.pdf')
  expect(['progressing', 'interrupted']).toContain(newTask?.state)
})

test('URL 型文件不再因缺少数字平台 ID 被 IPC 拒绝', async () => {
  const result = await page.evaluate(async () => {
    try {
      await window.studynext.materials.download('material-url-ipc')
      return 'resolved'
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })
  expect(result).not.toContain('MATERIAL_NO_FILE_ID')

  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const records = await window.studynext.portal.downloads()
          return records.filter((item) => item.materialId === 'material-url-ipc').length
        }),
      { timeout: 20_000 }
    )
    .toBe(1)

  const records = await page.evaluate(() => window.studynext.portal.downloads())
  const created = records.find((item) => item.materialId === 'material-url-ipc')
  expect(created?.filename).toBe('URL 文件.pdf')
  expect(['progressing', 'interrupted']).toContain(created?.state)
})
