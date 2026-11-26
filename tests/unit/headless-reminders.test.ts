import { describe, expect, it, vi } from 'vitest'
import type { AppSettings, Task } from '../../src/shared/types'
import type { StudyNextStore } from '../../src/main/storage/store'
import { runHeadlessReminderCheck } from '../../src/main/notifications/headless'

const NOW = new Date('2026-11-22T10:00:00.000Z')

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: '提交实验报告',
    description: '',
    courseId: 'course-1',
    priority: 'medium',
    kind: 'assignment',
    status: 'todo',
    dueAt: '2026-11-22T10:30:00.000Z',
    completedAt: null,
    reminderOffsets: [60],
    reminders: [
      {
        id: 'rule-1',
        taskId: 'task-1',
        offsetMinutes: 60,
        enabled: true,
        createdAt: '2026-11-01T00:00:00.000Z'
      }
    ],
    source: 'manual',
    sourceUrl: null,
    externalId: null,
    platformStatus: null,
    platformStatusKind: 'unknown',
    submittedAt: null,
    score: null,
    fullScore: null,
    teacherFeedback: null,
    attachments: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    manualFields: [],
    fieldSources: {},
    ...overrides
  } as Task
}

interface FakeFailure {
  dedupeKey: string
  taskId: string
  ruleId: string
  dueAt: string
  scheduledFor: string
  attemptCount: number
  lastError: string
  lastAttemptAt: string
  nextRetryAt: string | null
}

function fakeStore(options: { tasks?: Task[]; notificationsEnabled?: boolean }): {
  store: StudyNextStore
  deliveries: Set<string>
  failures: Map<string, FakeFailure>
  claim: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
} {
  const deliveries = new Set<string>()
  const failures = new Map<string, FakeFailure>()
  const settings = {
    notificationsEnabled: options.notificationsEnabled ?? true
  } as AppSettings
  const claim = vi.fn((input: { taskId: string; ruleId: string; dueAt: string }) => {
    const key = `${input.taskId}:${input.ruleId}:${input.dueAt}`
    if (deliveries.has(key)) return null
    deliveries.add(key)
    return key
  })
  const release = vi.fn((key: string) => {
    deliveries.delete(key)
  })
  const dueFailures = (nowIso: string) =>
    [...failures.values()].filter((item) => item.nextRetryAt !== null && item.nextRetryAt <= nowIso)
  const store = {
    getSettings: () => settings,
    listTasks: () => options.tasks ?? [task()],
    getCourse: (id: string) => (id === 'course-1' ? { id, name: '计算机导论' } : null),
    hasDelivery: (taskId: string, ruleId: string, dueAt: string) =>
      deliveries.has(`${taskId}:${ruleId}:${dueAt}`),
    claimDelivery: claim,
    releaseDelivery: release,
    getDeliveryFailure: (key: string) => failures.get(key) ?? null,
    listDueDeliveryFailures: (nowIso: string) => dueFailures(nowIso),
    nextDeliveryRetryAt: () => {
      const values = [...failures.values()]
        .map((item) => item.nextRetryAt)
        .filter((item): item is string => item !== null)
      return values.length === 0 ? null : values.sort()[0]!
    },
    latestDeliveryError: () => {
      const values = [...failures.values()].sort((a, b) =>
        b.lastAttemptAt.localeCompare(a.lastAttemptAt)
      )
      return values[0]?.lastError ?? null
    },
    recordDeliveryFailure: (input: {
      dedupeKey: string
      taskId: string
      ruleId: string
      dueAt: string
      scheduledFor: string
      error: string
      at: string
      nextRetryAt: string | null
    }) => {
      const attemptCount = (failures.get(input.dedupeKey)?.attemptCount ?? 0) + 1
      failures.set(input.dedupeKey, {
        dedupeKey: input.dedupeKey,
        taskId: input.taskId,
        ruleId: input.ruleId,
        dueAt: input.dueAt,
        scheduledFor: input.scheduledFor,
        attemptCount,
        lastError: input.error,
        lastAttemptAt: input.at,
        nextRetryAt: input.nextRetryAt
      })
      return attemptCount
    },
    markDeliveryFailureExhausted: (key: string) => {
      const failure = failures.get(key)
      if (failure) failure.nextRetryAt = null
    },
    clearDeliveryFailure: (key: string) => {
      failures.delete(key)
    }
  } as unknown as StudyNextStore
  return { store, deliveries, failures, claim, release }
}

