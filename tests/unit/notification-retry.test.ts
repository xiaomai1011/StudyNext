import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runHeadlessReminderCheck } from '../../src/main/notifications/headless'
import {
  decideDeliveryRetry,
  DELIVERY_MAX_ATTEMPTS
} from '../../src/main/notifications/retry-policy'
import { StudyNextStore } from '../../src/main/storage/store'

const NOW = new Date('2026-11-22T10:00:00.000Z')
const dirs: string[] = []

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function createTask(store: StudyNextStore, now: Date) {
  return store.createTask({
    title: '重试测试作业',
    description: '',
    courseId: null,
    priority: 'high',
    kind: 'homework',
    dueAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    reminderOffsets: [60]
  })
}

describe('delivery retry policy', () => {
  it('uses bounded 1/5/15 minute backoff and stops at the limit', () => {
    const dueAt = new Date(NOW.getTime() + 60 * 60_000).toISOString()
    expect(decideDeliveryRetry({ attemptCount: 1, dueAt, now: NOW })).toEqual({
      nextRetryAt: '2026-11-22T10:01:00.000Z',
      exhausted: false
    })
    expect(decideDeliveryRetry({ attemptCount: 2, dueAt, now: NOW })).toEqual({
      nextRetryAt: '2026-11-22T10:05:00.000Z',
      exhausted: false
    })
    expect(decideDeliveryRetry({ attemptCount: 3, dueAt, now: NOW })).toEqual({
      nextRetryAt: '2026-11-22T10:15:00.000Z',
      exhausted: false
    })
    expect(
      decideDeliveryRetry({
        attemptCount: DELIVERY_MAX_ATTEMPTS,
        dueAt,
        now: NOW
      })
    ).toEqual({ nextRetryAt: null, exhausted: true })
  })

  it('does not schedule beyond the deadline', () => {
    expect(
      decideDeliveryRetry({
        attemptCount: 1,
        dueAt: '2026-11-22T10:00:30.000Z',
        now: NOW
      })
    ).toEqual({ nextRetryAt: null, exhausted: true })
  })
})

describe('persisted delivery retry', () => {
  it('survives a process restart and clears only on a successful send', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studynext-retry-'))
    dirs.push(dir)
    const dbPath = join(dir, 'studynext.sqlite')
    const first = new StudyNextStore(dbPath)
    first.clearDemoData()
    const task = createTask(first, NOW)
    expect(task.reminders).toHaveLength(1)
    const failingNotify = vi.fn(async () => {
      throw new Error('通知服务不可用')
    })
    const failed = await runHeadlessReminderCheck({
      store: first,
      notify: failingNotify,
      now: NOW
    })
    expect(failed.failed).toBe(1)
    expect(failed.nextReminderAt).toBe('2026-11-22T10:01:00.000Z')
    const key = `${task.id}:${task.reminders[0]!.id}:${task.dueAt}`
    expect(first.getDeliveryFailure(key)).toMatchObject({
      attemptCount: 1,
      nextRetryAt: '2026-11-22T10:01:00.000Z'
    })
    first.close()

    const second = new StudyNextStore(dbPath)
    second.clearDemoData()
    expect(second.getDeliveryFailure(key)?.lastError).toBe('通知服务不可用')
    const successNotify = vi.fn(async () => undefined)
    const recovered = await runHeadlessReminderCheck({
      store: second,
      notify: successNotify,
      now: new Date('2026-11-22T10:01:00.000Z')
    })
    expect(recovered.delivered).toBe(1)
    expect(recovered.failed).toBe(0)
    expect(second.getDeliveryFailure(key)).toBeNull()
    expect(second.latestDeliveryError()).toBeNull()
    second.close()
  })

  it('keeps one task failure isolated when another retry succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studynext-retry-'))
    dirs.push(dir)
    const store = new StudyNextStore(join(dir, 'studynext.sqlite'))
    store.clearDemoData()
    const taskA = createTask(store, NOW)
    const taskB = createTask(store, NOW)
    const notify = vi.fn(async (event: { taskId: string }) => {
      if (event.taskId === taskA.id) throw new Error('A 失败')
    })
    const failed = await runHeadlessReminderCheck({ store, notify, now: NOW })
    expect(failed.failed).toBe(1)
    const keyA = `${taskA.id}:${taskA.reminders[0]!.id}:${taskA.dueAt}`
    const keyB = `${taskB.id}:${taskB.reminders[0]!.id}:${taskB.dueAt}`
    expect(store.getDeliveryFailure(keyA)?.lastError).toBe('A 失败')
    expect(store.getDeliveryFailure(keyB)).toBeNull()
    store.close()
  })
})
