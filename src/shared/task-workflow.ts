import type { Course, PlatformStatusKind, Task, TaskPriority } from './types'
import {
  dueBucket,
  filterTasks,
  formatRemainingCompact,
  isDueAtUnknown,
  sortTasksByDue
} from './domain'
import {
  getTaskScoreView,
  isTaskActionable,
  platformStatusLabel,
  type TaskStatusView
} from './task-state'

export type TaskStatusFilter = 'all' | 'todo' | 'done' | 'review' | 'submitted' | 'reviewed'
export type TaskDeadlineFilter = 'all' | 'overdue' | 'today' | 'three_days' | 'week' | 'no_due'
export type TaskSortMode = 'due' | 'created' | 'priority'

export type RecordFilter =
  | 'all'
  | 'not_submitted'
  | 'submitted'
  | 'pending_review'
  | 'reviewed'
  | 'done'
export type RecordSortMode = 'updated' | 'due'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export interface TaskWorkflowSummary {
  total: number
  actionableTotal: number
  overdueActionable: number
  dueTodayActionable: number
  dueThreeDaysActionable: number
  dueWeekActionable: number
  noDueActionable: number
  pendingReview: number
  submitted: number
  reviewed: number
  completed: number
  gradedCount: number
  withFeedbackCount: number
  nextUrgentTask: Task | null
}

export interface TaskDeadlineGroup {
  bucket: 'overdue' | 'today' | 'soon' | 'upcoming' | 'review' | 'submitted' | 'reviewed' | 'done'
  label: string
  items: Task[]
}

export interface TaskFilterOptions {
  query: string
  status: TaskStatusFilter
  deadline: TaskDeadlineFilter
  courseId: string
  priority: TaskPriority | 'all'
  sortMode: TaskSortMode
}

export interface RecordFilterOptions {
  filter: RecordFilter
  courseId: string
  keyword: string
  gradedOnly: boolean
  feedbackOnly: boolean
  sortMode: RecordSortMode
}

export interface RecordQuickCounts {
  graded: number
  withFeedback: number
}

export interface TaskDetailDueBanner {
  label: string
  tone: 'overdue' | 'today' | 'soon' | 'upcoming' | 'settled'
}

const PRIORITY_WEIGHT: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 }

const NON_DONE_TERMINAL_PLATFORM: ReadonlySet<PlatformStatusKind> = new Set([
  'submitted',
  'pending_review',
  'reviewed'
])

/** Local completion is a separate axis; reviewed/submitted/pending_review tasks must not leak into done. */
export function isRecordTask(task: Pick<Task, 'source' | 'kind'>): boolean {
  return task.source === 'chaoxing' && task.kind === 'homework'
}

export function isTaskCompleted(task: Pick<Task, 'status' | 'platformStatusKind'>): boolean {
  if (task.platformStatusKind === 'done') return true
  if (NON_DONE_TERMINAL_PLATFORM.has(task.platformStatusKind)) return false
  return task.status === 'done'
}

export function isTaskActiveTodo(task: Pick<Task, 'status' | 'platformStatusKind'>): boolean {
  return isTaskActionable(task)
}

/** True only when the task is still actionable AND its real deadline has already passed. */
export function isTaskActionableOverdue(task: Task, now = new Date()): boolean {
  return isTaskActionable(task) && dueBucket(task, now) === 'overdue'
}

function dueTimeMs(dueAt: string): number {
  const ms = Date.parse(dueAt)
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
}

function comparePriorityAndTitle(a: Task, b: Task): number {
  const diff = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority]
  if (diff !== 0) return diff
  return a.title.localeCompare(b.title, 'zh-CN')
}

export function matchesTaskDeadlineFilter(
  task: Task,
  deadline: TaskDeadlineFilter,
  now = new Date()
): boolean {
  if (deadline === 'all') return true
  if (!isTaskActionable(task)) return false

  if (deadline === 'no_due') {
    return isDueAtUnknown(task.dueAt)
  }
  if (isDueAtUnknown(task.dueAt)) {
    return false
  }

  const bucket = dueBucket(task, now)
  if (deadline === 'overdue') return bucket === 'overdue'
  if (deadline === 'today') return bucket === 'today'
  if (deadline === 'three_days') return bucket === 'today' || bucket === 'soon'

  const dueMs = dueTimeMs(task.dueAt)
  const nowMs = now.getTime()
  return dueMs >= nowMs && dueMs < nowMs + SEVEN_DAYS_MS
}

