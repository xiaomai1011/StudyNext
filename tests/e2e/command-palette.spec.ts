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
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-command-palette-'))
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

function seedFixtureData(): void {
  const db = new DatabaseSync(dbPath)
  const nowIso = new Date().toISOString()
  const pastDue = '2025-01-10T23:59:00+08:00'
  const futureDue = '2027-06-15T23:59:00+08:00'

  try {
    db.exec('BEGIN')

    const insertCourse = db.prepare(`
      INSERT OR REPLACE INTO courses (
        id, external_id, name, code, teacher, semester, category, color,
        favorite, clazz_id, class_name, schedule_json, semester_start, max_week,
        source, source_url, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, 16, 'chaoxing', NULL, ?, ?)
    `)

    // 1. Same-name courses with colliding class_name ("公共1班") distinguished by clazz_id
    insertCourse.run(
      'c-prob-1',
      '1001:3001',
      '数值分析',
      'NUM101',
      '王老师',
      '2026年秋',
      '必修',
      '#2558d9',
      0,
      '3001',
      '公共1班',
      nowIso,
      nowIso
    )
    insertCourse.run(
      'c-prob-2',
      '1001:3002',
      '数值分析',
      'NUM101',
      '赵老师',
      '2026年秋',
      '必修',
      '#157a52',
      0,
      '3002',
      '公共1班',
      nowIso,
      nowIso
    )
    // 2. Prefix-match course to test exact normalized title ranking vs prefix match
    insertCourse.run(
      'c-exact-prefix',
      '2001:4001',
      '高等 数学 习题',
      'MATH202',
      '张老师',
      '2026年秋',
      '必修',
      '#0369a1',
      1,
      '4001',
      '01班',
      nowIso,
      nowIso
    )
    // 3. Long teaching-class name must not hide the short clazz id in the badge
    insertCourse.run(
      'c-long-class-1',
      '3001:7001',
      '数据结构（荣誉班）',
      'CS301',
      '李老师',
      '2026年秋',
      '必修',
      '#7c3aed',
      0,
      '7001',
      '这是一个非常长的教学班名称用于验证短班级编号始终可见',
      nowIso,
      nowIso
    )
    insertCourse.run(
      'c-long-class-2',
      '3001:7002',
      '数据结构（荣誉班）',
      'CS301',
      '李老师',
      '2026年秋',
      '必修',
      '#7c3aed',
      0,
      '7002',
      '另一个非常长的教学班名称用于验证短班级编号始终可见',
      nowIso,
      nowIso
    )

    const insertTask = db.prepare(`
      INSERT OR REPLACE INTO tasks (
        id, title, description, course_id, priority, kind, status, due_at,
        completed_at, completion_source, source, external_id, source_updated_at,
        source_url, platform_status, platform_status_kind, submitted_at,
        score, full_score, teacher_feedback, attachments_json,
        manual_fields_json, field_sources_json, created_at, updated_at
      ) VALUES (?, ?, '', ?, 'medium', 'homework', ?, ?, NULL, NULL, 'chaoxing', ?, NULL, NULL, ?, ?, NULL, ?, ?, NULL, '[]', '[]', '{}', ?, ?)
    `)

    // 4 past-due Chaoxing tasks to verify overdue badge never overwrites terminal statuses
    insertTask.run(
      't-status-unsub',
      '状态核验-未交',
      'c-prob-1',
      'todo',
      pastDue,
      'work:unsub',
      '未交',
      'not_submitted',
      null,
      null,
      nowIso,
      nowIso
    )
    insertTask.run(
      't-status-sub',
      '状态核验-已交',
      'c-prob-1',
      'todo',
      pastDue,
      'work:sub',
      '已交',
      'submitted',
      null,
      null,
      nowIso,
      nowIso
    )
    insertTask.run(
      't-status-pending',
      '状态核验-待审',
      'c-prob-1',
      'todo',
      pastDue,
      'work:pending',
      '待批阅',
      'pending_review',
      null,
      null,
      nowIso,
      nowIso
    )
    insertTask.run(
      't-status-reviewed',
      '状态核验-已批',
      'c-prob-1',
      'todo',
      pastDue,
      'work:reviewed',
      '已完成',
      'reviewed',
      '95',
      '100',
      nowIso,
      nowIso
    )

    // Same-course, same-title, same-dueAt colliding tasks
    insertTask.run(
      't-collide-1',
      '课堂小测',
      'c-prob-1',
      'todo',
      futureDue,
      'work:880011',
      '未交',
      'not_submitted',
      null,
      null,
      nowIso,
      nowIso
    )
    insertTask.run(
      't-collide-2',
      '课堂小测',
      'c-prob-1',
      'todo',
      futureDue,
      'work:880022',
      '未交',
      'not_submitted',
      null,
      null,
      nowIso,
      nowIso
    )

    // Exact normalized title task ("高等 数学") competing against prefix course ("高等 数学 习题")
    insertTask.run(
      't-exact-title',
      '高等 数学',
      'c-exact-prefix',
      'done',
      futureDue,
      'work:exact1',
      '已完成',
      'done',
      null,
      null,
      nowIso,
      nowIso
    )

    // 130 materials to verify "查看全部" + incremental "加载更多" reaches item #130
    const insertMaterial = db.prepare(`
      INSERT OR REPLACE INTO materials (
        id, course_id, external_id, name, kind, file_type, size, url, source_url, source, updated_at
      ) VALUES (?, ?, ?, ?, 'file', 'pdf', '1.2 MB', ?, NULL, 'chaoxing', ?)
    `)
    for (let i = 1; i <= 130; i++) {
      const padded = String(i).padStart(3, '0')
      insertMaterial.run(
        `mat-bulk-${padded}`,
        'c-prob-1',
        `material:${9000 + i}`,
        `算法讲义-${padded}.pdf`,
        `https://mooc1.chaoxing.com/file/${9000 + i}`,
        nowIso
      )
    }

    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

async function openPalette(): Promise<void> {
  if ((await page.locator('.command-palette').count()) > 0) {
    await page.keyboard.press('Escape')
    await expect(page.locator('.command-palette')).toHaveCount(0)
  }
  await page.keyboard.press('Control+K')
  await expect(page.locator('.command-palette')).toBeVisible()
  await expect(page.locator('.command-input-row input')).toBeFocused()
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
  seedFixtureData()
  await page.reload()
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })
})

