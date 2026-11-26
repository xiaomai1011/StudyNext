import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ReminderScheduler,
  findDueReminderCandidates,
  findNextReminderAt,
  formatReminderOffset
} from '../../src/main/notifications/scheduler'
import { StudyNextStore } from '../../src/main/storage/store'

let store: StudyNextStore

beforeEach(() => {
  store = new StudyNextStore(':memory:')
})

afterEach(() => {
  store.close()
  vi.useRealTimers()
})

function createTask(dueOffsetMinutes: number, offsetMinutes: number) {
  const dueAt = new Date(Date.now() + dueOffsetMinutes * 60_000).toISOString()
  return store.createTask({
    title: '提醒测试任务',
    description: '',
    courseId: null,
    priority: 'high',
    kind: 'homework',
    dueAt,
    reminderOffsets: [offsetMinutes]
  })
}

describe('DDL 提醒调度', () => {
  it('在提前时间点生成候选，已完成任务不再提醒', () => {
    const now = new Date('2026-11-11T12:00:00+08:00')
    const task = {
      ...createTask(60, 60),
      dueAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
      status: 'todo' as const
    }
    const candidates = findDueReminderCandidates([task], now, {
      catchUp: false,
      catchUpWindowMs: 10 * 60_000,
      lateWindowMs: 2 * 60_000
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.scheduledFor).toBe(now.toISOString())

    const done = { ...task, status: 'done' as const }
    expect(
      findDueReminderCandidates([done], now, {
        catchUp: false,
        catchUpWindowMs: 10 * 60_000,
        lateWindowMs: 2 * 60_000
      })
    ).toHaveLength(0)
  })

  it('超过补发窗口的旧提醒不会突然弹出', () => {
    const task = createTask(120, 60)
    const late = new Date(new Date(task.dueAt).getTime() - 30 * 60_000)
    expect(
      findDueReminderCandidates([task], late, {
        catchUp: false,
        catchUpWindowMs: 10 * 60_000,
        lateWindowMs: 2 * 60_000
      })
    ).toHaveLength(0)
  })

  it('返回下一个未来提醒时间', () => {
    const task = createTask(240, 60)
    const next = findNextReminderAt([task])
    expect(next).toBe(new Date(new Date(task.dueAt).getTime() - 60 * 60_000).toISOString())
    expect(findNextReminderAt([{ ...task, status: 'done' }])).toBeNull()
  })

  it('应用启动时只补发一次，到期提醒不会重复投递', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-11T12:00:00+08:00'))
    store.updateSettings({ notificationsEnabled: true, catchUpMissedReminders: true })
    createTask(60, 60)
    const notify = vi.fn()
    const scheduler = new ReminderScheduler({ store, notify, catchUpWindowMs: 10 * 60_000 })
    expect(scheduler.start()).toBe(1)
    expect(notify).toHaveBeenCalledTimes(1)
    scheduler.stop()

    const restarted = new ReminderScheduler({ store, notify, catchUpWindowMs: 10 * 60_000 })
    expect(restarted.start()).toBe(0)
    expect(notify).toHaveBeenCalledTimes(1)
    restarted.stop()
  })

  it('通知失败时记录持久化重试，下一次 tick 成功后清除', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-11T12:00:00+08:00'))
    createTask(60, 60)
    const notify = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('系统通知不可用')
      })
      .mockImplementation(() => undefined)
    const onSchedulerSettled = vi.fn()
    const scheduler = new ReminderScheduler({ store, notify, onSchedulerSettled })
    expect(scheduler.start()).toBe(0)
    expect(onSchedulerSettled).toHaveBeenCalledTimes(1)
    const task = store.listTasks().find((item) => item.title === '提醒测试任务')!
    const rule = task.reminders[0]!
    const key = `${task.id}:${rule.id}:${task.dueAt}`
    expect(store.hasDelivery(task.id, rule.id, task.dueAt)).toBe(false)
    expect(store.getDeliveryFailure(key)).toMatchObject({
      attemptCount: 1,
      lastError: '系统通知不可用',
      nextRetryAt: '2026-11-11T04:01:00.000Z'
    })
    expect(scheduler.getNextReminderAt()).toBe('2026-11-11T04:01:00.000Z')

    vi.advanceTimersByTime(60_000)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(store.getDeliveryFailure(key)).toBeNull()
    expect(store.hasDelivery(task.id, rule.id, task.dueAt)).toBe(true)
    expect(onSchedulerSettled).toHaveBeenCalledTimes(2)
    scheduler.stop()
  })

  it('提醒文案覆盖预设与自定义时长', () => {
    expect(formatReminderOffset(4320)).toBe('提前 3 天')
    expect(formatReminderOffset(1440)).toBe('提前 1 天')
    expect(formatReminderOffset(180)).toBe('提前 3 小时')
    expect(formatReminderOffset(90)).toBe('提前 90 分钟')
  })
})
