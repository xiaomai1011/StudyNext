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
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-n007-tasks-'))
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

async function openTasksList(): Promise<void> {
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: /作业/ })
    .click()
  await expect(page.getByRole('heading', { name: '作业', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '作业清单' }).click()
  await page
    .getByRole('group', { name: '按状态筛选' })
    .getByRole('button', { name: /^全部/ })
    .click()
}

function isoOffsetHours(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString()
}

function isoTodayAhead(): string {
  const now = new Date()
  const target = new Date(now)
  if (now.getHours() < 22) {
    target.setHours(now.getHours() + 1, 30, 0, 0)
  } else {
    target.setHours(23, 55, 0, 0)
  }
  if (target.getTime() <= now.getTime() + 60_000) {
    target.setTime(now.getTime() + 300_000)
  }
  return target.toISOString()
}

function seedWorkflowData(courseIds: string[]): void {
  const db = new DatabaseSync(DB_PATH)
  try {
    const c1 = courseIds[0]!
    const c2 = courseIds[1] ?? c1
    db.prepare('DELETE FROM tasks').run()

    const insert = db.prepare(
      `INSERT INTO tasks (
        id, course_id, title, description, kind, due_at, priority, status,
        completed_at, completion_source, source, external_id, source_url,
        platform_status, platform_status_kind, submitted_at, score, full_score,
        teacher_feedback, attachments_json, manual_fields_json,
        field_sources_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'homework', ?, ?, ?, ?, ?, 'chaoxing', ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '{}', ?, ?)`
    )

    const nowIso = new Date().toISOString()
    const rows = [
      {
        id: 'n7-overdue',
        courseId: c1,
        title: 'N7 逾期未交实验',
        description: '需要尽快补交',
        dueAt: isoOffsetHours(-30),
        priority: 'high',
        status: 'todo',
        completedAt: null,
        completionSource: null,
        externalId: 'n7:overdue',
        sourceUrl: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?workId=701',
        platformStatus: '未交',
        platformStatusKind: 'not_submitted',
        submittedAt: null,
        score: null,
        fullScore: '100',
        feedback: null,
        updatedAt: isoOffsetHours(-10)
      },
      {
        id: 'n7-today',
        courseId: c1,
        title: 'N7 今晚截止作业',
        description: '按时提交',
        dueAt: isoTodayAhead(),
        priority: 'high',
        status: 'todo',
        completedAt: null,
        completionSource: null,
        externalId: 'n7:today',
        sourceUrl: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?workId=702',
        platformStatus: '未交',
        platformStatusKind: 'not_submitted',
        submittedAt: null,
        score: null,
        fullScore: '100',
        feedback: null,
        updatedAt: isoOffsetHours(-8)
      },
      {
        id: 'n7-soon',
        courseId: c2,
        title: 'N7 两天内截止作业',
        description: '',
        dueAt: isoOffsetHours(36),
        priority: 'medium',
        status: 'todo',
        completedAt: null,
        completionSource: null,
        externalId: 'n7:soon',
        sourceUrl: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?workId=703',
        platformStatus: '未交',
        platformStatusKind: 'not_submitted',
        submittedAt: null,
        score: null,
        fullScore: '100',
        feedback: null,
        updatedAt: isoOffsetHours(-6)
      },
      {
        id: 'n7-week',
        courseId: c2,
        title: 'N7 五天后截止作业',
        description: '',
        dueAt: isoOffsetHours(120),
        priority: 'low',
        status: 'todo',
        completedAt: null,
        completionSource: null,
        externalId: 'n7:week',
        sourceUrl: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?workId=704',
        platformStatus: '未交',
        platformStatusKind: 'not_submitted',
        submittedAt: null,
        score: null,
        fullScore: '100',
        feedback: null,
        updatedAt: isoOffsetHours(-5)
      },
      {
        id: 'n7-review-past',
        courseId: c1,
        title: 'N7 待审核但截止已过',
        description: '',
        dueAt: isoOffsetHours(-48),
        priority: 'medium',
        status: 'todo',
        completedAt: null,
        completionSource: null,
        externalId: 'n7:review',
        sourceUrl: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?workId=705',
        platformStatus: '待批阅',
        platformStatusKind: 'pending_review',
        submittedAt: isoOffsetHours(-50),
        score: null,
        fullScore: '100',
        feedback: null,
        updatedAt: isoOffsetHours(-4)
      },
      {
        id: 'n7-reviewed-zero',
        courseId: c2,
        title: 'N7 已批阅零分带批语',
        description: '',
        dueAt: isoOffsetHours(72),
        priority: 'medium',
        status: 'todo',
        completedAt: null,
        completionSource: null,
        externalId: 'n7:reviewed',
        sourceUrl: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?workId=706',
        platformStatus: '已批阅',
        platformStatusKind: 'reviewed',
        submittedAt: isoOffsetHours(-12),
        score: '0',
        fullScore: '100',
        feedback: '思路清晰，注意补充推导步骤。',
        updatedAt: isoOffsetHours(-2)
      }
    ]

    for (const row of rows) {
      insert.run(
        row.id,
        row.courseId,
        row.title,
        row.description,
        row.dueAt,
        row.priority,
        row.status,
        row.completedAt,
        row.completionSource,
        row.externalId,
        row.sourceUrl,
        row.platformStatus,
        row.platformStatusKind,
        row.submittedAt,
        row.score,
        row.fullScore,
        row.feedback,
        nowIso,
        row.updatedAt
      )
    }
  } finally {
    db.close()
  }
}

