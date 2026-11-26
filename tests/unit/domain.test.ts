import { describe, expect, it } from 'vitest'
import {
  computeTaskStats,
  dueBucket,
  filterTasks,
  formatRemainingCompact,
  isPlatformTaskDone,
  isPlatformTaskSubmitted,
  isSyncStale,
  normalizeReminderOffsets,
  sortTasksByDue
} from '@shared/domain'
import type { Task } from '@shared/types'

const NOW = new Date('2026-11-11T12:00:00+08:00')

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: crypto.randomUUID(),
    title: '默认任务',
    description: '',
    courseId: null,
    priority: 'medium',
    kind: 'homework',
    status: 'todo',
    dueAt: '2026-11-12T22:00:00+08:00',
    completedAt: null,
    source: 'manual',
    externalId: null,
    completionSource: null,
    sourceUpdatedAt: null,
    manualFields: [],
    fieldSources: {},
    sourceUrl: null,
    platformStatus: null,
    platformStatusKind: 'unknown',
    submittedAt: null,
    score: null,
    fullScore: null,
    teacherFeedback: null,
    attachments: [],
    createdAt: '2026-11-01T10:00:00+08:00',
    updatedAt: '2026-11-01T10:00:00+08:00',
    reminders: [],
    ...overrides
  }
}

describe('任务领域逻辑', () => {
  it('按 DDL 升序排序，同一时间按优先级排序', () => {
    const late = task({ title: '较晚', dueAt: '2026-11-20T10:00:00+08:00' })
    const earlyLow = task({
      title: '较早低优先级',
      dueAt: '2026-11-12T10:00:00+08:00',
      priority: 'low'
    })
    const earlyHigh = task({
      title: '较早高优先级',
      dueAt: '2026-11-12T10:00:00+08:00',
      priority: 'high'
    })
    expect(sortTasksByDue([late, earlyLow, earlyHigh]).map((item) => item.title)).toEqual([
      '较早高优先级',
      '较早低优先级',
      '较晚'
    ])
  })

  it('将任务归入逾期、今天、三天内、以后与已完成', () => {
    expect(dueBucket(task({ dueAt: '2026-11-11T11:00:00+08:00' }), NOW)).toBe('overdue')
    expect(dueBucket(task({ dueAt: '2026-11-11T20:00:00+08:00' }), NOW)).toBe('today')
    expect(dueBucket(task({ dueAt: '2026-11-13T20:00:00+08:00' }), NOW)).toBe('soon')
    expect(dueBucket(task({ dueAt: '2026-11-30T20:00:00+08:00' }), NOW)).toBe('upcoming')
    expect(dueBucket(task({ status: 'done' }), NOW)).toBe('done')
  })

  it('按关键词、课程、状态与优先级组合筛选', () => {
    const tasks = [
      task({ title: '数据库实验报告', courseId: 'course-a', priority: 'high' }),
      task({ title: '英语听力', courseId: 'course-b', priority: 'low' }),
      task({ title: '整理笔记', courseId: null, status: 'done' })
    ]
    expect(filterTasks(tasks, { query: '实验', courseId: 'course-a' })).toHaveLength(1)
    expect(filterTasks(tasks, { status: 'done' })).toHaveLength(1)
    expect(filterTasks(tasks, { priority: 'low' })).toHaveLength(1)
    expect(filterTasks(tasks, { courseId: null }).map((item) => item.title)).toEqual(['整理笔记'])
  })

  it('计算待办、逾期、今日截止与完成率统计', () => {
    const stats = computeTaskStats(
      [
        task({ dueAt: '2026-11-11T09:00:00+08:00' }),
        task({ dueAt: '2026-11-11T21:00:00+08:00' }),
        task({ dueAt: '2026-11-13T21:00:00+08:00' }),
        task({ status: 'done', completedAt: NOW.toISOString() })
      ],
      NOW
    )
    expect(stats.total).toBe(4)
    expect(stats.open).toBe(3)
    expect(stats.completed).toBe(1)
    expect(stats.overdue).toBe(1)
    expect(stats.dueToday).toBe(2)
    expect(stats.dueThisWeek).toBe(2)
    expect(stats.completionRate).toBe(25)
  })

  it('提醒规则去重、取整、过滤越界值并倒序', () => {
    expect(normalizeReminderOffsets([60, 1440, 60, 4, 99, 43201, 180.4])).toEqual([
      1440, 180, 99, 60
    ])
  })

  it('剩余时间在跨天时给出紧凑中文文案', () => {
    expect(formatRemainingCompact('2026-11-11T13:20:00+08:00', NOW)).toBe('1 小时 20 分钟后截止')
    expect(formatRemainingCompact('2026-11-11T10:00:00+08:00', NOW)).toBe('已逾期 2 小时')
    expect(formatRemainingCompact('2026-11-13T14:00:00+08:00', NOW)).toBe('2 天 2 小时后截止')
  })
})

describe('平台作业完成状态', () => {
  it('只有已批阅和已完成算本地完成', () => {
    expect(isPlatformTaskDone('not_submitted')).toBe(false)
    expect(isPlatformTaskDone('unknown')).toBe(false)
    expect(isPlatformTaskDone('submitted')).toBe(false)
    expect(isPlatformTaskDone('pending_review')).toBe(false)
    expect(isPlatformTaskDone('reviewed')).toBe(true)
    expect(isPlatformTaskDone('done')).toBe(true)
  })

  it('已提交、待审核、已批阅和已完成都算已提交平台', () => {
    expect(isPlatformTaskSubmitted('not_submitted')).toBe(false)
    expect(isPlatformTaskSubmitted('unknown')).toBe(false)
    expect(isPlatformTaskSubmitted('submitted')).toBe(true)
    expect(isPlatformTaskSubmitted('pending_review')).toBe(true)
    expect(isPlatformTaskSubmitted('reviewed')).toBe(true)
    expect(isPlatformTaskSubmitted('done')).toBe(true)
  })
})

describe('同步新鲜度', () => {
  const now = Date.parse('2026-11-15T00:00:00+08:00')

  it('按分钟间隔判断是否过期', () => {
    expect(isSyncStale(null, 5, now)).toBe(true)
    expect(isSyncStale('not-a-date', 5, now)).toBe(true)
    expect(isSyncStale(new Date(now - 4 * 60_000).toISOString(), 5, now)).toBe(false)
    expect(isSyncStale(new Date(now - 5 * 60_000).toISOString(), 5, now)).toBe(true)
    expect(isSyncStale(new Date(now - 60 * 60_000).toISOString(), 5, now)).toBe(true)
  })

  it('关闭自动刷新时永不过期', () => {
    expect(isSyncStale(null, 0, now)).toBe(false)
    expect(isSyncStale(new Date(now - 24 * 60 * 60_000).toISOString(), 0, now)).toBe(false)
  })
})
