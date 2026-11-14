import type {
  Course,
  CourseSession,
  PlatformStatusKind,
  ReminderRule,
  Task,
  TaskKind,
  TaskPriority,
  TaskStatus
} from './types'
import { UNKNOWN_DUE_AT } from './constants'

export function isPlatformTaskDone(kind: PlatformStatusKind): boolean {
  return kind === 'submitted' || kind === 'pending_review' || kind === 'reviewed' || kind === 'done'
}

export interface TaskFilters {
  query?: string
  courseId?: string | null
  status?: TaskStatus | 'all'
  priority?: TaskPriority | 'all'
  kind?: TaskKind | 'all'
}

export type DueBucket = 'overdue' | 'today' | 'soon' | 'upcoming' | 'done'

const UNKNOWN_DUE_MS = Date.parse(UNKNOWN_DUE_AT)

export function isDueAtUnknown(dueAt: string): boolean {
  const due = Date.parse(dueAt)
  return !Number.isFinite(due) || due >= UNKNOWN_DUE_MS
}

export function dueBucket(task: Task, now = new Date()): DueBucket {
  if (task.status === 'done') return 'done'
  if (isDueAtUnknown(task.dueAt)) return 'upcoming'
  const due = new Date(task.dueAt).getTime()
  if (!Number.isFinite(due)) return 'upcoming'
  if (due < now.getTime()) return 'overdue'
  if (isSameLocalDay(new Date(due), now)) return 'today'
  if (due - now.getTime() <= 72 * 60 * 60 * 1000) return 'soon'
  return 'upcoming'
}

export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

export function startOfLocalDay(date: Date): Date {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

export function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

export function minutesUntil(dueAt: string, now = new Date()): number {
  return Math.ceil((new Date(dueAt).getTime() - now.getTime()) / 60_000)
}

export function formatRemainingCompact(dueAt: string, now = new Date()): string {
  if (isDueAtUnknown(dueAt)) return '截止时间待确认'
  const diff = new Date(dueAt).getTime() - now.getTime()
  if (!Number.isFinite(diff)) return '时间待确认'
  if (diff < 0) {
    const mins = Math.abs(Math.floor(diff / 60_000))
    if (mins < 60) return `已逾期 ${mins} 分钟`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `已逾期 ${hours} 小时`
    return `已逾期 ${Math.floor(hours / 24)} 天`
  }
  const mins = Math.ceil(diff / 60_000)
  if (mins < 60) return `${mins} 分钟后截止`
  const hours = Math.floor(mins / 60)
  if (hours < 24) {
    const rest = mins % 60
    return rest > 0 ? `${hours} 小时 ${rest} 分钟后截止` : `${hours} 小时后截止`
  }
  const days = Math.floor(hours / 24)
  const rest = hours % 24
  return rest > 0 ? `${days} 天 ${rest} 小时后截止` : `${days} 天后截止`
}

export function sortTasksByDue(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const dueDiff = new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()
    if (dueDiff !== 0) return dueDiff
    const weight: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 }
    return weight[a.priority] - weight[b.priority]
  })
}

export function filterTasks(tasks: Task[], filters: TaskFilters): Task[] {
  const query = filters.query?.trim().toLocaleLowerCase() ?? ''
  return tasks.filter((task) => {
    if (query) {
      const haystack = `${task.title} ${task.description}`.toLocaleLowerCase()
      if (!haystack.includes(query)) return false
    }
    if (filters.courseId !== undefined && filters.courseId !== null) {
      if (task.courseId !== filters.courseId) return false
    }
    if (filters.courseId === null && task.courseId !== null) return false
    if (filters.status && filters.status !== 'all' && task.status !== filters.status) return false
    if (filters.priority && filters.priority !== 'all' && task.priority !== filters.priority) {
      return false
    }
    if (filters.kind && filters.kind !== 'all' && task.kind !== filters.kind) return false
    return true
  })
}

export interface TaskStats {
  total: number
  open: number
  completed: number
  overdue: number
  dueToday: number
  dueThisWeek: number
  completionRate: number
}

export function computeTaskStats(tasks: Task[], now = new Date()): TaskStats {
  const start = startOfLocalDay(now)
  const todayEnd = addLocalDays(start, 1).getTime()
  const weekEnd = addLocalDays(start, 7).getTime()
  const openTasks = tasks.filter((task) => task.status === 'todo')
  const completed = tasks.length - openTasks.length
  const dueToday = openTasks.filter((task) => {
    const due = new Date(task.dueAt).getTime()
    return due >= start.getTime() && due < todayEnd
  }).length
  const overdue = openTasks.filter(
    (task) => !isDueAtUnknown(task.dueAt) && new Date(task.dueAt).getTime() < now.getTime()
  ).length
  const dueThisWeek = openTasks.filter((task) => {
    const due = new Date(task.dueAt).getTime()
    return due >= now.getTime() && due < weekEnd
  }).length
  return {
    total: tasks.length,
    open: openTasks.length,
    completed,
    overdue,
    dueToday,
    dueThisWeek,
    completionRate: tasks.length === 0 ? 0 : Math.round((completed / tasks.length) * 100)
  }
}

/** 判断课表周次串（"1-16"、"1,3,5-8"）是否包含某一周。空串视为每周。 */
export function weekInSchedule(spec: string, week: number): boolean {
  const text = spec.trim()
  if (!text) return true
  for (const part of text.split(',')) {
    const token = part.trim()
    if (!token) continue
    const [fromText, toText] = token.split('-')
    const from = Number(fromText)
    const to = Number(toText ?? fromText)
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    if (week >= from && week <= to) return true
  }
  return false
}

/** 以学期第 1 周周一（YYYY-MM-DD，北京时间）为锚点计算某天是第几周。 */
export function semesterWeekOf(date: Date, semesterStart: string | null | undefined): number | null {
  if (!semesterStart) return null
  const start = new Date(`${semesterStart}T00:00:00+08:00`)
  if (!Number.isFinite(start.getTime())) return null
  const day = new Date(date)
  day.setHours(0, 0, 0, 0)
  return Math.floor((day.getTime() - start.getTime()) / 604_800_000) + 1
}

/** 同一课程可能对应多个教学班，课表节次完全相同时界面只展示一次。 */
export function dedupeCourseSessions(
  items: Array<{ course: Course; session: CourseSession }>
): Array<{ course: Course; session: CourseSession }> {
  const seen = new Set<string>()
  const result: Array<{ course: Course; session: CourseSession }> = []
  for (const item of items) {
    const key = [
      item.course.name,
      item.session.weekday,
      item.session.startTime,
      item.session.endTime,
      item.session.location
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

export function normalizeReminderOffsets(offsets: number[]): number[] {
  return [...new Set(offsets)]
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.round(value))
    .filter((value) => value >= 5 && value <= 60 * 24 * 30)
    .sort((a, b) => b - a)
}

export function activeReminderRules(task: Task): ReminderRule[] {
  return task.reminders
    .filter((rule) => rule.enabled)
    .sort((a, b) => b.offsetMinutes - a.offsetMinutes)
}

export function toDateTimeLocalValue(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function fromDateTimeLocalValue(value: string): string {
  const date = new Date(value)
  return date.toISOString()
}