describe('headless reminder check', () => {
  it('claims and delivers a due reminder exactly once', async () => {
    const { store, deliveries, claim } = fakeStore({})
    const notify = vi.fn(async () => undefined)
    const result = await runHeadlessReminderCheck({ store, notify, now: NOW })
    expect(result.candidates).toBe(1)
    expect(result.delivered).toBe(1)
    expect(result.failed).toBe(0)
    expect(deliveries.size).toBe(1)
    expect(claim).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        courseName: '计算机导论',
        taskTitle: '提交实验报告'
      }),
      expect.objectContaining({ id: 'task-1' })
    )

    const second = await runHeadlessReminderCheck({ store, notify, now: NOW })
    expect(second.candidates).toBe(0)
    expect(second.delivered).toBe(0)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('persists a bounded retry when delivery fails', async () => {
    const { store, deliveries, failures, release } = fakeStore({})
    const notify = vi.fn(async () => {
      throw new Error('通知不可用')
    })
    const result = await runHeadlessReminderCheck({ store, notify, now: NOW })
    const key = 'task-1:rule-1:2026-11-22T10:30:00.000Z'
    expect(result.failed).toBe(1)
    expect(result.retriesScheduled).toBe(1)
    expect(result.retriesExhausted).toBe(0)
    expect(result.errors[0]).toContain('通知不可用')
    expect(deliveries.size).toBe(0)
    expect(release).toHaveBeenCalledTimes(1)
    expect(failures.get(key)).toMatchObject({
      attemptCount: 1,
      lastError: '通知不可用',
      nextRetryAt: '2026-11-22T10:01:00.000Z'
    })
    // No normal reminder remains (the 09:30 trigger is in the past), so the
    // next Windows trigger must be the persisted retry, not null.
    expect(result.nextReminderAt).toBe('2026-11-22T10:01:00.000Z')
  })

  it('delivers a retry, clears only its error, and resumes scheduling', async () => {
    const { store, failures } = fakeStore({})
    const notify = vi
      .fn()
      .mockRejectedValueOnce(new Error('通知不可用'))
      .mockResolvedValueOnce(undefined)
    const first = await runHeadlessReminderCheck({ store, notify, now: NOW })
    expect(first.retriesScheduled).toBe(1)
    const retryAt = new Date('2026-11-22T10:01:00.000Z')
    const second = await runHeadlessReminderCheck({
      store,
      notify,
      now: retryAt
    })
    expect(second.delivered).toBe(1)
    expect(second.failed).toBe(0)
    expect(second.retriesScheduled).toBe(0)
    expect(failures.size).toBe(0)
    expect(store.latestDeliveryError()).toBeNull()
  })

  it('backs off 1/5/15 minutes and stops after the fourth failure', async () => {
    const { store, failures } = fakeStore({})
    const notify = vi.fn(async () => {
      throw new Error('通知不可用')
    })
    const key = 'task-1:rule-1:2026-11-22T10:30:00.000Z'
    const steps = [
      ['2026-11-22T10:00:00.000Z', '2026-11-22T10:01:00.000Z', 1],
      ['2026-11-22T10:01:00.000Z', '2026-11-22T10:06:00.000Z', 2],
      ['2026-11-22T10:06:00.000Z', '2026-11-22T10:21:00.000Z', 3],
      ['2026-11-22T10:21:00.000Z', null, 4]
    ] as const
    for (const [nowIso, nextRetryAt, attemptCount] of steps) {
      const result = await runHeadlessReminderCheck({
        store,
        notify,
        now: new Date(nowIso)
      })
      expect(result.failed).toBe(1)
      expect(failures.get(key)?.attemptCount).toBe(attemptCount)
      expect(failures.get(key)?.nextRetryAt).toBe(nextRetryAt)
      if (nextRetryAt === null) {
        expect(result.retriesExhausted).toBe(1)
        expect(result.nextReminderAt).toBeNull()
      } else {
        expect(result.retriesScheduled).toBe(1)
        expect(result.nextReminderAt).toBe(nextRetryAt)
      }
    }
    // The failure is retained for the UI after retries stop.
    expect(failures.get(key)?.lastError).toBe('通知不可用')
  })

  it('does not schedule a retry past the reminder deadline', async () => {
    const { store, failures } = fakeStore({
      tasks: [
        task({
          dueAt: '2026-11-22T10:00:30.000Z',
          reminders: [
            {
              id: 'rule-1',
              taskId: 'task-1',
              offsetMinutes: 1,
              enabled: true,
              createdAt: '2026-11-01T00:00:00.000Z'
            }
          ]
        })
      ]
    })
    const notify = vi.fn(async () => {
      throw new Error('通知不可用')
    })
    const result = await runHeadlessReminderCheck({ store, notify, now: NOW })
    const failure = [...failures.values()][0]
    expect(result.failed).toBe(1)
    expect(result.retriesScheduled).toBe(0)
    expect(result.retriesExhausted).toBe(1)
    expect(failure?.nextRetryAt).toBeNull()
  })

  it('does not claim anything while notifications are disabled', async () => {
    const { store, claim } = fakeStore({ notificationsEnabled: false })
    const notify = vi.fn(async () => undefined)
    const result = await runHeadlessReminderCheck({ store, notify, now: NOW })
    expect(result.candidates).toBe(0)
    expect(result.delivered).toBe(0)
    expect(claim).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('does not treat an old reminder outside the catch-up window as due', async () => {
    const { store } = fakeStore({
      tasks: [
        task({
          dueAt: '2026-11-22T12:00:00.000Z',
          reminders: [
            {
              id: 'rule-1',
              taskId: 'task-1',
              offsetMinutes: 60,
              enabled: true,
              createdAt: '2026-11-01T00:00:00.000Z'
            }
          ]
        })
      ]
    })
    const notify = vi.fn(async () => undefined)
    const result = await runHeadlessReminderCheck({ store, notify, now: NOW })
    expect(result.candidates).toBe(0)
    expect(notify).not.toHaveBeenCalled()
  })
})