export function pickNextUrgentTask(tasks: Task[], now = new Date()): Task | null {
  const actionable = tasks.filter(isTaskActionable)
  if (actionable.length === 0) return null

  const nowMs = now.getTime()
  const upcoming = actionable
    .filter((task) => !isDueAtUnknown(task.dueAt) && dueTimeMs(task.dueAt) >= nowMs)
    .sort((a, b) => {
      const dueDiff = dueTimeMs(a.dueAt) - dueTimeMs(b.dueAt)
      return dueDiff !== 0 ? dueDiff : comparePriorityAndTitle(a, b)
    })
  if (upcoming.length > 0) return upcoming[0] ?? null

  const overdue = actionable
    .filter((task) => !isDueAtUnknown(task.dueAt) && dueTimeMs(task.dueAt) < nowMs)
    .sort((a, b) => {
      const dueDiff = dueTimeMs(b.dueAt) - dueTimeMs(a.dueAt)
      return dueDiff !== 0 ? dueDiff : comparePriorityAndTitle(a, b)
    })
  if (overdue.length > 0) return overdue[0] ?? null

  const unknownDue = [...actionable].sort((a, b) => {
    const prioDiff = comparePriorityAndTitle(a, b)
    if (prioDiff !== 0) return prioDiff
    return b.updatedAt.localeCompare(a.updatedAt)
  })
  return unknownDue[0] ?? null
}

export function summarizeTaskWorkflow(tasks: Task[], now = new Date()): TaskWorkflowSummary {
  let actionableTotal = 0
  let overdueActionable = 0
  let dueTodayActionable = 0
  let dueThreeDaysActionable = 0
  let dueWeekActionable = 0
  let noDueActionable = 0
  let pendingReview = 0
  let submitted = 0
  let reviewed = 0
  let completed = 0
  let gradedCount = 0
  let withFeedbackCount = 0

  const nowMs = now.getTime()
  const weekEndMs = nowMs + SEVEN_DAYS_MS

  for (const task of tasks) {
    if (task.platformStatusKind === 'pending_review') pendingReview += 1
    if (task.platformStatusKind === 'submitted') submitted += 1
    if (task.platformStatusKind === 'reviewed') reviewed += 1
    if (isTaskCompleted(task)) completed += 1
    if (isRecordTask(task) && getTaskScoreView(task).state === 'graded') gradedCount += 1
    if (isRecordTask(task) && task.teacherFeedback && task.teacherFeedback.trim().length > 0) {
      withFeedbackCount += 1
    }

    if (!isTaskActionable(task)) continue
    actionableTotal += 1

    if (isDueAtUnknown(task.dueAt)) {
      noDueActionable += 1
      continue
    }

    const bucket = dueBucket(task, now)
    if (bucket === 'overdue') {
      overdueActionable += 1
      continue
    }
    if (bucket === 'today') {
      dueTodayActionable += 1
      dueThreeDaysActionable += 1
    } else if (bucket === 'soon') {
      dueThreeDaysActionable += 1
    }
    const dueMs = dueTimeMs(task.dueAt)
    if (dueMs >= nowMs && dueMs < weekEndMs) {
      dueWeekActionable += 1
    }
  }

  return {
    total: tasks.length,
    actionableTotal,
    overdueActionable,
    dueTodayActionable,
    dueThreeDaysActionable,
    dueWeekActionable,
    noDueActionable,
    pendingReview,
    submitted,
    reviewed,
    completed,
    gradedCount,
    withFeedbackCount,
    nextUrgentTask: pickNextUrgentTask(tasks, now)
  }
}

