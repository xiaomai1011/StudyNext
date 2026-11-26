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
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-4e-b2-'))
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

async function openTasks(): Promise<void> {
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

async function openRecords(): Promise<void> {
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: /作业/ })
    .click()
  await expect(page.getByRole('heading', { name: '作业', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '成绩与批语' }).click()
  await expect(page.locator('.b2-records-table')).toBeVisible()
}

interface SeedTask {
  id: string
  title: string
  status: 'todo' | 'done'
  platformStatus: string
  platformStatusKind: string
  dueAt: string
  sourceUrl: string | null
  score?: string | null
  fullScore?: string | null
  feedback?: string | null
  attachments?: Array<{ name: string; size: string; objectId: string }>
  externalId: string
}

function seed(tasks: SeedTask[], courseId: string): void {
  const db = new DatabaseSync(DB_PATH)
  try {
    db.prepare('UPDATE courses SET source_url = NULL WHERE id = ?').run(courseId)
    for (const task of tasks) {
      db.prepare(
        `UPDATE tasks SET
           title = ?,
           course_id = ?,
           status = ?,
           completed_at = ?,
           completion_source = ?,
           source = 'chaoxing',
           external_id = ?,
           source_url = ?,
           platform_status = ?,
           platform_status_kind = ?,
           submitted_at = ?,
           score = ?,
           full_score = ?,
           teacher_feedback = ?,
           kind = 'homework',
           attachments_json = ?,
           manual_fields_json = '[]',
           field_sources_json = '{}',
           updated_at = ?
         WHERE id = ?`
      ).run(
        task.title,
        courseId,
        task.status,
        task.status === 'done' ? '2026-11-17T09:00:00.000Z' : null,
        task.status === 'done' ? 'platform' : null,
        task.externalId,
        task.sourceUrl,
        task.platformStatus,
        task.platformStatusKind,
        task.platformStatusKind === 'not_submitted' ? null : '2026-11-16T09:00:00.000Z',
        task.score ?? null,
        task.fullScore ?? null,
        task.feedback ?? null,
        JSON.stringify(task.attachments ?? []),
        '2026-11-18T09:00:00.000Z',
        task.id
      )
    }
  } finally {
    db.close()
  }
}

