import type { DueBucket } from '@shared/domain'
import { isDueAtUnknown } from '@shared/domain'
import type { TaskKind, TaskPriority } from '@shared/types'
import { TASK_KIND_LABEL, TASK_PRIORITY_LABEL } from '@shared/constants'

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

const fullDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'short'
})

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

export function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return '时间待确认'
  return dateTimeFormatter.format(date)
}

export function formatDueAt(iso: string): string {
  return isDueAtUnknown(iso) ? '' : formatDateTime(iso)
}

export function formatOptionalDateTime(iso: string | null): string {
  return iso ? formatDateTime(iso) : '—'
}

export function formatFullDate(date: Date | string): string {
  const parsed = typeof date === 'string' ? new Date(date) : date
  if (!Number.isFinite(parsed.getTime())) return '时间待确认'
  return fullDateFormatter.format(parsed)
}

export function formatTime(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return '--:--'
  return timeFormatter.format(date)
}

export function formatShortDay(date: Date): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date)
}

export function formatWeekdayShort(date: Date): string {
  return new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date)
}

export function relativeTime(iso: string): string {
  const timestamp = new Date(iso).getTime()
  if (!Number.isFinite(timestamp)) return '时间未知'
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return formatDateTime(iso)
}

export const BUCKET_LABEL: Record<DueBucket, string> = {
  overdue: '已逾期',
  today: '今天截止',
  soon: '三天内',
  upcoming: '未完成',
  done: '已完成'
}

export function priorityLabel(priority: TaskPriority): string {
  return TASK_PRIORITY_LABEL[priority]
}

export function kindLabel(kind: TaskKind): string {
  return TASK_KIND_LABEL[kind]
}

export function reminderOffsetLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `提前 ${minutes / 1440} 天`
  if (minutes % 60 === 0) return `提前 ${minutes / 60} 小时`
  return `提前 ${minutes} 分钟`
}

export function courseInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '课'
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return '操作失败，请稍后重试'
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
