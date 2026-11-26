import { describe, expect, it } from 'vitest'
import { UNKNOWN_DUE_AT } from '@shared/constants'
import type { Task } from '@shared/types'
import {
  dashboardOpenCandidates,
  dashboardOverdueCount,
  dashboardPendingReviewCount,
  dashboardPreviewTasks,
  dashboardReviewTasks,
  dashboardVisibleTasks
} from '@shared/dashboard-tasks'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: '作业',
    description: '',
    courseId: 'course-1',
    priority: 'medium',
    kind: 'homework',
    status: 'todo',
    dueAt: '2026-11-19T10:01:00.000Z',
    completedAt: null,
    completionSource: null,
    source: 'chaoxing',
    externalId: 'ext-1',
    sourceUpdatedAt: null,
    sourceUrl: null,
    platformStatus: '未交',
    platformStatusKind: 'not_submitted',
    submittedAt: null,
    score: null,
    fullScore: null,
    teacherFeedback: null,
    attachments: [],
    manualFields: [],
    fieldSources: {},
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    reminders: [],
    ...overrides
  }
}

describe('dashboard task time selection', () => {
  it('keeps missed deadlines in the actionable open queue while visible-now excludes them', () => {
    const tasks = [task()]
    const before = new Date('2026-11-19T10:00:00.000Z')
    const after = new Date('2026-11-19T10:02:00.000Z')

    expect(dashboardOpenCandidates(tasks, before)).toHaveLength(1)
    expect(dashboardVisibleTasks(tasks, before)).toHaveLength(1)
    expect(dashboardOpenCandidates(tasks, after)).toHaveLength(1)
    expect(dashboardVisibleTasks(tasks, after)).toHaveLength(0)
  })

  it('keeps future tasks and excludes platform-processed tasks from the open set', () => {
    const tasks = [
      task({ id: 'future', dueAt: '2026-11-20T10:00:00.000Z' }),
      task({ id: 'pending', platformStatusKind: 'pending_review' }),
      task({ id: 'submitted', platformStatusKind: 'submitted' })
    ]
    const now = new Date('2026-11-19T10:00:00.000Z')
    expect(dashboardOpenCandidates(tasks, now).map((item) => item.id)).toEqual(['future'])
    expect(dashboardVisibleTasks(tasks, now)).toHaveLength(3)
  })

  it('counts only real pending-review homework and excludes reviewed and done', () => {
    const tasks = [
      task({ id: 'submitted', platformStatusKind: 'submitted' }),
      task({ id: 'pending', platformStatusKind: 'pending_review' }),
      task({ id: 'pending-2', platformStatusKind: 'pending_review' }),
      task({ id: 'reviewed', platformStatusKind: 'reviewed' }),
      task({ id: 'done', platformStatusKind: 'done' })
    ]

    expect(dashboardReviewTasks(tasks).map((item) => item.id)).toEqual([
      'submitted',
      'pending',
      'pending-2'
    ])
    expect(dashboardPendingReviewCount(tasks)).toBe(2)
  })

  it('prioritizes upcoming deadlines over old overdue tasks without losing open/overdue counts', () => {
    const now = new Date('2026-11-24T10:00:00.000Z')
    const tasks = [
      task({ id: 'ov-1', dueAt: '2026-10-01T10:00:00.000Z' }),
      task({ id: 'ov-2', dueAt: '2026-10-05T10:00:00.000Z' }),
      task({ id: 'ov-3', dueAt: '2026-10-10T10:00:00.000Z' }),
      task({ id: 'ov-4', dueAt: '2026-10-15T10:00:00.000Z' }),
      task({ id: 'ov-5', dueAt: '2026-11-20T10:00:00.000Z' }),
      task({ id: 'ov-6', dueAt: '2026-11-24T09:30:00.000Z' }),
      task({ id: 'due-15m', dueAt: '2026-11-24T10:15:00.000Z' }),
      task({ id: 'due-2d', dueAt: '2026-11-26T10:00:00.000Z' }),
      task({ id: 'unknown-due', dueAt: UNKNOWN_DUE_AT })
    ]

    expect(dashboardOpenCandidates(tasks, now)).toHaveLength(9)
    expect(dashboardOverdueCount(tasks, now)).toBe(6)
    expect(dashboardPreviewTasks(tasks, now, 6).map((item) => item.id)).toEqual([
      'due-15m',
      'due-2d',
      'ov-6',
      'ov-5',
      'ov-4',
      'ov-3'
    ])
  })

  it('fills preview with most recently overdue tasks when no upcoming tasks exist and puts unknown due last', () => {
    const now = new Date('2026-11-24T10:00:00.000Z')
    const tasks = [
      task({ id: 'unknown', dueAt: UNKNOWN_DUE_AT }),
      task({ id: 'ov-old', dueAt: '2026-10-01T10:00:00.000Z' }),
      task({ id: 'ov-recent', dueAt: '2026-11-24T09:00:00.000Z' })
    ]

    expect(dashboardPreviewTasks(tasks, now, 6).map((item) => item.id)).toEqual([
      'ov-recent',
      'ov-old',
      'unknown'
    ])
    expect(dashboardOverdueCount(tasks, now)).toBe(2)
  })
})
