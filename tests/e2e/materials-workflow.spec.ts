import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-materials-wf-'))
const DB_PATH = join(DATA_DIR, 'workspaces', 'local.sqlite')
const DOWNLOAD_DIR = join(DATA_DIR, 'downloads')
const LOCAL_FILE_A = join(DOWNLOAD_DIR, '第一章讲义.pdf')
const LOCAL_FILE_RECOVERED = join(DOWNLOAD_DIR, '已恢复课件.pdf')
const LOCAL_FILE_B = join(DOWNLOAD_DIR, 'B班实验汇总.pdf')

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

/**
 * Only intercept OS-level `shell.openPath` so tests verify the exact path passed
 * by production `PortalService.openMaterialLocalFile` without launching an external PDF viewer.
 * All production IPC handlers (`materials:*`, `portal:*`) and `PortalService` run untouched.
 */
async function stubShellOpenPath(): Promise<void> {
  await app.evaluate(({ shell }) => {
    const scope = globalThis as unknown as { __n006OpenedPaths?: string[] }
    scope.__n006OpenedPaths = []
    const shellApi = shell as unknown as { openPath: (path: string) => Promise<string> }
    shellApi.openPath = async (targetPath: string) => {
      scope.__n006OpenedPaths?.push(targetPath)
      return ''
    }
  })
}

async function getOpenedPaths(): Promise<string[]> {
  return app.evaluate(() => {
    const scope = globalThis as unknown as { __n006OpenedPaths?: string[] }
    return [...(scope.__n006OpenedPaths ?? [])]
  })
}