test.beforeAll(async () => {
  await launch()
  await waitForFile(DB_PATH)
  const data = await page.evaluate(async () => {
    const api = window.studynext as unknown as {
      bootstrap: () => Promise<{
        courses: Array<{ id: string }>
        tasks: Array<{ id: string; title: string; dueAt: string }>
      }>
    }
    const result = await api.bootstrap()
    return {
      courseId: result.courses[0]?.id ?? '',
      tasks: result.tasks.slice(0, 5)
    }
  })
  if (!data.courseId || data.tasks.length < 5) throw new Error('B2 E2E 演示数据不足')
  await app.close()
  seed(
    [
      {
        id: data.tasks[0]!.id,
        title: 'B2 已批阅零分',
        status: 'todo',
        platformStatus: '已批阅',
        platformStatusKind: 'reviewed',
        dueAt: '2026-12-20T12:00:00.000Z',
        sourceUrl: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?workId=1',
        score: '0',
        fullScore: '100',
        feedback: '完成度良好，继续保持。',
        attachments: [
          {
            name: 'B2 附件模板.docx',
            size: '17,851 字节',
            objectId: 'a'.repeat(32)
          }
        ],
        externalId: 'b2:e2e:reviewed'
      },
      {
        id: data.tasks[1]!.id,
        title: 'B2 已完成独立',
        status: 'done',
        platformStatus: '已完成',
        platformStatusKind: 'done',
        dueAt: '2026-12-18T12:00:00.000Z',
        sourceUrl: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?workId=2',
        score: '95',
        fullScore: '100',
        externalId: 'b2:e2e:done'
      },
      {
        id: data.tasks[2]!.id,
        title: 'B2 待审核且截止已过',
        status: 'todo',
        platformStatus: '待批阅',
        platformStatusKind: 'pending_review',
        dueAt: '2026-11-01T12:00:00.000Z',
        sourceUrl: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?workId=3',
        externalId: 'b2:e2e:pending'
      },
      {
        id: data.tasks[3]!.id,
        title: 'B2 无官方入口的长标题作业用于检查降级说明是否可见',
        status: 'todo',
        platformStatus: '未交',
        platformStatusKind: 'not_submitted',
        dueAt: '2026-12-25T12:00:00.000Z',
        sourceUrl: null,
        externalId: 'b2:e2e:no-source'
      },
      {
        id: data.tasks[4]!.id,
        title: 'B2 已提交样本',
        status: 'todo',
        platformStatus: '已提交',
        platformStatusKind: 'submitted',
        dueAt: '2026-12-22T12:00:00.000Z',
        sourceUrl: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?workId=4',
        externalId: 'b2:e2e:submitted'
      }
    ],
    data.courseId
  )
  await launch()
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('已批阅与已完成分开计数、分组和筛选', async () => {
  await openTasks()
  const tabs = page.getByRole('group', { name: '按状态筛选' })
  const reviewed = tabs.getByRole('button', { name: /^已批阅/ })
  const done = tabs.getByRole('button', { name: /^已完成/ })
  await expect(reviewed).toContainText('1')
  await expect(done).toContainText('1')
  await expect(reviewed).toHaveAttribute('aria-pressed', 'false')

  const reviewedGroup = page
    .locator('.b2-task-group')
    .filter({ has: page.locator('.b2-group-title', { hasText: '已批阅' }) })
  const doneGroup = page
    .locator('.b2-task-group')
    .filter({ has: page.locator('.b2-group-title', { hasText: '已完成' }) })
  await expect(reviewedGroup).toContainText('B2 已批阅零分')
  await expect(reviewedGroup).not.toContainText('B2 已完成独立')
  await expect(doneGroup).toContainText('B2 已完成独立')
  await expect(doneGroup).not.toContainText('B2 已批阅零分')

  await reviewed.click()
  await expect(reviewed).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.task-row')).toHaveCount(1)
  await expect(page.locator('.task-row')).toContainText('B2 已批阅零分')
  await expect(page.locator('.task-row')).not.toContainText('B2 已完成独立')
})

test('逾期不会覆盖平台状态，平台任务不能本地完成或删除', async () => {
  await openTasks()
  const pendingOverdue = page.locator('.task-row').filter({ hasText: 'B2 待审核且截止已过' })
  await expect(pendingOverdue.locator('.platform-tag')).toHaveText('待审核')
  await expect(pendingOverdue.locator('.b2-due-caption')).toHaveText('截止已过')
  await expect(pendingOverdue.locator('.b2-local-badge')).toHaveCount(0)
  await expect(pendingOverdue.locator('.task-check')).toHaveCount(0)

  const reviewed = page.locator('.task-row').filter({ hasText: 'B2 已批阅零分' })
  await expect(reviewed.locator('.task-row-action.danger')).toBeDisabled()
  await reviewed.locator('.b2-task-main').click()
  const modal = page.locator('.modal')
  await expect(modal.getByRole('button', { name: /标记为/ })).toHaveCount(0)
  await expect(modal.getByRole('button', { name: /平台任务不能本地删除/ })).toBeDisabled()
  await page.locator('.modal-close').click()
})

test('搜索与课程筛选组合保持正确结果', async () => {
  await openTasks()
  const search = page.getByPlaceholder('搜索任务标题或备注')
  await search.fill('B2 已批阅零分')
  await expect(page.locator('.task-row')).toHaveCount(1)
  await expect(page.locator('.task-row')).toContainText('B2 已批阅零分')

  await search.fill('B2')
  const courseFilter = page.getByLabel('按课程筛选')
  const courseId = await courseFilter.locator('option').nth(1).getAttribute('value')
  if (courseId) await courseFilter.selectOption(courseId)
  await expect(page.locator('.task-row')).toHaveCount(5)
  await expect(page.locator('.task-row').first()).toContainText('B2')
})

test('Records 保留九列，1024 下内部滚动且汇总分离', async () => {
  await page.setViewportSize({ width: 1024, height: 900 })
  await openRecords()

  const reviewedSummary = page.locator('.b2-summary-item').filter({ hasText: '已批阅' })
  const doneSummary = page.locator('.b2-summary-item').filter({ hasText: '已完成' })
  await expect(reviewedSummary).toContainText('1')
  await expect(doneSummary).toContainText('1')
  await expect(page.locator('.b2-records-table thead th')).toHaveCount(9)

  const dimensions = await page.locator('.b2-records-scroll').evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth
  }))
  expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth)
  const pageOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  )
  expect(pageOverflow).toBeLessThanOrEqual(1)

  const noEntryRow = page.locator('.b2-records-table tbody tr').filter({ hasText: 'B2 无官方入口' })
  await noEntryRow.locator('.b2-record-unavailable').scrollIntoViewIfNeeded()
  await expect(noEntryRow.locator('.b2-record-unavailable')).toBeVisible()
  await expect(noEntryRow.locator('.b2-record-unavailable')).toHaveText('无可用入口')

  const zeroRow = page.locator('.b2-records-table tbody tr').filter({ hasText: 'B2 已批阅零分' })
  await expect(zeroRow.locator('.b2-record-score')).toHaveText('0 / 100')
})

