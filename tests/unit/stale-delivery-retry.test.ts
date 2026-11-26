import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runHeadlessReminderCheck } from '../../src/main/notifications/headless'
import { findNextReminderAt, ReminderScheduler } from '../../src/main/notifications/scheduler'
import { earliestIso } from '../../src/main/notifications/retry-policy'
import { StudyNextStore } from '../../src/main/storage/store'
import type { Task, TaskUpsertInput } from '../../src/shared/types'

const NOW = new Date('2026-11-22T10:00:00.000Z')
const OLD_RETRY = new Date('2026-11-22T10:01:00.000Z')
const dirs: string[] = []
const stores: StudyNextStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      // The store may already be closed by a test assertion path.
    }
  }
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function openStore(): StudyNextStore {
  const dir = mkdtempSync(join(tmpdir(), 'studynext-stale-retry-'))
  dirs.push(dir)
  const store = new StudyNextStore(join(dir, 'studynext.sqlite'))
  store.clearDemoData()
  stores.push(store)
  return store
}

function createTask(
  store: StudyNextStore,
  dueAt: string,
  reminderOffsets = [60],
  title = '改期重试测试'
): Task {
  return store.createTask({
    title,
    description: '',
    courseId: null,
    priority: 'high',
    kind: 'homework',
    dueAt,
    reminderOffsets
  })
}

function editInput(task: Task, edits: Partial<TaskUpsertInput> = {}): TaskUpsertInput {
  return {
    title: task.title,
    description: task.description,
    courseId: task.courseId,
    priority: task.priority,
    kind: task.kind,
    dueAt: task.dueAt,
    reminderOffsets: task.reminders.map((rule) => rule.offsetMinutes),
    ...edits
  }
}

function failureKey(task: Task): string {
  return `${task.id}:${task.reminders[0]!.id}:${task.dueAt}`
}

async function failOnce(store: StudyNextStore, now = NOW, title = '改期重试测试'): Promise<Task> {
  const task = store.listTasks().find((item) => item.title === title)!
  const result = await runHeadlessReminderCheck({
    store,
    now,
    notify: async () => {
      throw new Error('旧通知发送失败')
    }
  })
  expect(result.failed).toBe(1)
  return task
}

function nextWindowAt(store: StudyNextStore, at: Date): string | null {
  return earliestIso([findNextReminderAt(store.listTasks(), at), store.nextDeliveryRetryAt()])
}

