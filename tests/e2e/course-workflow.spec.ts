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
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-course-workflow-'))
const RESUME_STORAGE_KEY = 'studynext.course-study-resume.v1'
let app: ElectronApplication
let page: Page
let dbPath: string

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`等待数据库超时：${path}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function installPortalUrlSpy(): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const bag = globalThis as unknown as {
      __capturedPortalUrls?: string[]
      __lastPortalUrl?: string
    }
    bag.__capturedPortalUrls = []
    bag.__lastPortalUrl = ''

    ipcMain.removeHandler('portal:open-url')
    ipcMain.handle('portal:open-url', async (_event, url: string) => {
      bag.__capturedPortalUrls?.push(url)
      bag.__lastPortalUrl = url
      return {
        visible: true,
        url,
        title: 'Mock Chaoxing Portal',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        lastError: null,
        entryId: null
      }
    })

    ipcMain.removeHandler('portal:get-state')
    ipcMain.handle('portal:get-state', async () => ({
      visible: true,
      url: bag.__lastPortalUrl || 'https://mooc1.chaoxing.com/',
      title: 'Mock Chaoxing Portal',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      lastError: null,
      entryId: null
    }))
  })
}

async function getCapturedPortalUrls(): Promise<string[]> {
  return app.evaluate(() => {
    const bag = globalThis as unknown as { __capturedPortalUrls?: string[] }
    return [...(bag.__capturedPortalUrls ?? [])]
  })
}

async function clearCapturedPortalUrls(): Promise<void> {
  await app.evaluate(() => {
    const bag = globalThis as unknown as { __capturedPortalUrls?: string[] }
    bag.__capturedPortalUrls = []
  })
}

async function readResumeStorage(): Promise<
  Record<
    string,
    {
      courseId: string
      chapterId: string
      sectionNumber: string | null
      sectionTitle: string | null
      updatedAt: string
    }
  >
> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) : {}
  }, RESUME_STORAGE_KEY)
}

async function closePortalOverlay(): Promise<void> {
  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await expect(page.locator('.studio-course-shell')).toBeVisible()
}

function seedWorkflowFixture(): void {
  const db = new DatabaseSync(dbPath)
  const nowIso = new Date().toISOString()

  try {
    db.exec('BEGIN')

    const insertCourse = db.prepare(`
      INSERT OR REPLACE INTO courses (
        id, external_id, name, code, teacher, semester, category, color,
        favorite, clazz_id, class_name, schedule_json, semester_start, max_week,
        source, source_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, 16, 'chaoxing', ?, ?, ?)
    `)

    // 1. Active course with 3 chapters (ch1 done, ch2 unfinished with sections, ch3 unfinished)
    insertCourse.run(
      'cw-course-active',
      'cw:101',
      '编译原理实战',
      'COMP301',
      '陈老师',
      '2026年秋',
      '专业课',
      '#2558d9',
      1,
      '5001',
      '计科1班',
      'https://mooc1.chaoxing.com/course/5001',
      nowIso,
      nowIso
    )

    // 2. Fully completed course (all points done, zero pending tasks)
    insertCourse.run(
      'cw-course-done',
      'cw:102',
      '已结课通识',
      'GEN101',
      '周老师',
      '2026年秋',
      '通识',
      '#157a52',
      0,
      '5002',
      '通识2班',
      null,
      nowIso,
      nowIso
    )

    // 3. Course with chapters + outline-only zero-task sections (completed: false, pendingCount: 0)
    insertCourse.run(
      'cw-course-notasks',
      'cw:103',
      '无任务点研讨课',
      'SEM101',
      '李老师',
      '2026年秋',
      '研讨',
      '#0369a1',
      0,
      '5003',
      null,
      null,
      nowIso,
      nowIso
    )

    // 4. Course with completed chapter + locked chapter with pending tasks (MUST NOT be all_done!)
    insertCourse.run(
      'cw-course-locked',
      'cw:104',
      '混合锁定课程',
      'NET201',
      '王老师',
      '2026年秋',
      '专业课',
      '#7c3aed',
      0,
      '5005',
      '网工1班',
      'https://mooc1.chaoxing.com/course/5005',
      nowIso,
      nowIso
    )

    // 5. Course where unfinished section lacks allowlisted URL -> explicit chapter-level fallback
    insertCourse.run(
      'cw-course-fallback',
      'cw:105',
      '章节降级课程',
      'SYS202',
      '赵老师',
      '2026年秋',
      '专业课',
      '#0f766e',
      0,
      '5006',
      '软工1班',
      'https://mooc1.chaoxing.com/course/5006',
      nowIso,
      nowIso
    )

    // 6. Course where unfinished section AND chapter both lack allowlisted URL -> explicit course-level fallback
    insertCourse.run(
      'cw-course-course-fallback',
      'cw:106',
      '课程降级课程',
      'SYS203',
      '孙老师',
      '2026年秋',
      '专业课',
      '#b45309',
      0,
      '5007',
      '软工2班',
      'https://mooc1.chaoxing.com/course/5007',
      nowIso,
      nowIso
    )

    // 7. Real synced structure: Ch1 (done + locked todo) -> Ch2 (pendingCount=0 + associated todo + URL) -> Ch3 (outline unknown)
    insertCourse.run(
      'cw-course-sync-mixed',
      '24001:55001',
      '高等代数同步课',
      'MATH201',
      '林老师',
      '2026年秋',
      '专业课',
      '#0284c7',
      0,
      '55001',
      '数应1班',
      'https://mooc1.chaoxing.com/course/24001',
      nowIso,
      nowIso
    )

    // 8. Real synced structure: completed + unknown outline + locked (done + locked todo) coexisting
    insertCourse.run(
      'cw-course-sync-locked-coexist',
      '24002:55002',
      '三态共存锁定课',
      'MATH202',
      '吴老师',
      '2026年秋',
      '专业课',
      '#6d28d9',
      0,
      '55002',
      '数应2班',
      'https://mooc1.chaoxing.com/course/24002',
      nowIso,
      nowIso
    )

    const insertChapter = db.prepare(`
      INSERT OR REPLACE INTO course_chapters (
        id, course_id, external_id, title, sort_order, progress,
        last_studied_at, source_url, sections_json, source, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, 'chaoxing', ?, ?)
    `)

    const insertSyncedChapter = db.prepare(`
      INSERT OR REPLACE INTO course_chapters (
        id, course_id, external_id, title, sort_order, progress,
        last_studied_at, source_url, sections_json, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'chaoxing', ?, ?)
    `)

    insertChapter.run(
      'cw-ch-1',
      'cw-course-active',
      '词法分析基础',
      0,
      100,
      'https://mooc1.chaoxing.com/chapter/1',
      JSON.stringify([
        {
          number: '1.1',
          title: '正则与有限自动机',
          completed: true,
          pendingCount: 0,
          locked: false,
          sourceUrl: 'https://mooc1.chaoxing.com/sec/1-1',
          resources: []
        }
      ]),
      nowIso,
      nowIso
    )

    insertChapter.run(
      'cw-ch-2',
      'cw-course-active',
      '语法分析与 LL(1)',
      1,
      50,
      'https://mooc1.chaoxing.com/chapter/2',
      JSON.stringify([
        {
          number: '2.1',
          title: '上下文无关文法',
          completed: true,
          pendingCount: 0,
          locked: false,
          sourceUrl: 'https://mooc1.chaoxing.com/sec/2-1',
          resources: []
        },
        {
          number: '2.2',
          title: '预测分析表构造',
          completed: false,
          pendingCount: 2,
          locked: false,
          sourceUrl: 'https://mooc1.chaoxing.com/sec/2-2',
          resources: []
        },
        {
          number: '2.3',
          title: '未解锁进阶节',
          completed: false,
          pendingCount: 1,
          locked: true,
          sourceUrl: 'https://mooc1.chaoxing.com/sec/2-3',
          resources: []
        },
        {
          number: '2.4',
          title: '非白名单外链节',
          completed: false,
          pendingCount: 0,
          locked: false,
          sourceUrl: 'https://evil.example/sec',
          resources: []
        }
      ]),
      nowIso,
      nowIso
    )

    insertChapter.run(
      'cw-ch-3',
      'cw-course-active',
      '语义分析与中间代码',
      2,
      0,
      'https://mooc1.chaoxing.com/chapter/3',
      JSON.stringify([]),
      nowIso,
      nowIso
    )

    insertChapter.run(
      'cw-done-ch-1',
      'cw-course-done',
      '结课总结',
      0,
      100,
      null,
      '[]',
      nowIso,
      nowIso
    )

    // Zero-task outline chapter with unlocked section having completed: false, pendingCount: 0
    insertChapter.run(
      'cw-notasks-ch-1',
      'cw-course-notasks',
      '研讨提纲',
      0,
      0,
      null,
      JSON.stringify([
        {
          number: '1.1',
          title: '课程导学目录',
          completed: false,
          pendingCount: 0,
          locked: false,
          sourceUrl: 'https://mooc1.chaoxing.com/sec/notasks-1-1',
          resources: []
        }
      ]),
      nowIso,
      nowIso
    )

    // Mixed locked course: ch1 completed + ch2 locked with pendingCount: 3
    insertChapter.run(
      'cw-locked-ch-1',
      'cw-course-locked',
      '基础概念',
      0,
      100,
      'https://mooc1.chaoxing.com/chapter/locked-1',
      '[]',
      nowIso,
      nowIso
    )
    insertChapter.run(
      'cw-locked-ch-2',
      'cw-course-locked',
      '待开放实验章',
      1,
      0,
      null,
      JSON.stringify([
        {
          number: '2.1',
          title: '锁定实验小节',
          completed: false,
          pendingCount: 3,
          locked: true,
          sourceUrl: 'https://mooc1.chaoxing.com/sec/locked-2-1',
          resources: []
        }
      ]),
      nowIso,
      nowIso
    )

    // Fallback course 1: unfinished section 1.2 has non-allowlisted URL, chapter URL is valid
    insertChapter.run(
      'cw-fb-ch-1',
      'cw-course-fallback',
      '降级第一章',
      0,
      50,
      'https://mooc1.chaoxing.com/chapter/fb-1',
      JSON.stringify([
        {
          number: '1.1',
          title: '已完成小节',
          completed: true,
          pendingCount: 0,
          locked: false,
          sourceUrl: 'https://mooc1.chaoxing.com/sec/fb-1-1',
          resources: []
        },
        {
          number: '1.2',
          title: '无白名单直达未完成节',
          completed: false,
          pendingCount: 2,
          locked: false,
          sourceUrl: 'https://evil.example/blocked',
          resources: []
        },
        {
          number: '1.3',
          title: '锁定小节',
          completed: false,
          pendingCount: 1,
          locked: true,
          sourceUrl: 'https://mooc1.chaoxing.com/sec/fb-1-3',
          resources: []
        }
      ]),
      nowIso,
      nowIso
    )

    // Fallback course 2: unfinished section has non-allowlisted URL AND chapter URL is null -> course fallback
    insertChapter.run(
      'cw-cfb-ch-1',
      'cw-course-course-fallback',
      '无章链接章节',
      0,
      0,
      null,
      JSON.stringify([
        {
          number: '1.1',
          title: '缺少直达地址未完成节',
          completed: false,
          pendingCount: 1,
          locked: false,
          sourceUrl: null,
          resources: []
        }
      ]),
      nowIso,
      nowIso
    )

    const insertPoint = db.prepare(`
      INSERT OR REPLACE INTO study_points (
        id, chapter_id, course_id, external_id, title, kind, status,
        duration_minutes, sort_order, source, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, 'video', ?, ?, ?, 'chaoxing', ?, ?)
    `)

    insertPoint.run(
      'cw-pt-1',
      'cw-ch-1',
      'cw-course-active',
      'DFA 讲解',
      'done',
      20,
      0,
      nowIso,
      nowIso
    )
    insertPoint.run(
      'cw-pt-2',
      'cw-ch-2',
      'cw-course-active',
      '文法推导',
      'done',
      15,
      0,
      nowIso,
      nowIso
    )
    insertPoint.run(
      'cw-pt-3',
      'cw-ch-2',
      'cw-course-active',
      'LL(1) 构造',
      'todo',
      25,
      1,
      nowIso,
      nowIso
    )
    insertPoint.run(
      'cw-pt-4',
      'cw-ch-3',
      'cw-course-active',
      '三地址码',
      'todo',
      30,
      0,
      nowIso,
      nowIso
    )
    insertPoint.run(
      'cw-pt-done',
      'cw-done-ch-1',
      'cw-course-done',
      '结课视频',
      'done',
      10,
      0,
      nowIso,
      nowIso
    )
    insertPoint.run(
      'cw-pt-locked-done',
      'cw-locked-ch-1',
      'cw-course-locked',
      '前置导学',
      'done',
      12,
      0,
      nowIso,
      nowIso
    )

    // Chapters & points for cw-course-sync-mixed (real Chaoxing external_id structure)
    insertSyncedChapter.run(
      'cw-sync-ch-1',
      'cw-course-sync-mixed',
      '24001:55001:ch:1',
      '多项式基础',
      0,
      50,
      'https://mooc1.chaoxing.com/chapter/sync-1',
      JSON.stringify([
        {
          number: '1.1',
          title: '整除概念',
          completed: true,
          pendingCount: 0,
          locked: false,
          chapterId: '90011',
          sourceUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=90011',
          resources: []
        },
        {
          number: '1.2',
          title: '锁定测验节',
          completed: false,
          pendingCount: 0,
          locked: true,
          chapterId: '90012',
          sourceUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=90012',
          resources: []
        }
      ]),
      nowIso,
      nowIso
    )
    insertSyncedChapter.run(
      'cw-sync-ch-2',
      'cw-course-sync-mixed',
      '24001:55001:ch:2',
      '行列式计算',
      1,
      0,
      'https://mooc1.chaoxing.com/chapter/sync-2',
      JSON.stringify([
        {
          number: '2.1',
          title: '二阶与三阶行列式',
          completed: false,
          pendingCount: 0,
          locked: false,
          chapterId: '90021',
          sourceUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=90021',
          resources: []
        }
      ]),
      nowIso,
      nowIso
    )
    insertSyncedChapter.run(
      'cw-sync-ch-3',
      'cw-course-sync-mixed',
      '24001:55001:ch:3',
      '参考讲义目录',
      2,
      0,
      'https://mooc1.chaoxing.com/chapter/sync-3',
      JSON.stringify([
        {
          number: '3.1',
          title: '拓展书单',
          completed: false,
          pendingCount: 0,
          locked: false,
          chapterId: '90031',
          sourceUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=90031',
          resources: []
        }
      ]),
      nowIso,
      nowIso
    )

    // Chapters for cw-course-sync-locked-coexist (completed + unknown + locked with done & locked todo)
    insertSyncedChapter.run(
      'cw-coexist-ch-1',
      'cw-course-sync-locked-coexist',
      '24002:55002:ch:1',
      '已完成章',
      0,
      100,
      'https://mooc1.chaoxing.com/chapter/coexist-1',
      JSON.stringify([
        {
          number: '1.1',
          title: '导论',
          completed: true,
          pendingCount: 0,
          locked: false,
          chapterId: '91011',
          sourceUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=91011',
          resources: []
        }
      ]),
      nowIso,
      nowIso
    )
    insertSyncedChapter.run(
      'cw-coexist-ch-2',
      'cw-course-sync-locked-coexist',
      '24002:55002:ch:2',
      '未知目录章',
      1,
      0,
      null,
      JSON.stringify([
        {
          number: '2.1',
          title: '阅读提纲',
          completed: false,
          pendingCount: 0,
          locked: false,
          chapterId: '91021',
          sourceUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=91021',
          resources: []
        }
      ]),
      nowIso,
      nowIso
    )
    insertSyncedChapter.run(
      'cw-coexist-ch-3',
      'cw-course-sync-locked-coexist',
      '24002:55002:ch:3',
      '锁定进阶章',
      2,
      50,
      'https://mooc1.chaoxing.com/chapter/coexist-3',
      JSON.stringify([
        {
          number: '3.1',
          title: '已学小节',
          completed: true,
          pendingCount: 0,
          locked: false,
          chapterId: '91031',
          sourceUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=91031',
          resources: []
        },
        {
          number: '3.2',
          title: '未解锁考核',
          completed: false,
          pendingCount: 0,
          locked: true,
          chapterId: '91032',
          sourceUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=91032',
          resources: []
        }
      ]),
      nowIso,
      nowIso
    )

    const insertSyncedPoint = db.prepare(`
      INSERT OR REPLACE INTO study_points (
        id, chapter_id, course_id, external_id, title, kind, status,
        duration_minutes, sort_order, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'video', ?, ?, ?, 'chaoxing', ?, ?)
    `)

    insertSyncedPoint.run(
      'cw-sync-pt-1',
      'cw-sync-ch-1',
      'cw-course-sync-mixed',
      '24001:55001:sec:1.1',
      '整除概念',
      'done',
      10,
      0,
      nowIso,
      nowIso
    )
    insertSyncedPoint.run(
      'cw-sync-pt-2',
      'cw-sync-ch-1',
      'cw-course-sync-mixed',
      '24001:55001:sec:1.2',
      '锁定测验节',
      'todo',
      25,
      1,
      nowIso,
      nowIso
    )
    insertSyncedPoint.run(
      'cw-sync-pt-3',
      'cw-sync-ch-2',
      'cw-course-sync-mixed',
      '24001:55001:sec:2.1',
      '二阶与三阶行列式',
      'todo',
      20,
      0,
      nowIso,
      nowIso
    )

    insertSyncedPoint.run(
      'cw-coexist-pt-1',
      'cw-coexist-ch-1',
      'cw-course-sync-locked-coexist',
      '24002:55002:sec:1.1',
      '导论',
      'done',
      10,
      0,
      nowIso,
      nowIso
    )
    insertSyncedPoint.run(
      'cw-coexist-pt-2',
      'cw-coexist-ch-3',
      'cw-course-sync-locked-coexist',
      '24002:55002:sec:3.1',
      '已学小节',
      'done',
      15,
      0,
      nowIso,
      nowIso
    )
    insertSyncedPoint.run(
      'cw-coexist-pt-3',
      'cw-coexist-ch-3',
      'cw-course-sync-locked-coexist',
      '24002:55002:sec:3.2',
      '未解锁考核',
      'todo',
      30,
      1,
      nowIso,
      nowIso
    )

    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

test.beforeAll(async () => {
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
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })
  dbPath = join(DATA_DIR, 'workspaces', 'local.sqlite')
  await waitForFile(dbPath)
  seedWorkflowFixture()
  await installPortalUrlSpy()
  await page.reload()
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('N-005 / N-005-R：学习目的地一致性（Portal URL 与持久化记录一致）与工作流恢复', async () => {
  await clearCapturedPortalUrls()
  await page.evaluate((key) => window.localStorage.removeItem(key), RESUME_STORAGE_KEY)
  await page.reload()
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })

  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await expect(page.locator('.studio-course-shell')).toBeVisible()

  // Select active course
  await page.locator('.course-rail-item[data-course-id="cw-course-active"]').click()
  await expect(page.locator('.course-hero-title')).toHaveText('编译原理实战')

  // 1. Resume banner points to ch2 + exact unfinished allowlisted section 2.2
  const resumeBanner = page.locator('.course-resume-banner')
  await expect(resumeBanner).toBeVisible()
  await expect(resumeBanner).toContainText('下一未完成')
  await expect(resumeBanner).toContainText('语法分析与 LL(1)')
  await expect(resumeBanner).toContainText('2.2 预测分析表构造')
  await expect(resumeBanner).toContainText('剩余 2 个任务点')
  await expect(resumeBanner).toContainText('55 分钟')

  // Clicking "去学习通继续" passes exact allowlisted section URL to Portal AND persists matching section record
  await resumeBanner.getByRole('button', { name: /去学习通继续/ }).click()
  await expect.poll(getCapturedPortalUrls).toEqual(['https://mooc1.chaoxing.com/sec/2-2'])
  const storageAfterResume = await readResumeStorage()
  expect(storageAfterResume['cw-course-active']).toMatchObject({
    courseId: 'cw-course-active',
    chapterId: 'cw-ch-2',
    sectionNumber: '2.2',
    sectionTitle: '预测分析表构造'
  })
  await closePortalOverlay()

  // Clicking "定位章节" expands & highlights ch2; section buttons appear ONLY on unlocked allowlisted sections (2.1, 2.2)
  await resumeBanner.getByRole('button', { name: /定位章节/ }).click()
  const ch2Card = page.locator('.chapter-card[data-chapter-id="cw-ch-2"]')
  await expect(ch2Card).toHaveClass(/focused/)
  await expect(ch2Card.locator('.chapter-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(ch2Card.locator('.studio-section-open')).toHaveCount(2)

  // Clicking section 2.1's button opens exact sec/2-1 URL and records section 2.1
  await clearCapturedPortalUrls()
  await ch2Card.locator('.studio-section-open').first().click()
  await expect.poll(getCapturedPortalUrls).toEqual(['https://mooc1.chaoxing.com/sec/2-1'])
  const storageAfterSection = await readResumeStorage()
  expect(storageAfterSection['cw-course-active']).toMatchObject({
    courseId: 'cw-course-active',
    chapterId: 'cw-ch-2',
    sectionNumber: '2.1',
    sectionTitle: '上下文无关文法'
  })
  await closePortalOverlay()

  // 2. Chapter status filter "未完成 2" hides completed ch1 and keeps ch2 & ch3
  await page.getByRole('button', { name: '未完成 2' }).click()
  await expect(page.locator('.chapter-card')).toHaveCount(2)
  await expect(page.locator('.chapter-card[data-chapter-id="cw-ch-1"]')).toHaveCount(0)
  await page.getByRole('button', { name: '全部', exact: true }).click()
  await expect(page.locator('.chapter-card')).toHaveCount(3)

  // 3. Expanding ch3 records chapter-level resume -> banner switches to ch3; switching to done course shows rail quick-resume
  await page.locator('.chapter-card[data-chapter-id="cw-ch-3"] .chapter-toggle').click()
  await expect(resumeBanner).toContainText('继续上次学习')
  await expect(resumeBanner).toContainText('语义分析与中间代码')

  await page.locator('.course-rail-item[data-course-id="cw-course-done"]').click()
  await expect(page.locator('.course-hero-title')).toHaveText('已结课通识')
  await expect(page.locator('.course-resume-banner')).toContainText('已同步章节完成')

  const railResumeBtn = page.locator('.course-rail-resume')
  await expect(railResumeBtn).toBeVisible()
  await expect(railResumeBtn).toContainText('编译原理实战')
  await railResumeBtn.click()
  await expect(page.locator('.course-hero-title')).toHaveText('编译原理实战')
  await expect(page.locator('.chapter-card[data-chapter-id="cw-ch-3"]')).toHaveClass(/focused/)

  // 4. Explicit chapter-level fallback when unfinished section lacks allowlisted URL
  await clearCapturedPortalUrls()
  await page.locator('.course-rail-item[data-course-id="cw-course-fallback"]').click()
  await expect(page.locator('.course-hero-title')).toHaveText('章节降级课程')
  await expect(resumeBanner).toContainText('降级第一章')
  // Must NOT claim section 1.2 (blocked) or 1.1 (completed) or 1.3 (locked)
  await expect(resumeBanner).not.toContainText('1.2')
  await expect(resumeBanner).not.toContainText('1.1')
  await expect(resumeBanner).not.toContainText('1.3')
  await resumeBanner.getByRole('button', { name: /去学习通继续/ }).click()
  await expect.poll(getCapturedPortalUrls).toEqual(['https://mooc1.chaoxing.com/chapter/fb-1'])
  const storageAfterChapterFallback = await readResumeStorage()
  expect(storageAfterChapterFallback['cw-course-fallback']).toMatchObject({
    courseId: 'cw-course-fallback',
    chapterId: 'cw-fb-ch-1',
    sectionNumber: null,
    sectionTitle: null
  })
  await closePortalOverlay()

  // 5. Explicit course-level fallback when both unfinished section and chapter lack allowlisted URL
  await clearCapturedPortalUrls()
  await page.locator('.course-rail-item[data-course-id="cw-course-course-fallback"]').click()
  await expect(page.locator('.course-hero-title')).toHaveText('课程降级课程')
  await expect(resumeBanner).toContainText('当前章节暂无直达链接，将打开所属课程页')
  await expect(resumeBanner).not.toContainText('1.1')
  await resumeBanner.getByRole('button', { name: /打开课程页继续/ }).click()
  await expect.poll(getCapturedPortalUrls).toEqual(['https://mooc1.chaoxing.com/course/5007'])
  const storageAfterCourseFallback = await readResumeStorage()
  expect(storageAfterCourseFallback['cw-course-course-fallback']).toMatchObject({
    courseId: 'cw-course-course-fallback',
    chapterId: 'cw-cfb-ch-1',
    sectionNumber: null,
    sectionTitle: null
  })
  await closePortalOverlay()
})

test('N-005-R：零任务点目录小节、锁定待完成章节与过期学习记录校验', async () => {
  await clearCapturedPortalUrls()
  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await expect(page.locator('.studio-course-shell')).toBeVisible()

  // 1. Zero-task outline section (completed: false, pendingCount: 0) is NOT incomplete and NOT all_done
  await page.locator('.course-rail-item[data-course-id="cw-course-notasks"]').click()
  await expect(page.locator('.course-progress-summary')).toContainText('暂无任务点')
  await expect(page.locator('.chapter-card').first()).toContainText('无任务点')
  await expect(page.locator('.course-resume-banner')).toContainText('章节目录')
  await expect(page.locator('.course-resume-banner')).not.toContainText('已同步章节完成')
  await expect(page.locator('.course-resume-banner')).not.toContainText('下一未完成')
  await page.getByRole('button', { name: '未完成 0' }).click()
  await expect(page.locator('.course-chapters-pane')).toContainText('当前没有已识别的未完成章节')
  await expect(page.locator('.course-chapters-pane')).not.toContainText(
    '已同步的章节学习任务都已完成'
  )
  await page.getByRole('button', { name: '全部', exact: true }).click()

  // 待处理 filter excludes zero-task outline course & completed course, keeps active course
  const attentionBtn = page.locator('.course-rail-filters').getByRole('button', { name: '待处理' })
  await attentionBtn.click()
  await expect(page.locator('.course-rail-item[data-course-id="cw-course-notasks"]')).toHaveCount(0)
  await expect(page.locator('.course-rail-item[data-course-id="cw-course-done"]')).toHaveCount(0)
  await expect(page.locator('.course-rail-item[data-course-id="cw-course-active"]')).toHaveCount(1)
  await attentionBtn.click()

  // 2. Completed chapter + locked chapter with pending tasks -> locked_only (NEVER all_done, NEVER opens locked section!)
  await page.locator('.course-rail-item[data-course-id="cw-course-locked"]').click()
  const lockedBanner = page.locator('.course-resume-banner')
  await expect(lockedBanner).toContainText('章节未解锁')
  await expect(lockedBanner).toContainText('仍有 1 章未解锁（含 3 项待开放任务）')
  await expect(lockedBanner).not.toContainText('已同步章节完成')
  await expect(lockedBanner).not.toContainText('锁定实验小节')

  // Clicking banner button degrades to course URL, never locked section URL
  await lockedBanner.getByRole('button', { name: /进入课程页查看/ }).click()
  await expect.poll(getCapturedPortalUrls).toEqual(['https://mooc1.chaoxing.com/course/5005'])
  const storageAfterLocked = await readResumeStorage()
  expect(storageAfterLocked['cw-course-locked']).toMatchObject({
    courseId: 'cw-course-locked',
    chapterId: 'cw-locked-ch-2',
    sectionNumber: null,
    sectionTitle: null
  })
  await closePortalOverlay()

  // "未完成 0" empty state honestly reports locked chapters rather than claiming all done
  await page.locator('.course-rail-item[data-course-id="cw-course-locked"]').click()
  await page.getByRole('button', { name: '未完成 0' }).click()
  await expect(page.locator('.course-chapters-pane')).toContainText('当前没有可继续的未完成章节')
  await expect(page.locator('.course-chapters-pane')).toContainText('未解锁章节')
  await expect(page.locator('.course-chapters-pane')).not.toContainText(
    '已同步的章节学习任务都已完成'
  )

  // 3. Stale resume records: newest deleted chapter & wrong-course chapter are skipped for next valid record
  await page.evaluate((key) => {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        'cw-course-fallback': {
          courseId: 'cw-course-fallback',
          chapterId: 'cw-chapter-deleted',
          sectionNumber: '1.1',
          sectionTitle: '不存在的章节',
          updatedAt: '2026-11-24T18:00:00.000Z'
        },
        'cw-course-locked': {
          courseId: 'cw-course-locked',
          chapterId: 'cw-ch-2', // belongs to cw-course-active, NOT cw-course-locked!
          sectionNumber: null,
          sectionTitle: null,
          updatedAt: '2026-11-24T17:30:00.000Z'
        },
        'cw-course-active': {
          courseId: 'cw-course-active',
          chapterId: 'cw-ch-3',
          sectionNumber: null,
          sectionTitle: null,
          updatedAt: '2026-11-24T17:00:00.000Z'
        }
      })
    )
  }, RESUME_STORAGE_KEY)
  await page.reload()
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })
  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await page.locator('.course-rail-item[data-course-id="cw-course-done"]').click()
  await expect(page.locator('.course-rail-resume')).toBeVisible()
  await expect(page.locator('.course-rail-resume')).toContainText('编译原理实战')

  // 4. All records stale -> rail quick-resume entry is completely hidden
  await page.evaluate((key) => {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        'cw-course-active': {
          courseId: 'cw-course-active',
          chapterId: 'cw-chapter-deleted',
          sectionNumber: null,
          sectionTitle: null,
          updatedAt: '2026-11-24T18:30:00.000Z'
        },
        'cw-course-done': {
          courseId: 'cw-course-done',
          chapterId: 'cw-ch-2',
          sectionNumber: null,
          sectionTitle: null,
          updatedAt: '2026-11-24T18:20:00.000Z'
        }
      })
    )
  }, RESUME_STORAGE_KEY)
  await page.reload()
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })
  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await page.locator('.course-rail-item[data-course-id="cw-course-done"]').click()
  await expect(page.locator('.course-rail-resume')).toHaveCount(0)
})

test('N-005-R2：锁定学习点排除、后续可学习章优先与 pendingCount=0 关联待办小节直达', async () => {
  await clearCapturedPortalUrls()
  await page.evaluate((key) => window.localStorage.removeItem(key), RESUME_STORAGE_KEY)
  await page.reload()
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })

  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await expect(page.locator('.studio-course-shell')).toBeVisible()

  // 1. Course with Ch1 (done + locked todo), Ch2 (pendingCount=0 + associated todo + URL), Ch3 (outline unknown)
  await page.locator('.course-rail-item[data-course-id="cw-course-sync-mixed"]').click()
  await expect(page.locator('.course-hero-title')).toHaveText('高等代数同步课')

  // getCourseProgress() preserves real progress including locked todo (1 / 3 = 33%)
  await expect(page.locator('.course-progress-summary')).toContainText('33%')
  await expect(page.locator('.course-progress-summary')).toContainText('已完成 1 / 3 个任务点')

  // Resume banner skips locked Ch1 and directly targets Ch2 + Section 2.1 (even though pendingCount === 0!)
  const banner = page.locator('.course-resume-banner')
  await expect(banner).toContainText('下一未完成')
  await expect(banner).toContainText('行列式计算')
  await expect(banner).toContainText('2.1 二阶与三阶行列式')
  await expect(banner).toContainText('剩余 1 个任务点')
  await expect(banner).toContainText('20 分钟')
  await expect(banner).toContainText('另有 1 章未解锁')

  // "未完成 1" filter shows ONLY playable Ch2 (hides locked Ch1 and outline Ch3)
  await page.getByRole('button', { name: '未完成 1' }).click()
  await expect(page.locator('.chapter-card')).toHaveCount(1)
  await expect(page.locator('.chapter-card[data-chapter-id="cw-sync-ch-2"]')).toHaveCount(1)
  await expect(page.locator('.chapter-card[data-chapter-id="cw-sync-ch-1"]')).toHaveCount(0)
  await expect(page.locator('.chapter-card[data-chapter-id="cw-sync-ch-3"]')).toHaveCount(0)

  // Clicking "去学习通继续" opens exact Section 2.1 URL and persists matching section record
  await banner.getByRole('button', { name: /去学习通继续/ }).click()
  await expect
    .poll(getCapturedPortalUrls)
    .toEqual(['https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=90021'])
  const storageAfterSyncResume = await readResumeStorage()
  expect(storageAfterSyncResume['cw-course-sync-mixed']).toMatchObject({
    courseId: 'cw-course-sync-mixed',
    chapterId: 'cw-sync-ch-2',
    sectionNumber: '2.1',
    sectionTitle: '二阶与三阶行列式'
  })
  await closePortalOverlay()

  // Chapter card "去学习" on Ch2 also uses the unified destination -> exact Section 2.1 URL
  await clearCapturedPortalUrls()
  await page.locator('.chapter-card[data-chapter-id="cw-sync-ch-2"] .chapter-open').click()
  await expect
    .poll(getCapturedPortalUrls)
    .toEqual(['https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=90021'])
  await closePortalOverlay()

  // 2. Course with completed + unknown outline + locked (done + locked todo) coexisting
  await page.locator('.course-rail-item[data-course-id="cw-course-sync-locked-coexist"]').click()
  await expect(page.locator('.course-hero-title')).toHaveText('三态共存锁定课')

  // Real progress preserved (2 / 3 = 67%), never fabricated as 100%
  await expect(page.locator('.course-progress-summary')).toContainText('67%')
  await expect(page.locator('.course-progress-summary')).toContainText('已完成 2 / 3 个任务点')

  // Banner reports locked_only (NEVER all_done, NEVER next_unfinished, NEVER locked section 3.2)
  await expect(banner).toContainText('章节未解锁')
  await expect(banner).toContainText('仍有 1 章未解锁（含 1 项待开放任务）')
  await expect(banner).not.toContainText('已同步章节完成')
  await expect(banner).not.toContainText('未解锁考核')

  // Clicking banner button degrades to chapter URL (never locked section 3.2) and records sectionNumber: null
  await clearCapturedPortalUrls()
  await banner.getByRole('button', { name: /去学习通查看/ }).click()
  await expect.poll(getCapturedPortalUrls).toEqual(['https://mooc1.chaoxing.com/chapter/coexist-3'])
  const storageAfterCoexist = await readResumeStorage()
  expect(storageAfterCoexist['cw-course-sync-locked-coexist']).toMatchObject({
    courseId: 'cw-course-sync-locked-coexist',
    chapterId: 'cw-coexist-ch-3',
    sectionNumber: null,
    sectionTitle: null
  })
  await closePortalOverlay()

  // "未完成 0" empty state honestly notes locked chapters remain
  await page.locator('.course-rail-item[data-course-id="cw-course-sync-locked-coexist"]').click()
  await page.getByRole('button', { name: '未完成 0' }).click()
  await expect(page.locator('.course-chapters-pane')).toContainText('当前没有可继续的未完成章节')
  await expect(page.locator('.course-chapters-pane')).toContainText('未解锁章节')

  // Left rail "待处理" filter keeps playable synced course and excludes locked-only coexist course
  const attentionBtn = page.locator('.course-rail-filters').getByRole('button', { name: '待处理' })
  await attentionBtn.click()
  await expect(
    page.locator('.course-rail-item[data-course-id="cw-course-sync-mixed"]')
  ).toHaveCount(1)
  await expect(
    page.locator('.course-rail-item[data-course-id="cw-course-sync-locked-coexist"]')
  ).toHaveCount(0)
})
