import type { ReminderRule, Task, TaskKind, TaskPriority, TaskStatus } from './types'

export interface TaskFilters {
  query?: string
  courseId?: string | null
  status?: TaskStatus | 'all'
  priority?: TaskPriority | 'all'
  kind?: TaskKind | 'all'
}

export type DueBucket = 'overdue' | 'today' | 'soon' | 'upcoming' | 'done'

export function dueBucket(task: Task, now = new Date()): DueBucket {
  if (task.status === 'done') return 'done'
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
  const overdue = openTasks.filter((task) => new Date(task.dueAt).getTime() < now.getTime()).length
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
