import { REMINDER_PRESETS } from '@shared/constants'
import type { ReminderFiredEvent, Task } from '@shared/types'
import type { StudyNextStore } from '../storage/store'

export interface ReminderCandidate {
  task: Task
  ruleId: string
  offsetMinutes: number
  scheduledFor: string
  dueAt: string
}

export interface ReminderSchedulerOptions {
  store: StudyNextStore
  notify: (event: ReminderFiredEvent) => void
  onSchedulerEvent?: (event: ReminderFiredEvent) => void
  tickMs?: number
  catchUpWindowMs?: number
  lateWindowMs?: number
  now?: () => Date
}

export interface NotificationScheduler {
  start(): number
  stop(): void
  refresh(): void
  getStartupCatchUpCount(): number
  getNextReminderAt(): string | null
}

export type NotificationSchedulerFactory = (
  options: ReminderSchedulerOptions
) => NotificationScheduler

export function createNotificationScheduler(
  options: ReminderSchedulerOptions
): NotificationScheduler {
  return new ReminderScheduler(options)
}

export function formatReminderOffset(offsetMinutes: number): string {
  const preset = REMINDER_PRESETS.find((item) => item.minutes === offsetMinutes)
  if (preset) return preset.label
  if (offsetMinutes % 1440 === 0) return `提前 ${offsetMinutes / 1440} 天`
  if (offsetMinutes % 60 === 0) return `提前 ${offsetMinutes / 60} 小时`
  return `提前 ${offsetMinutes} 分钟`
}

export function findDueReminderCandidates(
  tasks: Task[],
  now: Date,
  options: { catchUpWindowMs: number; lateWindowMs: number; catchUp: boolean }
): ReminderCandidate[] {
  const candidates: ReminderCandidate[] = []
  const nowMs = now.getTime()
  for (const task of tasks) {
    if (task.status !== 'todo') continue
    const dueMs = Date.parse(task.dueAt)
    if (!Number.isFinite(dueMs) || dueMs <= nowMs) continue
    for (const rule of task.reminders) {
      if (!rule.enabled) continue
      const scheduledMs = dueMs - rule.offsetMinutes * 60_000
      if (scheduledMs > nowMs) continue
      const lateBy = nowMs - scheduledMs
      const window = options.catchUp ? options.catchUpWindowMs : options.lateWindowMs
      if (lateBy > window) continue
      candidates.push({
        task,
        ruleId: rule.id,
        offsetMinutes: rule.offsetMinutes,
        scheduledFor: new Date(scheduledMs).toISOString(),
        dueAt: task.dueAt
      })
    }
  }
  return candidates
}

export function findNextReminderAt(tasks: Task[], now = new Date()): string | null {
  let next: number | null = null
  for (const task of tasks) {
    if (task.status !== 'todo') continue
    const dueMs = Date.parse(task.dueAt)
    if (!Number.isFinite(dueMs) || dueMs <= now.getTime()) continue
    for (const rule of task.reminders) {
      if (!rule.enabled) continue
      const scheduled = dueMs - rule.offsetMinutes * 60_000
      if (scheduled <= now.getTime()) continue
      if (next === null || scheduled < next) next = scheduled
    }
  }
  return next === null ? null : new Date(next).toISOString()
}

/**
 * The scheduler only runs while the Electron main process is alive. It never
 * claims that notifications remain scheduled after the application quits.
 */
export class ReminderScheduler implements NotificationScheduler {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private startupCatchUpCount = 0
  private readonly now: () => Date
  private readonly tickMs: number
  private readonly catchUpWindowMs: number
  private readonly lateWindowMs: number

  constructor(private readonly options: ReminderSchedulerOptions) {
    this.now = options.now ?? (() => new Date())
    this.tickMs = options.tickMs ?? 30_000
    this.catchUpWindowMs = options.catchUpWindowMs ?? 10 * 60_000
    this.lateWindowMs = options.lateWindowMs ?? 2 * 60_000
  }

  start(): number {
    if (this.running) return this.startupCatchUpCount
    this.running = true
    const settings = this.options.store.getSettings()
    if (!settings.notificationsEnabled) {
      this.startupCatchUpCount = 0
    } else {
      this.startupCatchUpCount = this.deliver(
        findDueReminderCandidates(this.options.store.listTasks(), this.now(), {
          catchUp: settings.catchUpMissedReminders,
          catchUpWindowMs: this.catchUpWindowMs,
          lateWindowMs: this.lateWindowMs
        }),
        true
      )
    }
    this.timer = setInterval(() => this.tick(), this.tickMs)
    this.timer.unref?.()
    return this.startupCatchUpCount
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.running = false
  }

  /** Wake the scheduler after task or settings changes. */
  refresh(): void {
    if (!this.running) return
    this.tick()
  }

  getStartupCatchUpCount(): number {
    return this.startupCatchUpCount
  }

  getNextReminderAt(): string | null {
    return findNextReminderAt(this.options.store.listTasks(), this.now())
  }

  private tick(): void {
    const settings = this.options.store.getSettings()
    if (!settings.notificationsEnabled) return
    this.deliver(
      findDueReminderCandidates(this.options.store.listTasks(), this.now(), {
        catchUp: false,
        catchUpWindowMs: this.catchUpWindowMs,
        lateWindowMs: this.lateWindowMs
      }),
      false
    )
  }

  private deliver(candidates: ReminderCandidate[], startup: boolean): number {
    let delivered = 0
    for (const candidate of candidates) {
      const existing = this.options.store.hasDelivery(
        candidate.task.id,
        candidate.ruleId,
        candidate.dueAt
      )
      if (existing) continue
      const key = this.options.store.claimDelivery({
        taskId: candidate.task.id,
        ruleId: candidate.ruleId,
        dueAt: candidate.dueAt,
        scheduledFor: candidate.scheduledFor
      })
      if (!key) continue
      const event: ReminderFiredEvent = {
        taskId: candidate.task.id,
        taskTitle: candidate.task.title,
        dueAt: candidate.dueAt,
        offsetMinutes: candidate.offsetMinutes,
        firedAt: this.now().toISOString()
      }
      try {
        this.options.notify(event)
        this.options.onSchedulerEvent?.(event)
        delivered += 1
      } catch {
        this.options.store.releaseDelivery(key)
      }
    }
    if (startup) return delivered
    return delivered
  }
}