function seedFixture(): void {
  const db = new DatabaseSync(DB_PATH)
  const now = '2026-11-24T12:00:00.000Z'
  const earlier = '2026-11-23T12:00:00.000Z'
  const oldest = '2026-11-20T12:00:00.000Z'

  // Create real local files on disk
  mkdirSync(DOWNLOAD_DIR, { recursive: true })
  writeFileSync(LOCAL_FILE_A, '%PDF-1.4 chapter-1 local copy')
  writeFileSync(LOCAL_FILE_RECOVERED, '%PDF-1.4 recovered local copy')
  writeFileSync(LOCAL_FILE_B, '%PDF-1.4 course-b local copy')

  try {
    db.exec('BEGIN')

    const insertCourse = db.prepare(`
      INSERT OR REPLACE INTO courses (
        id, external_id, name, code, teacher, semester, category, color,
        favorite, clazz_id, class_name, schedule_json, semester_start, max_week,
        source, source_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, 16, 'chaoxing', ?, ?, ?)
    `)

    insertCourse.run(
      'mat-course-a',
      '30001:60001',
      '计算机组成原理',
      'CS201',
      '李老师',
      '2026年秋',
      '专业课',
      '#2558d9',
      1,
      '60001',
      '计科1班',
      'https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=30001&clazzid=60001&cpi=9001',
      now,
      now
    )

    insertCourse.run(
      'mat-course-b',
      '30001:60002',
      '计算机组成原理',
      'CS201',
      '王老师',
      '2026年秋',
      '专业课',
      '#0f766e',
      0,
      '60002',
      '计科2班',
      'https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=30001&clazzid=60002&cpi=9002',
      now,
      now
    )

    const insertMaterial = db.prepare(`
      INSERT OR REPLACE INTO materials (
        id, course_id, external_id, name, kind, file_type, size, url, source_url, source, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'chaoxing', ?)
    `)

    // Course A materials:
    // 1. mat-a-done: completed real local file on disk (+ newer interrupted retry)
    insertMaterial.run(
      'mat-a-done',
      'mat-course-a',
      'material:9001',
      '第一章讲义.pdf',
      'file',
      'pdf',
      '2.4 MB',
      null,
      'https://p.ananas.chaoxing.com/star3/origin/ch1.pdf',
      now
    )
    // 2. mat-a-todo-1: undownloaded URL file (invalid.chaoxing.com -> real transfer failure via PortalService!)
    insertMaterial.run(
      'mat-a-todo-1',
      'mat-course-a',
      'material:url:9002',
      '第二章讲义.pdf',
      'file',
      'pdf',
      '3.1 MB',
      null,
      'https://invalid.chaoxing.com/star3/origin/ch2.pdf',
      now
    )
    // 3. mat-a-todo-2: undownloaded URL file (invalid.chaoxing.com -> real transfer failure via PortalService!)
    insertMaterial.run(
      'mat-a-todo-2',
      'mat-course-a',
      'material:url:9003',
      '实验指导手册.docx',
      'file',
      'docx',
      '840 KB',
      null,
      'https://invalid.chaoxing.com/star3/origin/lab.docx',
      now
    )
    // 4. mat-a-folder: non-downloadable folder
    insertMaterial.run(
      'mat-a-folder',
      'mat-course-a',
      'material:9004',
      '补充代码目录',
      'folder',
      'afolder',
      null,
      null,
      null,
      now
    )
    // 5. mat-a-ext: non-downloadable third-party link
    insertMaterial.run(
      'mat-a-ext',
      'mat-course-a',
      'material:url:ext',
      '外部参考仓库',
      'link',
      'url',
      null,
      'https://github.com/example/cs201',
      'https://github.com/example/cs201',
      now
    )

    // Course B material with real local file + another failed material
    insertMaterial.run(
      'mat-b-done',
      'mat-course-b',
      'material:9005',
      'B班实验汇总.pdf',
      'file',
      'pdf',
      '1.5 MB',
      null,
      'https://p.ananas.chaoxing.com/star3/origin/b-lab.pdf',
      now
    )
    insertMaterial.run(
      'mat-b-failed',
      'mat-course-b',
      'material:url:9006',
      'B班失败课件.pdf',
      'file',
      'pdf',
      '1.2 MB',
      null,
      'https://invalid.chaoxing.com/star3/origin/b-fail.pdf',
      now
    )

    const insertDownload = db.prepare(`
      INSERT OR REPLACE INTO downloads (
        id, filename, url, state, received_bytes, total_bytes, started_at, completed_at, save_path, material_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    // Completed download for mat-a-done (real file exists on disk) + newer failed retry
    insertDownload.run(
      'dl-a-done-ok',
      '第一章讲义.pdf',
      'https://mooc1.chaoxing.com/coursedata/downloadData?dataId=9001',
      'completed',
      29,
      29,
      earlier,
      earlier,
      LOCAL_FILE_A,
      'mat-a-done'
    )
    insertDownload.run(
      'dl-a-done-failed',
      '第一章讲义 (1).pdf',
      'https://mooc1.chaoxing.com/coursedata/downloadData?dataId=9001',
      'interrupted',
      0,
      0,
      now,
      now,
      null,
      'mat-a-done'
    )
    // Course B completed download
    insertDownload.run(
      'dl-b-done-ok',
      'B班实验汇总.pdf',
      'https://mooc1.chaoxing.com/coursedata/downloadData?dataId=9005',
      'completed',
      29,
      29,
      oldest,
      oldest,
      LOCAL_FILE_B,
      'mat-b-done'
    )

    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

test.beforeAll(async () => {
  await launch()
  await waitForFile(DB_PATH)
  await app.close()
  seedFixture()
  await launch()
  await stubShellOpenPath()
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('N-006-R 1：清除队列后仍识别并打开已下载文件，不删除用户文件；>100条历史重启仍防重复且批量传输失败有真实反馈', async () => {
  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await expect(page.locator('.studio-course-shell')).toBeVisible()
  await page.locator('.course-rail-item[data-course-id="mat-course-a"]').click()
  await page.getByRole('tab', { name: /课件资料/ }).click()
  await expect(page.locator('.course-materials-pane')).toBeVisible()

  // 1. Open Download Manager -> clear all finished queue records -> user file stays intact & material stays recognized!
  await page
    .locator('.materials-download-strip')
    .getByRole('button', { name: /打开下载管理/ })
    .click()
  const queue = page.getByRole('region', { name: '下载队列' })
  await expect(queue).toBeVisible()
  await queue.getByRole('button', { name: '清除已结束' }).click()
  await expect(page.locator('.download-queue-empty')).toBeVisible()
  expect(existsSync(LOCAL_FILE_A)).toBe(true)

  // Return to Course A materials -> mat-a-done STILL shows local copy & opens exact file via production IPC!
  await page.getByRole('button', { name: '返回课程' }).click()
  const doneRow = page.locator('.materials-item[data-material-id="mat-a-done"]')
  await expect(doneRow).toContainText('已下载')
  await doneRow.getByRole('button', { name: /打开已下载文件 第一章讲义.pdf/ }).click()
  await expect.poll(getOpenedPaths).toEqual([LOCAL_FILE_A])

  // 2. Push >100 download history records into SQLite and restart app -> mat-a-done MUST still be recognized & skipped!
  await app.close()
  const db = new DatabaseSync(DB_PATH)
  try {
    db.exec('BEGIN')
    const insertFiller = db.prepare(`
      INSERT INTO downloads (
        id, filename, url, state, received_bytes, total_bytes, started_at, completed_at, save_path, material_id
      ) VALUES (?, ?, ?, 'interrupted', 0, 0, ?, ?, NULL, NULL)
    `)
    for (let i = 0; i < 110; i += 1) {
      const ts = new Date(Date.parse('2026-11-24T13:00:00.000Z') + i * 1000).toISOString()
      insertFiller.run(
        `dl-overflow-${i}`,
        `filler-${i}.pdf`,
        `https://mooc1.chaoxing.com/f/${i}`,
        ts,
        ts
      )
    }
    db.exec('COMMIT')
  } finally {
    db.close()
  }

  await launch()
  await stubShellOpenPath()
  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await page.locator('.course-rail-item[data-course-id="mat-course-a"]').click()
  await page.getByRole('tab', { name: /课件资料/ }).click()

  // Even after >100 history rows & restart, mat-a-done is STILL recognized as 已下载 (1) and skipped in batch!
  await expect(page.getByRole('button', { name: '已下载 1' })).toBeVisible()
  await expect(page.getByRole('button', { name: '未下载 2' })).toBeVisible()

  await page.getByRole('button', { name: '批量选择' }).click()
  const batchBar = page.getByRole('region', { name: '批量下载工具栏' })
  await batchBar.getByRole('button', { name: '全选可下载 (3)' }).click()
  await expect(batchBar).toContainText('其中 1 项已下载')

  // Trigger real production batch download for the 2 undownloaded items (pointing to invalid.chaoxing.com -> real transfer failure!)
  await batchBar.getByRole('button', { name: '批量下载 (2)' }).click()

  // 3. Real PortalService transfer failure produces real batch summary showing 传输失败 2 项 (NOT false success!)
  const batchSummary = page.getByRole('region', { name: '批量下载结果' })
  await expect(batchSummary).toBeVisible({ timeout: 20_000 })
  await expect(batchSummary).toContainText('传输失败 2 项', { timeout: 20_000 })
  await expect(batchSummary).toContainText('第二章讲义.pdf')
  await expect(batchSummary).toContainText('实验指导手册.docx')

  // Confirm mat-a-done was NOT re-downloaded in production downloads table
  const allDownloads = await page.evaluate(() => window.studynext.portal.downloads())
  expect(allDownloads.filter((item) => item.materialId === 'mat-a-done')).toHaveLength(0)
  expect(allDownloads.filter((item) => item.materialId === 'mat-a-todo-1')).toHaveLength(1)
  expect(allDownloads.filter((item) => item.materialId === 'mat-a-todo-2')).toHaveLength(1)

  // Clicking "选中失败项 (2)" selects ONLY the 2 truly transfer-failed materials
  await batchSummary.getByRole('button', { name: '选中失败项 (2)' }).click()
  await expect(page.getByRole('checkbox', { name: '选择 第二章讲义.pdf' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: '选择 实验指导手册.docx' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: '选择 第一章讲义.pdf' })).not.toBeChecked()

  // 4. Manually delete LOCAL_FILE_A from disk -> refreshing updates status honestly (no longer 已下载 / 打开文件!)
  unlinkSync(LOCAL_FILE_A)
  await page.getByRole('tab', { name: /章节学习/ }).click()
  await page.getByRole('tab', { name: /课件资料/ }).click()
  await expect(page.getByRole('button', { name: '已下载 0' })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: '未下载 3' })).toBeVisible()
  const doneRowAfterRestart = page.locator('.materials-item[data-material-id="mat-a-done"]')
  await expect(
    doneRowAfterRestart.getByRole('button', { name: /打开已下载文件 第一章讲义.pdf/ })
  ).toHaveCount(0)
  await expect(
    doneRowAfterRestart.getByRole('button', { name: /下载 第一章讲义.pdf/ })
  ).toBeVisible()
})