export function filterAndSortWorkflowTasks(
  tasks: Task[],
  options: TaskFilterOptions,
  now = new Date()
): Task[] {
  const localStatus =
    options.status === 'todo' || options.status === 'done' ? options.status : 'all'
  let base = filterTasks(tasks, {
    query: options.query,
    status: localStatus,
    priority: options.priority,
    ...(options.courseId !== 'all' ? { courseId: options.courseId } : {})
  })
  if (options.status === 'todo') {
    base = base.filter(isTaskActiveTodo)
  } else if (options.status === 'done') {
    base = base.filter(isTaskCompleted)
  } else if (options.status === 'review') {
    base = base.filter((task) => task.platformStatusKind === 'pending_review')
  } else if (options.status === 'submitted') {
    base = base.filter((task) => task.platformStatusKind === 'submitted')
  } else if (options.status === 'reviewed') {
    base = base.filter((task) => task.platformStatusKind === 'reviewed')
  }

  const scoped =
    options.deadline === 'all'
      ? base
      : base.filter((task) => matchesTaskDeadlineFilter(task, options.deadline, now))

  if (options.sortMode === 'created') {
    return [...scoped].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
  }
  if (options.sortMode === 'priority') {
    return [...scoped].sort((a, b) => {
      const diff = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority]
      return diff !== 0 ? diff : dueTimeMs(a.dueAt) - dueTimeMs(b.dueAt)
    })
  }
  if (options.deadline === 'overdue') {
    return [...scoped].sort((a, b) => {
      const dueDiff = dueTimeMs(b.dueAt) - dueTimeMs(a.dueAt)
      return dueDiff !== 0 ? dueDiff : comparePriorityAndTitle(a, b)
    })
  }
  return sortTasksByDue(scoped)
}

export function buildTaskDeadlineGroups(
  tasks: Task[],
  now = new Date(),
  options?: { prioritizeOverdue?: boolean }
): TaskDeadlineGroup[] {
  const grouped: TaskDeadlineGroup[] = []
  const regularItems = tasks.filter((task) => isTaskActionable(task))
  const todayItems = regularItems.filter((task) => dueBucket(task, now) === 'today')
  const soonItems = regularItems.filter((task) => dueBucket(task, now) === 'soon')
  const upcomingItems = regularItems.filter((task) => dueBucket(task, now) === 'upcoming')
  const overdueItems = regularItems
    .filter((task) => dueBucket(task, now) === 'overdue')
    .sort((a, b) => {
      const dueDiff = dueTimeMs(b.dueAt) - dueTimeMs(a.dueAt)
      return dueDiff !== 0 ? dueDiff : comparePriorityAndTitle(a, b)
    })

  if (options?.prioritizeOverdue) {
    if (overdueItems.length > 0)
      grouped.push({ bucket: 'overdue', label: '已逾期', items: overdueItems })
    if (todayItems.length > 0)
      grouped.push({ bucket: 'today', label: '今天截止', items: todayItems })
    if (soonItems.length > 0)
      grouped.push({ bucket: 'soon', label: '3 天内截止', items: soonItems })
    if (upcomingItems.length > 0)
      grouped.push({ bucket: 'upcoming', label: '稍后截止', items: upcomingItems })
  } else {
    if (todayItems.length > 0)
      grouped.push({ bucket: 'today', label: '今天截止', items: todayItems })
    if (soonItems.length > 0)
      grouped.push({ bucket: 'soon', label: '3 天内截止', items: soonItems })
    if (overdueItems.length > 0)
      grouped.push({ bucket: 'overdue', label: '已逾期', items: overdueItems })
    if (upcomingItems.length > 0)
      grouped.push({ bucket: 'upcoming', label: '稍后截止', items: upcomingItems })
  }

  const reviewItems = tasks.filter((task) => task.platformStatusKind === 'pending_review')
  if (reviewItems.length > 0) {
    grouped.push({ bucket: 'review', label: '待审核', items: reviewItems })
  }
  const submittedItems = tasks.filter((task) => task.platformStatusKind === 'submitted')
  if (submittedItems.length > 0) {
    grouped.push({ bucket: 'submitted', label: '已提交', items: submittedItems })
  }
  const reviewedItems = tasks.filter((task) => task.platformStatusKind === 'reviewed')
  if (reviewedItems.length > 0) {
    grouped.push({ bucket: 'reviewed', label: '已批阅', items: reviewedItems })
  }
  const completedItems = tasks.filter(isTaskCompleted)
  if (completedItems.length > 0) {
    grouped.push({ bucket: 'done', label: '已完成', items: completedItems })
  }
  return grouped
}

/**
 * Computes the compact due caption shown under the due date in `Tasks.tsx`.
 * Preserves exact `'截止已过'` for non-actionable overdue tasks (e.g. `pending_review`)
 * while surfacing live relative countdowns for actionable assignments.
 */
