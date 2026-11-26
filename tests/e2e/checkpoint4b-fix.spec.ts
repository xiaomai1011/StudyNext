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
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-4b-fix-'))
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

function openDb(): DatabaseSync {
  return new DatabaseSync(dbPath)
}

function readTaskRow(id: string): Record<string, unknown> {
  const db = openDb()
  try {
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown>
  } finally {
    db.close()
  }
}

async function taskCall(
  method: string,
  args: unknown[]
): Promise<{ ok: boolean; message?: string }> {
  return page.evaluate(
    async ({ method, args }) => {
      try {
        const api = (
          window as unknown as {
            studynext: { tasks: Record<string, (...input: unknown[]) => Promise<unknown>> }
          }
        ).studynext
        await api.tasks[method]!(...args)
        return { ok: true }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
    { method, args }
  )
}

async function bootstrapTasks(): Promise<
  Array<{
    id: string
    title: string
    description: string
    courseId: string | null
    priority: 'high' | 'medium' | 'low'
    kind: 'homework' | 'exam' | 'reading' | 'activity' | 'other'
    dueAt: string
    status: 'todo' | 'done'
    reminders: Array<{ offsetMinutes: number }>
    source: string
  }>
> {
  return page.evaluate(async () => {
    const data = await window.studynext.bootstrap()
    return data.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      courseId: task.courseId,
      priority: task.priority,
      kind: task.kind,
      dueAt: task.dueAt,
      status: task.status,
      reminders: task.reminders.map((rule) => ({ offsetMinutes: rule.offsetMinutes })),
      source: task.source
    }))
  })
}

async function seedPlatformTask(): Promise<{
  id: string
  payload: {
    title: string
    description: string
    courseId: string | null
    priority: 'high' | 'medium' | 'low'
    kind: 'homework' | 'exam' | 'reading' | 'activity' | 'other'
    dueAt: string
    reminderOffsets: number[]
  }
}> {
  const tasks = await bootstrapTasks()
  const task = tasks[0]
  if (!task) throw new Error('没有可用于平台任务夹具的演示任务')
  const db = openDb()
  try {
    db.prepare(
      `UPDATE tasks
       SET source = 'chaoxing',
           external_id = 'chaoxing:e2e:platform',
           status = 'todo',
           completed_at = NULL,
           completion_source = NULL,
           platform_status = '待批阅',
           platform_status_kind = 'pending_review',
           manual_fields_json = '[]',
           field_sources_json = '{"status":"chaoxing"}'
       WHERE id = ?`
    ).run(task.id)
  } finally {
    db.close()
  }
  return {
    id: task.id,
    payload: {
      title: task.title,
      description: task.description,
      courseId: task.courseId,
      priority: task.priority,
      kind: task.kind,
      dueAt: task.dueAt,
      reminderOffsets: task.reminders.map((rule) => rule.offsetMinutes)
    }
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
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })
  dbPath = join(DATA_DIR, 'workspaces', 'local.sqlite')
  await waitForFile(dbPath)
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test.describe.serial('CP4B-01 平台任务主进程保护', () => {
  let platformId: string
  let payload: Awaited<ReturnType<typeof seedPlatformTask>>['payload']

  test.beforeAll(async () => {
    const seeded = await seedPlatformTask()
    platformId = seeded.id
    payload = seeded.payload
  })

  test('tasks.setCompleted(true) 被主进程拒绝且不写库', async () => {
    const before = readTaskRow(platformId)
    const result = await taskCall('setCompleted', [platformId, true])
    expect(result.ok).toBe(false)
    expect(result.message).toContain('学习通任务')
    expect(readTaskRow(platformId)).toEqual(before)
  })

  test('tasks.setCompleted(false) 被主进程拒绝且不写库', async () => {
    const before = readTaskRow(platformId)
    const result = await taskCall('setCompleted', [platformId, false])
    expect(result.ok).toBe(false)
    expect(result.message).toContain('学习通任务')
    expect(readTaskRow(platformId)).toEqual(before)
  })

  test('tasks.remove 被主进程拒绝且任务仍存在', async () => {
    const before = readTaskRow(platformId)
    const result = await taskCall('remove', [platformId])
    expect(result.ok).toBe(false)
    expect(result.message).toContain('学习通任务')
    expect(readTaskRow(platformId)).toEqual(before)
  })

  test('tasks.update({status:"done"}) 被主进程拒绝且不写库', async () => {
    const before = readTaskRow(platformId)
    const result = await taskCall('update', [platformId, { ...payload, status: 'done' }])
    expect(result.ok).toBe(false)
    expect(result.message).toContain('学习通任务')
    expect(readTaskRow(platformId)).toEqual(before)
  })

  test('tasks.update({completion_source:"local"}) 被 schema/主进程拒绝且不写库', async () => {
    const before = readTaskRow(platformId)
    const result = await taskCall('update', [
      platformId,
      { ...payload, completion_source: 'local' }
    ])
    expect(result.ok).toBe(false)
    expect(readTaskRow(platformId)).toEqual(before)
  })

  test('tasks.update 修改普通字段仍可用，状态保持平台值', async () => {
    const title = `${payload.title}（本地编辑）`
    const result = await taskCall('update', [platformId, { ...payload, title }])
    expect(result.ok).toBe(true)
    const after = readTaskRow(platformId)
    expect(after.title).toBe(title)
    expect(after.status).toBe('todo')
    expect(after.completion_source).toBeNull()
  })

  test('连续拒绝操作不改变平台任务字节状态', async () => {
    const before = readTaskRow(platformId)
    await taskCall('setCompleted', [platformId, true])
    await taskCall('setCompleted', [platformId, false])
    await taskCall('remove', [platformId])
    await taskCall('update', [platformId, { ...payload, status: 'done' }])
    expect(readTaskRow(platformId)).toEqual(before)
  })
})

test.describe('CP4B-01 本地任务回归', () => {
  test('本地任务可以完成与取消完成', async () => {
    const created = await taskCall('create', [
      {
        title: 'CP4B-01 本地任务',
        description: '',
        courseId: null,
        priority: 'low',
        kind: 'other',
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        reminderOffsets: [60]
      }
    ])
    expect(created.ok).toBe(true)

    const tasks = await bootstrapTasks()
    const task = tasks.find((item) => item.title === 'CP4B-01 本地任务')
    if (!task) throw new Error('本地任务未创建')
    expect((await taskCall('setCompleted', [task.id, true])).ok).toBe(true)
    expect((await taskCall('setCompleted', [task.id, false])).ok).toBe(true)
    expect((await taskCall('remove', [task.id])).ok).toBe(true)
    expect((await bootstrapTasks()).some((item) => item.id === task.id)).toBe(false)
  })

  test('本地任务可以修改普通字段', async () => {
    const created = await taskCall('create', [
      {
        title: 'CP4B-01 可编辑任务',
        description: '',
        courseId: null,
        priority: 'low',
        kind: 'other',
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        reminderOffsets: []
      }
    ])
    expect(created.ok).toBe(true)
    const task = (await bootstrapTasks()).find((item) => item.title === 'CP4B-01 可编辑任务')
    if (!task) throw new Error('本地任务未创建')
    const result = await taskCall('update', [
      task.id,
      {
        title: 'CP4B-01 已编辑任务',
        description: '',
        courseId: null,
        priority: 'high',
        kind: 'other',
        dueAt: task.dueAt,
        reminderOffsets: []
      }
    ])
    expect(result.ok).toBe(true)
    expect((await bootstrapTasks()).find((item) => item.id === task.id)?.title).toBe(
      'CP4B-01 已编辑任务'
    )
  })
})
