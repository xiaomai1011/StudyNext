import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-download-init-'))
const DB_PATH = join(DATA_DIR, 'workspaces', 'local.sqlite')
const BLOCKER = join(DATA_DIR, 'download-directory-blocker')
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

test.describe('下载初始化失败', () => {
  test.beforeAll(async () => {
    writeFileSync(BLOCKER, 'not a directory')
    await launch()
  })

  test.afterAll(async () => {
    await app.close()
    rmSync(DATA_DIR, { recursive: true, force: true })
  })

  test('目录创建失败会拒绝 IPC，且不会留下虚假下载记录', async () => {
    const db = new DatabaseSync(DB_PATH)
    const now = new Date().toISOString()
    db.prepare(
      `INSERT OR IGNORE INTO courses
       (id, external_id, name, code, teacher, semester, category, color, created_at, updated_at)
       VALUES ('download-init-course', 'download-init-course', '下载初始化测试', '', '', '', '其他', '#2c5f7c', ?, ?)`
    ).run(now, now)
    db.prepare(
      `INSERT OR REPLACE INTO materials
       (id, course_id, external_id, name, kind, file_type, size, url, source_url, source, updated_at)
       VALUES ('download-init-material', 'download-init-course', 'download-init-material',
               '初始化测试.pdf', 'file', 'pdf', '1 KB',
               'https://pan-yz.chaoxing.com/download/init-test', NULL, 'chaoxing', ?)`
    ).run(now)
    const material = { id: 'download-init-material' }
    db.close()

    await page.evaluate(async (directory) => {
      await window.studynext.settings.update({ downloadDirectory: directory })
    }, BLOCKER)

    const before = await page.evaluate(() => window.studynext.portal.downloads())
    const error = await page.evaluate(async (id) => {
      try {
        await window.studynext.materials.download(id)
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }, material!.id)
    const after = await page.evaluate(() => window.studynext.portal.downloads())

    expect(error).toBeTruthy()
    expect(after).toHaveLength(before.length)

    await page.evaluate(async () => {
      await window.studynext.settings.update({ downloadDirectory: '' })
    })
  })

  test('旧下载记录缺少 objectId 时重试安全失败', async () => {
    const db = new DatabaseSync(DB_PATH)
    const now = new Date().toISOString()
    db.prepare(
      `INSERT OR REPLACE INTO downloads
       (id, filename, url, state, received_bytes, total_bytes, started_at, completed_at,
        save_path, material_id, attachment_task_id, attachment_object_id,
        attachment_file_name, attachment_index)
       VALUES ('download-old-attachment', '旧附件.docx', 'https://d0.cldisk.com/download/old',
               'completed', 10, 10, ?, ?, NULL, NULL, 'task-old', NULL, '旧附件.docx', 0)`
    ).run(now, now)
    db.close()

    const before = await page.evaluate(() => window.studynext.portal.downloads())
    const error = await page.evaluate(async () => {
      try {
        await window.studynext.portal.retryDownload('download-old-attachment')
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })
    const after = await page.evaluate(() => window.studynext.portal.downloads())

    expect(error).toContain('缺少可验证的附件来源')
    expect(after).toHaveLength(before.length)
  })
})