export function formatTaskRowDueCaption(
  task: Task,
  statusView: Pick<TaskStatusView, 'bucket' | 'overdue'>,
  now = new Date()
): string {
  if (isDueAtUnknown(task.dueAt)) return '无截止时间'
  if (statusView.overdue) {
    return isTaskActionable(task) ? formatRemainingCompact(task.dueAt, now) : '截止已过'
  }
  if (isTaskCompleted(task)) return ''
  if (isTaskActionable(task)) {
    return formatRemainingCompact(task.dueAt, now)
  }
  if (statusView.bucket === 'today') return '今天截止'
  if (statusView.bucket === 'soon') return '三天内'
  if (statusView.bucket === 'upcoming') return '稍后'
  return ''
}

export function getTaskDetailDueBanner(task: Task, now = new Date()): TaskDetailDueBanner {
  const unknownDue = isDueAtUnknown(task.dueAt)
  const remaining = unknownDue ? '' : formatRemainingCompact(task.dueAt, now)

  if (!isTaskActionable(task)) {
    const stateLabel =
      task.source === 'chaoxing'
        ? platformStatusLabel(task.platformStatusKind)
        : task.status === 'done'
          ? '已完成'
          : '未完成'
    if (unknownDue) {
      return { label: stateLabel, tone: 'settled' }
    }
    const pastDue = dueTimeMs(task.dueAt) < now.getTime()
    return {
      label: pastDue ? `${stateLabel} · 截止已过` : `${stateLabel} · ${remaining}`,
      tone: 'settled'
    }
  }

  if (unknownDue) {
    return { label: '无明确截止时间', tone: 'upcoming' }
  }

  const bucket = dueBucket(task, now)
  if (bucket === 'overdue') {
    return { label: remaining || '已逾期', tone: 'overdue' }
  }
  if (bucket === 'today') {
    return { label: `今天截止 · ${remaining}`, tone: 'today' }
  }
  if (bucket === 'soon') {
    return { label: `3 天内截止 · ${remaining}`, tone: 'soon' }
  }
  return { label: `稍后截止 · ${remaining}`, tone: 'upcoming' }
}

export function summarizeRecordQuickCounts(homeworkTasks: Task[]): RecordQuickCounts {
  let graded = 0
  let withFeedback = 0
  for (const task of homeworkTasks) {
    if (getTaskScoreView(task).state === 'graded') graded += 1
    if (task.teacherFeedback && task.teacherFeedback.trim().length > 0) withFeedback += 1
  }
  return { graded, withFeedback }
}

export function filterAndSortRecords(
  homeworkTasks: Task[],
  courses: Course[],
  options: RecordFilterOptions
): Task[] {
  const courseById = new Map(courses.map((course) => [course.id, course]))
  const normalized = options.keyword.trim().toLowerCase()

  const filtered = homeworkTasks
    .filter((task) =>
      options.filter === 'all' ? true : task.platformStatusKind === options.filter
    )
    .filter((task) => (options.courseId === 'all' ? true : task.courseId === options.courseId))
    .filter((task) => (options.gradedOnly ? getTaskScoreView(task).state === 'graded' : true))
    .filter((task) =>
      options.feedbackOnly ? Boolean(task.teacherFeedback && task.teacherFeedback.trim()) : true
    )
    .filter((task) => {
      if (!normalized) return true
      const course = task.courseId ? courseById.get(task.courseId) : null
      return (
        task.title.toLowerCase().includes(normalized) ||
        (course?.name ?? '').toLowerCase().includes(normalized) ||
        (course?.className ?? '').toLowerCase().includes(normalized) ||
        (task.teacherFeedback ?? '').toLowerCase().includes(normalized)
      )
    })

  if (options.sortMode === 'due') {
    return [...filtered].sort((a, b) => {
      const aUnknown = isDueAtUnknown(a.dueAt)
      const bUnknown = isDueAtUnknown(b.dueAt)
      if (aUnknown !== bUnknown) return aUnknown ? 1 : -1
      const diff = dueTimeMs(a.dueAt) - dueTimeMs(b.dueAt)
      if (diff !== 0) return diff
      return (b.submittedAt ?? b.updatedAt).localeCompare(a.submittedAt ?? a.updatedAt)
    })
  }

  return [...filtered].sort((a, b) =>
    (b.submittedAt ?? b.updatedAt).localeCompare(a.submittedAt ?? a.updatedAt)
  )
}