describe('stale delivery retries after task changes', () => {
  it('drops an old retry when the deadline changes and schedules the new deadline', async () => {
    const store = openStore()
    const task = createTask(store, '2026-11-22T11:00:00.000Z')
    const key = failureKey(task)
    await failOnce(store)
    expect(store.getDeliveryFailure(key)?.nextRetryAt).toBe(OLD_RETRY.toISOString())

    const updated = store.updateTask(
      task.id,
      editInput(task, { dueAt: '2026-11-22T12:00:00.000Z' })
    )
    expect(updated.dueAt).toBe('2026-11-22T12:00:00.000Z')
    expect(store.getDeliveryFailure(key)).toBeNull()
    expect(store.nextDeliveryRetryAt()).toBeNull()

    const notify = vi.fn(async () => undefined)
    const oldRetryCheck = await runHeadlessReminderCheck({ store, notify, now: OLD_RETRY })
    expect(notify).not.toHaveBeenCalled()
    expect(oldRetryCheck.failed).toBe(0)
    expect(oldRetryCheck.nextReminderAt).toBe('2026-11-22T11:00:00.000Z')
    // Mirrors the Windows trigger calculation: the old retry no longer wins.
    expect(nextWindowAt(store, OLD_RETRY)).toBe('2026-11-22T11:00:00.000Z')
  })

  it('drops a retry from a replaced reminder rule and uses the new offset', async () => {
    const store = openStore()
    const task = createTask(store, '2026-11-22T12:00:00.000Z', [60])
    const oldKey = failureKey(task)
    await failOnce(store, new Date('2026-11-22T11:00:00.000Z'))
    expect(store.getDeliveryFailure(oldKey)?.nextRetryAt).toBe('2026-11-22T11:01:00.000Z')

    store.updateTask(task.id, editInput(task, { reminderOffsets: [30] }))
    expect(store.getDeliveryFailure(oldKey)).toBeNull()
    expect(store.nextDeliveryRetryAt()).toBeNull()

    const notify = vi.fn(async () => undefined)
    const atOldRetry = new Date('2026-11-22T11:01:00.000Z')
    const result = await runHeadlessReminderCheck({ store, notify, now: atOldRetry })
    expect(notify).not.toHaveBeenCalled()
    expect(result.nextReminderAt).toBe('2026-11-22T11:30:00.000Z')
  })

  it('keeps a valid retry when only an unrelated field changes', async () => {
    const store = openStore()
    const task = createTask(store, '2026-11-22T11:00:00.000Z')
    const key = failureKey(task)
    await failOnce(store)

    store.updateTask(task.id, editInput(task, { title: '只改标题' }))
    expect(store.getDeliveryFailure(key)?.nextRetryAt).toBe(OLD_RETRY.toISOString())
    expect(store.nextDeliveryRetryAt()).toBe(OLD_RETRY.toISOString())
  })

  it('does not replay a stale failure in the headless path even if a row survives', async () => {
    const store = openStore()
    const task = createTask(store, '2026-11-22T12:00:00.000Z', [30])
    const rule = task.reminders[0]!
    const oldDueAt = '2026-11-22T11:00:00.000Z'
    const oldKey = `${task.id}:${rule.id}:${oldDueAt}`
    store.recordDeliveryFailure({
      dedupeKey: oldKey,
      taskId: task.id,
      ruleId: rule.id,
      dueAt: oldDueAt,
      scheduledFor: '2026-11-22T10:30:00.000Z',
      error: '陈旧失败记录',
      at: NOW.toISOString(),
      nextRetryAt: OLD_RETRY.toISOString()
    })

    const notify = vi.fn(async () => undefined)
    const result = await runHeadlessReminderCheck({ store, notify, now: OLD_RETRY })
    expect(notify).not.toHaveBeenCalled()
    expect(result.retriesExhausted).toBe(1)
    expect(store.getDeliveryFailure(oldKey)?.nextRetryAt).toBeNull()
    expect(result.nextReminderAt).toBe('2026-11-22T11:30:00.000Z')
  })

  it('does not replay a stale failure in the in-process scheduler path', () => {
    const store = openStore()
    const task = createTask(store, '2026-11-22T12:00:00.000Z', [30])
    const rule = task.reminders[0]!
    const oldDueAt = '2026-11-22T11:00:00.000Z'
    const oldKey = `${task.id}:${rule.id}:${oldDueAt}`
    store.recordDeliveryFailure({
      dedupeKey: oldKey,
      taskId: task.id,
      ruleId: rule.id,
      dueAt: oldDueAt,
      scheduledFor: '2026-11-22T10:30:00.000Z',
      error: '陈旧失败记录',
      at: NOW.toISOString(),
      nextRetryAt: OLD_RETRY.toISOString()
    })

    const notify = vi.fn()
    const scheduler = new ReminderScheduler({
      store,
      notify,
      now: () => OLD_RETRY,
      tickMs: 60_000
    })
    scheduler.start()
    scheduler.stop()
    expect(notify).not.toHaveBeenCalled()
    expect(store.getDeliveryFailure(oldKey)?.nextRetryAt).toBeNull()
    expect(scheduler.getNextReminderAt()).toBe('2026-11-22T11:30:00.000Z')
  })

  it('drops an old retry when an imported/platform task deadline changes', async () => {
    const store = openStore()
    const imported = store.upsertImportedTask(
      {
        title: '平台同步作业',
        description: '',
        courseId: null,
        priority: 'high',
        kind: 'homework',
        dueAt: '2026-11-22T11:00:00.000Z',
        reminderOffsets: [60]
      },
      { externalId: 'hw-stale-1', source: 'chaoxing' }
    ).task
    const key = failureKey(imported)
    await failOnce(store, NOW, '平台同步作业')

    const result = store.upsertImportedTask(
      {
        title: '平台同步作业',
        description: '',
        courseId: null,
        priority: 'high',
        kind: 'homework',
        dueAt: '2026-11-22T12:00:00.000Z',
        reminderOffsets: [60]
      },
      { externalId: 'hw-stale-1', source: 'chaoxing' }
    )
    expect(result.deadlineChanged).toBe(true)
    expect(store.getDeliveryFailure(key)).toBeNull()
    expect(store.nextDeliveryRetryAt()).toBeNull()

    const notify = vi.fn(async () => undefined)
    await runHeadlessReminderCheck({ store, notify, now: OLD_RETRY })
    expect(notify).not.toHaveBeenCalled()
  })

  it('clears a retry when the task is completed', async () => {
    const store = openStore()
    const task = createTask(store, '2026-11-22T11:00:00.000Z')
    const key = failureKey(task)
    await failOnce(store)
    store.setTaskCompleted(task.id, true)
    expect(store.getDeliveryFailure(key)).toBeNull()
    expect(store.nextDeliveryRetryAt()).toBeNull()
  })

  it('clears a retry when the task is deleted', async () => {
    const store = openStore()
    const task = createTask(store, '2026-11-22T11:00:00.000Z')
    const key = failureKey(task)
    await failOnce(store)
    store.deleteTask(task.id)
    expect(store.getDeliveryFailure(key)).toBeNull()
    expect(store.nextDeliveryRetryAt()).toBeNull()
  })
})