test('N-006-R 2：仅当前课程筛选批量重试不波及他课、同来源去重、已恢复来源排除且主进程强制校验', async () => {
  // Prepare clean download history in DB & restart
  await app.close()
  const db = new DatabaseSync(DB_PATH)
  const t1 = '2026-11-24T14:00:00.000Z'
  const t2 = '2026-11-24T14:01:00.000Z'
  const t3 = '2026-11-24T14:02:00.000Z'
  try {
    db.exec('BEGIN')
    db.exec('DELETE FROM downloads')
    db.exec('DELETE FROM material_local_files')

    // Add recovered material in Course A
    db.prepare(
      `
      INSERT OR REPLACE INTO materials (
        id, course_id, external_id, name, kind, file_type, size, url, source_url, source, updated_at
      ) VALUES ('mat-a-recovered', 'mat-course-a', 'material:url:9099', '已恢复课件.pdf', 'file', 'pdf', '1 MB', NULL, 'https://invalid.chaoxing.com/star3/origin/rec.pdf', 'chaoxing', ?)
    `
    ).run(t3)

    const insertDl = db.prepare(`
      INSERT INTO downloads (
        id, filename, url, state, received_bytes, total_bytes, started_at, completed_at, save_path, material_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    // Duplicate failures for mat-a-todo-1 (Course A) -> must be retried ONCE
    insertDl.run(
      'dl-a-dup-1',
      '第二章讲义.pdf',
      'https://invalid.chaoxing.com/star3/origin/ch2.pdf',
      'interrupted',
      0,
      0,
      t1,
      t1,
      null,
      'mat-a-todo-1'
    )
    insertDl.run(
      'dl-a-dup-2',
      '第二章讲义.pdf',
      'https://invalid.chaoxing.com/star3/origin/ch2.pdf',
      'interrupted',
      0,
      0,
      t2,
      t2,
      null,
      'mat-a-todo-1'
    )

    // Failed earlier then recovered for mat-a-recovered (Course A) -> must NOT enter retryable set!
    insertDl.run(
      'dl-a-rec-fail',
      '已恢复课件.pdf',
      'https://invalid.chaoxing.com/star3/origin/rec.pdf',
      'interrupted',
      0,
      0,
      t1,
      t1,
      null,
      'mat-a-recovered'
    )
    insertDl.run(
      'dl-a-rec-ok',
      '已恢复课件.pdf',
      'https://invalid.chaoxing.com/star3/origin/rec.pdf',
      'completed',
      28,
      28,
      t2,
      t2,
      LOCAL_FILE_RECOVERED,
      'mat-a-recovered'
    )

    // Course B failure -> must NOT be retried when Course A filter is active!
    insertDl.run(
      'dl-b-fail',
      'B班失败课件.pdf',
      'https://invalid.chaoxing.com/star3/origin/b-fail.pdf',
      'interrupted',
      0,
      0,
      t3,
      t3,
      null,
      'mat-b-failed'
    )

    db.exec('COMMIT')
  } finally {
    db.close()
  }

  await launch()
  await stubShellOpenPath()

  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await page.locator('.course-rail-item[data-course-id="mat-course-a"]').click()
  await page.getByRole('tab', { name: /课件资料/ }).click()
  await page
    .locator('.materials-download-strip')
    .getByRole('button', { name: /打开下载管理/ })
    .click()

  const queue = page.getByRole('region', { name: '下载队列' })
  await expect(queue).toBeVisible()

  // Global view: only 2 retryable unique sources (mat-a-todo-1 + mat-b-failed; excludes recovered mat-a-recovered and dedupes mat-a-todo-1!)
  await expect(queue.getByRole('button', { name: '重试全部失败 (2)' })).toBeVisible()

  // Toggle "仅当前课程" -> count drops to 1 ("重试本课失败 (1)")
  await queue.getByRole('button', { name: /仅当前课程/ }).click()
  await expect(queue.getByRole('button', { name: '重试本课失败 (1)' })).toBeVisible()

  // Trigger real production course-scoped batch retry
  await queue.getByRole('button', { name: '重试本课失败 (1)' }).click()

  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const list = await window.studynext.portal.downloads()
          return {
            aTodo: list.filter((d) => d.materialId === 'mat-a-todo-1').length,
            aRec: list.filter((d) => d.materialId === 'mat-a-recovered').length,
            bFail: list.filter((d) => d.materialId === 'mat-b-failed').length
          }
        }),
      { timeout: 15_000 }
    )
    .toEqual({ aTodo: 3, aRec: 2, bFail: 1 })

  // Wait for that retry to settle before calling main-process policy test directly
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const list = await window.studynext.portal.downloads()
          return list.some((d) => d.state === 'progressing')
        }),
      { timeout: 15_000 }
    )
    .toBe(false)

  // Verify MAIN PROCESS itself rejects out-of-scope Course B ID, recovered/local ID, and duplicate source IDs!
  const mainResult = await page.evaluate(() =>
    window.studynext.portal.retryFailedDownloads({
      courseId: 'mat-course-a',
      downloadIds: ['dl-a-dup-1', 'dl-a-dup-2', 'dl-a-rec-fail', 'dl-b-fail']
    })
  )
  expect(mainResult.startedMaterialIds).toEqual(['mat-a-todo-1'])
  expect(mainResult.skipped).toEqual(
    expect.arrayContaining([
      { id: 'dl-b-fail', reason: 'out_of_scope' },
      { id: 'dl-a-rec-fail', reason: 'already_local' },
      { id: 'dl-a-dup-1', reason: 'duplicate_source' }
    ])
  )
})

test('N-006-R2：资料页空闲零循环刷新、旧记录缺失不误删新副本、清队批次不倒退且跨入口恢复不重复重试', async () => {
  const multiOldPath = join(DOWNLOAD_DIR, '双副本讲义.pdf')
  const multiNewPath = join(DOWNLOAD_DIR, '双副本讲义 (1).pdf')
  const recoveredTodo1Path = join(DOWNLOAD_DIR, '第二章讲义.pdf')

  await app.close()
  mkdirSync(DOWNLOAD_DIR, { recursive: true })
  // Only the newer copy exists on disk; older copy was deleted
  if (existsSync(multiOldPath)) unlinkSync(multiOldPath)
  writeFileSync(multiNewPath, '%PDF-1.4 newer surviving copy')
  if (existsSync(recoveredTodo1Path)) unlinkSync(recoveredTodo1Path)

  const db = new DatabaseSync(DB_PATH)
  const t1 = '2026-11-24T15:00:00.000Z'
  const t2 = '2026-11-24T15:05:00.000Z'
  try {
    db.exec('BEGIN')
    db.exec('DELETE FROM downloads')
    db.exec('DELETE FROM material_local_files')

    db.prepare(
      `
      INSERT OR REPLACE INTO materials (
        id, course_id, external_id, name, kind, file_type, size, url, source_url, source, updated_at
      ) VALUES ('mat-a-multi', 'mat-course-a', 'material:url:9055', '双副本讲义.pdf', 'file', 'pdf', '1 MB', NULL, 'https://invalid.chaoxing.com/star3/origin/multi.pdf', 'chaoxing', ?)
    `
    ).run(t2)

    const insertDl = db.prepare(`
      INSERT INTO downloads (
        id, filename, url, state, received_bytes, total_bytes, started_at, completed_at, save_path, material_id
      ) VALUES (?, ?, ?, 'completed', 26, 26, ?, ?, ?, 'mat-a-multi')
    `)
    insertDl.run(
      'dl-multi-old',
      '双副本讲义.pdf',
      'https://invalid.chaoxing.com/star3/origin/multi.pdf',
      t1,
      t1,
      multiOldPath
    )
    insertDl.run(
      'dl-multi-new',
      '双副本讲义 (1).pdf',
      'https://invalid.chaoxing.com/star3/origin/multi.pdf',
      t2,
      t2,
      multiNewPath
    )

    db.prepare(
      `
      INSERT OR REPLACE INTO material_local_files (
        material_id, course_id, download_id, filename, save_path, file_size, downloaded_at
      ) VALUES ('mat-a-multi', 'mat-course-a', 'dl-multi-new', '双副本讲义 (1).pdf', ?, 26, ?)
    `
    ).run(multiNewPath, t2)

    db.exec('COMMIT')
  } finally {
    db.close()
  }

  await launch()
  await stubShellOpenPath()

  // Non-intrusively count real production `materials:local-files` IPC calls without replacing handler logic
  await app.evaluate(({ ipcMain }) => {
    const scope = globalThis as unknown as { __n006LocalFilesIpcCount?: number }
    scope.__n006LocalFilesIpcCount = 0
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers?: Map<string, (...args: unknown[]) => unknown>
      }
    )._invokeHandlers
    const original = handlers?.get('materials:local-files')
    if (handlers && original) {
      handlers.set('materials:local-files', (...args: unknown[]) => {
        scope.__n006LocalFilesIpcCount = (scope.__n006LocalFilesIpcCount ?? 0) + 1
        return original(...args)
      })
    }
  })

  const getLocalFilesIpcCount = () =>
    app.evaluate(() => {
      const scope = globalThis as unknown as { __n006LocalFilesIpcCount?: number }
      return scope.__n006LocalFilesIpcCount ?? 0
    })

  // 1. Open Course A -> 课件资料 tab -> verify NO infinite idle IPC refresh loop!
  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await page.locator('.course-rail-item[data-course-id="mat-course-a"]').click()
  await page.getByRole('tab', { name: /课件资料/ }).click()
  await expect(page.locator('.course-materials-pane')).toBeVisible()
  await page.waitForTimeout(250)
  const countAfterEnter = await getLocalFilesIpcCount()
  expect(countAfterEnter).toBeGreaterThanOrEqual(1)

  // Remain completely idle on 课件资料 for 1.2s -> zero additional IPC calls!
  await page.waitForTimeout(1200)
  const countAfterIdle = await getLocalFilesIpcCount()
  expect(countAfterIdle).toBe(countAfterEnter)

  // Switching to Course B triggers exactly 1 necessary refresh, then stays idle
  await page.locator('.course-rail-item[data-course-id="mat-course-b"]').click()
  await expect.poll(getLocalFilesIpcCount).toBe(countAfterIdle + 1)
  await page.waitForTimeout(700)
  expect(await getLocalFilesIpcCount()).toBe(countAfterIdle + 1)
  await page.locator('.course-rail-item[data-course-id="mat-course-a"]').click()
  await expect.poll(getLocalFilesIpcCount).toBe(countAfterIdle + 2)

  // 2. Opening old missing download record `dl-multi-old` must NOT wipe valid `dl-multi-new` local copy index!
  await page
    .locator('.materials-download-strip')
    .getByRole('button', { name: /打开下载管理/ })
    .click()
  const queue = page.getByRole('region', { name: '下载队列' })
  await expect(queue).toBeVisible()
  await queue
    .locator('.download-queue-item')
    .filter({ hasText: '双副本讲义.pdf' })
    .getByRole('button', { name: '打开文件' })
    .click()
  // Expect missing-file toast, yet valid newer copy `multiNewPath` remains indexed & openable!
  const localFilesAfterOldOpen = await page.evaluate(() => window.studynext.materials.localFiles())
  expect(localFilesAfterOldOpen.find((f) => f.materialId === 'mat-a-multi')).toMatchObject({
    downloadId: 'dl-multi-new',
    savePath: multiNewPath
  })

  // Return to Course A materials -> clicking 打开文件 on 双副本讲义.pdf opens multiNewPath!
  await page.getByRole('button', { name: '返回课程' }).click()
  await page
    .locator('.materials-item[data-material-id="mat-a-multi"]')
    .getByRole('button', { name: /打开已下载文件 双副本讲义.pdf/ })
    .click()
  await expect.poll(getOpenedPaths).toEqual([multiNewPath])

  // 3. Batch transfer failure -> clear queue -> batch status preserves observed terminal state (NEVER regresses to 传输中!)
  await page.getByRole('button', { name: '批量选择' }).click()
  await page.getByRole('checkbox', { name: '选择 第二章讲义.pdf' }).check()
  await page.getByRole('checkbox', { name: '选择 实验指导手册.docx' }).check()
  await page
    .getByRole('region', { name: '批量下载工具栏' })
    .getByRole('button', { name: '批量下载 (2)' })
    .click()

  const batchSummary = page.getByRole('region', { name: '批量下载结果' })
  await expect(batchSummary).toContainText('传输失败 2 项', { timeout: 20_000 })

  // Clear finished queue records
  await page
    .locator('.materials-download-strip')
    .getByRole('button', { name: /打开下载管理/ })
    .click()
  await queue.getByRole('button', { name: '清除已结束' }).click()
  await expect(page.locator('.download-queue-empty')).toBeVisible()
  await page.getByRole('button', { name: '返回课程' }).click()

  // Batch summary MUST NOT regress to "传输中"; observed terminal failure state is preserved!
  await expect(batchSummary).not.toContainText('本批次传输中')
  await expect(batchSummary).toContainText('传输失败 2 项')

  // 4. Recover mat-a-todo-1 externally -> retrying batch failures must ONLY retry mat-a-todo-2 (NO duplicate for mat-a-todo-1!)
  writeFileSync(recoveredTodo1Path, '%PDF-1.4 recovered externally')
  const dbRecover = new DatabaseSync(DB_PATH)
  try {
    dbRecover
      .prepare(
        `INSERT OR REPLACE INTO material_local_files (
           material_id, course_id, download_id, filename, save_path, file_size, downloaded_at
         ) VALUES ('mat-a-todo-1', 'mat-course-a', 'dl-ext-recovered', '第二章讲义.pdf', ?, 29, ?)`
      )
      .run(recoveredTodo1Path, '2026-11-24T15:10:00.000Z')
  } finally {
    dbRecover.close()
  }
  // Refresh verified local files via tab switch (production IPC)
  await page.getByRole('tab', { name: /章节学习/ }).click()
  await page.getByRole('tab', { name: /课件资料/ }).click()

  // Retryable count drops from 2 to 1!
  await expect(batchSummary.getByRole('button', { name: '重试本批失败 (1)' })).toBeVisible({
    timeout: 10_000
  })
  await batchSummary.getByRole('button', { name: '重试本批失败 (1)' }).click()

  // Verify ONLY mat-a-todo-2 gets a new download record; recovered mat-a-todo-1 is NOT downloaded again!
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const list = await window.studynext.portal.downloads()
          return {
            todo1: list.filter((d) => d.materialId === 'mat-a-todo-1').length,
            todo2: list.filter((d) => d.materialId === 'mat-a-todo-2').length
          }
        }),
      { timeout: 15_000 }
    )
    .toEqual({ todo1: 0, todo2: 1 })
})