test.afterEach(async () => {
  if ((await page.locator('.modal-close').count()) > 0) {
    await page
      .locator('.modal-close')
      .first()
      .click()
      .catch(() => undefined)
  }
  if ((await page.locator('.command-palette').count()) > 0) {
    await page.keyboard.press('Escape').catch(() => undefined)
  }
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('N-004-R #1：「查看全部」与分页加载可完整访问 130 条结果直至末条记录', async () => {
  await openPalette()
  const input = page.locator('.command-input-row input')
  await input.fill('算法讲义')

  const expandBtn = page.locator('.command-item[data-kind="expand_scope"]')
  await expect(expandBtn).toContainText('查看全部 130 条资料')
  await expandBtn.click()

  // Switched to '资料' scope with first 60 items + load_more row
  await expect(page.locator('.command-item[data-kind="material"]')).toHaveCount(60)
  const loadMore = page.locator('.command-item[data-kind="load_more"]')
  await expect(loadMore).toContainText('60 / 130')

  // Load next batch via keyboard (End + Enter)
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(page.locator('.command-item[data-kind="material"]')).toHaveCount(120)
  await expect(loadMore).toContainText('120 / 130')

  // Load final batch to reach item #130
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(page.locator('.command-item[data-kind="material"]')).toHaveCount(130)
  await expect(page.locator('.command-item[data-kind="load_more"]')).toHaveCount(0)
  await expect(
    page.locator('.command-item[data-kind="material"]').filter({ hasText: '算法讲义-130.pdf' })
  ).toHaveCount(1)
})

test('N-004-R #2：仅仍需作答的任务显示「已逾期」，已提交/待审核/已批阅不被覆盖', async () => {
  await openPalette()
  await page.locator('.command-input-row input').fill('状态核验')

  const unsub = page.locator('.command-item').filter({ hasText: '状态核验-未交' })
  const sub = page.locator('.command-item').filter({ hasText: '状态核验-已交' })
  const pending = page.locator('.command-item').filter({ hasText: '状态核验-待审' })
  const reviewed = page.locator('.command-item').filter({ hasText: '状态核验-已批' })

  await expect(unsub.locator('.command-badge')).toHaveText('已逾期')
  await expect(sub.locator('.command-badge')).toHaveText('已提交')
  await expect(pending.locator('.command-badge')).toHaveText('待审核')
  await expect(reviewed.locator('.command-badge')).toHaveText('已批阅 · 95 / 100')
})

test('N-004-R #3：同名教学班与同课同截止同名作业在界面中清晰消歧', async () => {
  await openPalette()
  const input = page.locator('.command-input-row input')
  await input.fill('数值分析')

  const courses = page.locator('.command-item[data-kind="course"]')
  await expect(courses).toHaveCount(2)
  await expect(courses.nth(0)).toContainText('教学班 公共1班 · 班级 3001')
  await expect(courses.nth(1)).toContainText('教学班 公共1班 · 班级 3002')

  await input.fill('课堂小测')
  const tasks = page.locator('.command-item[data-kind="task"]')
  await expect(tasks).toHaveCount(2)
  const sub0 = await tasks.nth(0).locator('small').innerText()
  const sub1 = await tasks.nth(1).locator('small').innerText()
  expect(sub0).toContain('教学班 公共1班 · 班级 3001')
  expect(sub0).toContain('ID ')
  expect(sub1).toContain('ID ')
  expect(sub0).not.toBe(sub1)
})

test('N-004-R #4：多词归一化精确匹配严格优于前缀匹配，Enter 直接打开真正最佳匹配项', async () => {
  await openPalette()
  await page.locator('.command-input-row input').fill('高等 数学')

  const firstItem = page.locator('.command-item').first()
  await expect(firstItem).toHaveAttribute('data-kind', 'task')
  await expect(firstItem).toContainText('高等 数学')

  // Press Enter directly -> opens TaskDetail modal for the exact-match task
  await page.keyboard.press('Enter')
  await expect(page.locator('.command-palette')).toHaveCount(0)
  await expect(page.locator('.modal')).toBeVisible()
  await expect(page.locator('.modal')).toContainText('高等 数学')
})

test('N-004-R #5：空态支持键盘聚焦与激活操作按钮，同时保留分类切换与 Escape 关闭', async () => {
  await openPalette()
  const input = page.locator('.command-input-row input')

  // Case A: zero hits anywhere -> ArrowDown / Tab focuses "清空搜索", Enter clears query and refocuses input
  await input.fill('完全不存在的关键词zzzz')
  const clearBtn = page.locator('.command-empty-actions button', { hasText: '清空搜索' })
  await expect(clearBtn).toBeVisible()

  await page.keyboard.press('Tab')
  await expect(clearBtn).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(input).toHaveValue('')
  await expect(input).toBeFocused()

  // Case B: empty in specific scope ('考试') with hits in '资料' -> Tab still cycles scopes;
  // ArrowDown focuses '在「全部」中查看' and Enter activates it
  await page.locator('.command-scope-pill', { hasText: '考试' }).click()
  await input.fill('算法讲义')
  const viewAllBtn = page.locator('.command-empty-actions button', { hasText: '在「全部」中查看' })
  const clearScopeBtn = page.locator('.command-empty-actions button', { hasText: '清空搜索' })
  await expect(viewAllBtn).toBeVisible()

  // Tab from input cycles scope (existing behavior preserved)
  await page.keyboard.press('Tab')
  await expect(page.locator('.command-scope-pill.active')).not.toContainText('考试')

  // Switch back to '考试' and test ArrowDown / ArrowRight / ArrowUp / Enter on empty-state buttons
  await page.locator('.command-scope-pill', { hasText: '考试' }).click()
  await expect(viewAllBtn).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect(viewAllBtn).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(clearScopeBtn).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(viewAllBtn).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(input).toBeFocused()

  // Activate '在「全部」中查看' via ArrowDown + Enter
  await page.keyboard.press('ArrowDown')
  await expect(viewAllBtn).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('.command-scope-pill.active')).toContainText('全部')
  await expect(page.locator('.command-item[data-kind="material"]').first()).toBeVisible()

  // Case C: Escape closes palette even while an empty-state button is focused
  await input.fill('完全不存在的关键词zzzz')
  await page.keyboard.press('ArrowDown')
  await expect(clearBtn).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('.command-palette')).toHaveCount(0)
})

test('N-005-R #6：长教学班名称不会遮住徽标开头的短班级编号', async () => {
  await openPalette()
  await page.locator('.command-input-row input').fill('数据结构（荣誉班）')

  const courses = page.locator('.command-item[data-kind="course"]')
  await expect(courses).toHaveCount(2)
  const item = courses.filter({ hasText: '班级 7001' }).first()
  const badge = item.locator('.command-badge')
  await expect(badge).toContainText('班级 7001')
  await expect(badge).toBeVisible()
  await expect(courses.filter({ hasText: '班级 7002' })).toHaveCount(1)

  // 徽标可能因长班名整体省略，但开头的短班级编号必须实际落在可见区域内。
  const prefixVisible = await badge.evaluate((element) => {
    const node = element.firstChild
    if (!node || node.nodeType !== Node.TEXT_NODE) return false
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, 7)
    const prefixRect = range.getBoundingClientRect()
    const badgeRect = element.getBoundingClientRect()
    return prefixRect.left >= badgeRect.left && prefixRect.right <= badgeRect.right + 0.5
  })
  expect(prefixVisible).toBe(true)
})