test('TaskDetail 对无入口任务显示可见降级说明', async () => {
  await page.setViewportSize({ width: 1024, height: 900 })
  await openTasks()
  await page
    .locator('.task-row')
    .filter({ hasText: 'B2 无官方入口' })
    .locator('.b2-task-main')
    .click()
  const modal = page.locator('.modal')
  await expect(modal).toBeVisible()
  await expect(modal.getByText('没有可用的官方入口')).toBeVisible()
  await expect(modal.getByText(/不会猜测或构造官方 URL/)).toBeVisible()
  await expect(modal.getByRole('button', { name: /在浏览器打开/ })).toBeDisabled()
  await expect(modal.getByRole('button', { name: /无可用入口/ })).toBeDisabled()
  await page.locator('.modal-close').click()
})

test('TaskDetail 为平台作业附件提供应用内下载入口', async () => {
  await openTasks()
  await page
    .locator('.task-row')
    .filter({ hasText: 'B2 已批阅零分' })
    .locator('.b2-task-main')
    .click()
  const modal = page.locator('.modal')
  await expect(modal).toBeVisible()
  const attachment = modal.locator('.b2-attachment-row').filter({ hasText: 'B2 附件模板.docx' })
  await expect(attachment).toBeVisible()
  await expect(attachment.locator('.b2-attachment-size')).toHaveText('17,851 字节')
  await expect(attachment.getByRole('button', { name: '下载' })).toBeEnabled()
  await page.locator('.modal-close').click()
})

test('TaskDetail 的分数与本地/平台状态保持分离', async () => {
  await openTasks()
  await page
    .locator('.task-row')
    .filter({ hasText: 'B2 已批阅零分' })
    .locator('.b2-task-main')
    .click()
  const modal = page.locator('.modal')
  await expect(modal).toBeVisible()
  await expect(modal.locator('.b2-state-panel').filter({ hasText: '平台状态' })).toContainText(
    '已批阅'
  )
  await expect(modal.locator('.b2-state-panel').filter({ hasText: '本地状态' })).toContainText(
    '未完成'
  )
  await expect(modal.locator('.b2-fact').filter({ hasText: '成绩' })).toContainText('0 / 100')
  await expect(modal.locator('.b2-detail-feedback')).toContainText('完成度良好')
  await page.locator('.modal-close').click()

  await page
    .locator('.task-row')
    .filter({ hasText: 'B2 已完成独立' })
    .locator('.b2-task-main')
    .click()
  await expect(modal.locator('.b2-state-panel').filter({ hasText: '平台状态' })).toContainText(
    '已完成'
  )
  await expect(modal.locator('.b2-state-panel').filter({ hasText: '本地状态' })).toContainText(
    '已完成'
  )
})

test('Records 同名教学班显示完整班级标识且不被裁切', async () => {
  const db = new DatabaseSync(DB_PATH)
  try {
    const source = db.prepare('SELECT * FROM courses LIMIT 1').get() as
      | Record<string, unknown>
      | undefined
    if (!source) throw new Error('缺少课程种子数据')
    db.prepare('UPDATE courses SET class_name = ?, clazz_id = ? WHERE id = ?').run(
      '教学班 A',
      '1001',
      source.id as string
    )
    const duplicate: Record<string, unknown> = {
      ...source,
      class_name: '教学班 B',
      clazz_id: '1002'
    }
    const columns = Object.keys(duplicate).filter((key) => key !== 'id')
    db.prepare(
      `INSERT INTO courses (id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})`
    ).run(
      'b2-e2e-duplicate-course',
      ...columns.map((key) => duplicate[key] as string | number | null)
    )
  } finally {
    db.close()
  }

  await page.reload()
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })
  await openRecords()
  const row = page.locator('.b2-records-table tbody tr').filter({ hasText: 'B2 已批阅零分' })
  const classLabel = row.locator('.records-class')
  await expect(classLabel).toBeVisible()
  await expect(classLabel).toContainText('教学班')
  await expect(classLabel).toContainText('班级')
  const clipped = await classLabel.evaluate(
    (element) =>
      element.scrollWidth > element.clientWidth + 1 ||
      element.scrollHeight > element.clientHeight + 1
  )
  expect(clipped).toBe(false)
})