test.beforeAll(async () => {
  await launch()
  await waitForFile(DB_PATH)
  const courseIds = await page.evaluate(async () => {
    const api = window.studynext as unknown as {
      bootstrap: () => Promise<{ courses: Array<{ id: string }> }>
    }
    const result = await api.bootstrap()
    return result.courses.map((c) => c.id)
  })
  if (courseIds.length === 0) throw new Error('N-007 E2E 缺少课程数据')
  await app.close()
  seedWorkflowData(courseIds)
  await launch()
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('跨课程 DDL 规划条精确区分可处理逾期与待审核过期，支持一键筛选与重置', async () => {
  await openTasksList()

  const ddlGroup = page.getByRole('group', { name: '按截止时间筛选' })
  const overduePill = ddlGroup.getByRole('button', { name: /已逾期/ })
  const todayPill = ddlGroup.getByRole('button', { name: /今天截止/ })
  const threeDaysPill = ddlGroup.getByRole('button', { name: /3 天内/ })
  const weekPill = ddlGroup.getByRole('button', { name: /7 天内/ })

  // 待审核且截止已过不得计入可处理逾期
  await expect(overduePill).toContainText('1')
  await expect(todayPill).toContainText('1')
  await expect(threeDaysPill).toContainText('2')
  await expect(weekPill).toContainText('3')

  // 点击已逾期直接定位到可处理逾期，排除待审核过期
  await overduePill.click()
  await expect(overduePill).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.task-row')).toHaveCount(1)
  await expect(page.locator('.task-row')).toContainText('N7 逾期未交实验')
  await expect(page.locator('.task-row')).not.toContainText('N7 待审核但截止已过')

  // 点击 3 天内切换到两天内与今天截止的两项
  await threeDaysPill.click()
  await expect(page.locator('.task-row')).toHaveCount(2)
  await expect(page.locator('.task-row').first()).toContainText('N7 今晚截止作业')

  // 一键重置筛选恢复全部 6 条
  await page.getByRole('button', { name: /重置筛选/ }).click()
  await expect(page.locator('.task-row')).toHaveCount(6)
})

test('列表直出零分成绩与教师批语，TaskDetail 主按钮优先应用内作答并区分已提交截止已过', async () => {
  await openTasksList()

  // 行内直接可见零分成绩和教师批语预览
  const reviewedRow = page.locator('.task-row').filter({ hasText: 'N7 已批阅零分带批语' })
  await expect(reviewedRow.locator('.n7-row-score')).toHaveText('0 / 100')
  await expect(reviewedRow.locator('.n7-row-feedback')).toContainText('思路清晰')

  // 下一步优先聚焦今晚截止作业，打开详情后“去作答”为主按钮，“在浏览器打开”为次按钮
  const nextSpotlight = page.locator('.n7-ddl-next')
  await expect(nextSpotlight).toContainText('N7 今晚截止作业')
  await nextSpotlight.locator('.n7-ddl-next-title').click()

  const modal = page.locator('.modal')
  await expect(modal).toBeVisible()
  const answerBtn = modal.getByRole('button', { name: /去作答/ })
  const externalBtn = modal.getByRole('button', { name: /在浏览器打开/ })
  await expect(answerBtn).toHaveClass(/ds-button--primary/)
  await expect(externalBtn).toHaveClass(/ds-button--secondary/)
  await page.locator('.modal-close').click()

  // 待审核且截止已过任务详情页使用中性已处理态，不渲染红色逾期警报
  await page
    .locator('.task-row')
    .filter({ hasText: 'N7 待审核但截止已过' })
    .locator('.b2-task-main')
    .click()
  await expect(modal).toBeVisible()
  await expect(modal.locator('.b2-detail-due')).toHaveClass(/is-settled/)
  await expect(modal.locator('.b2-detail-due')).not.toHaveClass(/is-overdue/)
  await expect(modal.locator('.b2-detail-due')).toContainText('待审核 · 截止已过')
  await page.locator('.modal-close').click()
})

test('从作业清单直达成绩与批语，支持仅看已出分、仅看有批语与按截止时间排序', async () => {
  await page.setViewportSize({ width: 1024, height: 900 })
  await openTasksList()

  await page.getByRole('button', { name: /查看成绩与批语/ }).click()
  await expect(page.locator('.b2-records-table')).toBeVisible()
  await expect(page.locator('.b2-records-table thead th')).toHaveCount(9)

  // 1024px 下页面级零横向溢出
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  )
  expect(pageOverflow).toBeLessThanOrEqual(1)

  // 仅看已出分保留零分 0 / 100
  const gradedBtn = page.getByRole('button', { name: /仅看已出分/ })
  await gradedBtn.click()
  await expect(gradedBtn).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.b2-records-table tbody tr')).toHaveCount(1)
  await expect(
    page.locator('.b2-records-table tbody tr').first().locator('.b2-record-score')
  ).toHaveText('0 / 100')

  // 仅看有批语保留批语项
  const feedbackBtn = page.getByRole('button', { name: /仅看有批语/ })
  await feedbackBtn.click()
  await expect(page.locator('.b2-records-table tbody tr')).toHaveCount(1)
  await expect(page.locator('.b2-records-table tbody tr').first()).toContainText('思路清晰')

  // 关闭快捷筛选后按截止时间排序
  await gradedBtn.click()
  await feedbackBtn.click()
  await expect(page.locator('.b2-records-table tbody tr')).toHaveCount(6)
  await page.getByLabel('作业记录排序').selectOption('due')
  await expect(page.locator('.b2-records-table tbody tr').first()).toContainText(
    'N7 待审核但截止已过'
  )
})
