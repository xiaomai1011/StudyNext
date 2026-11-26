import type { Task, TaskPriority } from './types'
import { dueBucket, isDueAtUnknown, sortTasksByDue } from './domain'
import { isTaskActionable } from './task-state'

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  high: 0,
  medium: 1,
  low: 2
}

export function dashboardVisibleTasks(tasks: Task[], now: Date): Task[] {
  return tasks.filter((task) => !(task.status === 'todo' && dueBucket(task, now) === 'overdue'))
}

export function dashboardOpenCandidates(tasks: Task[], _now: Date): Task[] {
  // Keep overdue items in the open queue so the dashboard cannot hide a missed
  // deadline; only genuinely actionable tasks belong here.
  return tasks.filter((task) => isTaskActionable(task))
}

/**
 * Selects up to `limit` actionable tasks for the Dashboard preview without
 * letting historical overdue items crowd out still-submittable upcoming work:
 * 1. Upcoming tasks with a concrete deadline (soonest due first).
 * 2. Overdue tasks (most recently missed first) in remaining slots.
 * 3. Actionable tasks with unknown due dates last.
 */
export function dashboardPreviewTasks(tasks: Task[], now: Date, limit = 6): Task[] {
  if (limit <= 0) return []
  const candidates = dashboardOpenCandidates(tasks, now)
  const nowMs = now.getTime()
  const upcoming: Task[] = []
  const overdue: Task[] = []
  const unknownDue: Task[] = []

  for (const task of candidates) {
    if (isDueAtUnknown(task.dueAt)) {
      unknownDue.push(task)
      continue
    }
    const dueMs = Date.parse(task.dueAt)
    if (!Number.isFinite(dueMs)) {
      unknownDue.push(task)
    } else if (dueMs < nowMs) {
      overdue.push(task)
    } else {
      upcoming.push(task)
    }
  }

  const sortedUpcoming = sortTasksByDue(upcoming)
  const sortedOverdue = [...overdue].sort((a, b) => {
    const dueDiff = Date.parse(b.dueAt) - Date.parse(a.dueAt)
    if (dueDiff !== 0) return dueDiff
    return PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority]
  })
  const sortedUnknown = [...unknownDue].sort(
    (a, b) => PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority]
  )

  return [...sortedUpcoming, ...sortedOverdue, ...sortedUnknown].slice(0, limit)
}

export function dashboardOverdueCount(tasks: Task[], now: Date): number {
  return dashboardOpenCandidates(tasks, now).filter((task) => dueBucket(task, now) === 'overdue')
    .length
}

/** Submitted or pending-review homework that belongs in the waiting-for-feedback block. */
export function dashboardReviewTasks(tasks: Task[]): Task[] {
  return tasks.filter(
    (task) =>
      task.source === 'chaoxing' &&
      (task.platformStatusKind === 'pending_review' || task.platformStatusKind === 'submitted')
  )
}

/** Only pending_review is "待审核"; submitted, reviewed and done must not inflate this count. */
export function dashboardPendingReviewCount(tasks: Task[]): number {
  return tasks.filter((task) => task.platformStatusKind === 'pending_review').length
}
