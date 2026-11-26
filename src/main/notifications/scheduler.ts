import { REMINDER_PRESETS } from '@shared/constants'
import { isDueAtUnknown } from '@shared/domain'
import type { ReminderFiredEvent, Task } from '@shared/types'
import type { NotificationDeliveryFailure, StudyNextStore } from '../storage/store'
import { decideDeliveryRetry, earliestIso } from './retry-policy'

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
  /**
   * Called after at least one notification attempt settled. The main process
   * uses this to move the Windows one-shot task to the next normal reminder or
   * retry time; otherwise an in-process failure could leave no trigger behind
   * after the app closes.
   */
  onSchedulerSettled?: () => void
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

export function reminderCandidateKey(candidate: ReminderCandidate): string {
  return `${candidate.task.id}:${candidate.ruleId}:${candidate.dueAt}`
}

/**
 * Rebuild a candidate from a persisted delivery failure. The task, rule and
 * deadline are re-read from SQLite: an external activation ID or a stale retry
 * row is never trusted on its own.
 */
export function reminderCandidateFromFailure(
  failure: NotificationDeliveryFailure,
  tasks: Map<string, Task>,
  now: Date
): ReminderCandidate | null {
  const task = tasks.get(failure.taskId)
  if (!task || task.status !== 'todo') return null
  const rule = task.reminders.find((item) => item.id === failure.ruleId)
  if (!rule || !rule.enabled) return null
  // The retry row must still describe this task's current schedule. A deadline
  // edit, a replaced reminder rule, or a row left behind by an interrupted
  // update must never replay the old notification.
  if (failure.dueAt !== task.dueAt) return null
  const dueMs = Date.parse(task.dueAt)
  if (!Number.isFinite(dueMs) || dueMs <= now.getTime()) return null
  const scheduledFor = new Date(dueMs - rule.offsetMinutes * 60_000).toISOString()
  if (failure.scheduledFor !== scheduledFor) return null
  if (failure.dedupeKey !== `${task.id}:${rule.id}:${task.dueAt}`) return null
  return {
    task,
    ruleId: rule.id,
    offsetMinutes: rule.offsetMinutes,
    scheduledFor,
    dueAt: task.dueAt
  }
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
    if (isDueAtUnknown(task.dueAt)) continue
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
    if (isDueAtUnknown(task.dueAt)) continue
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
        this.collectCandidates(this.now(), settings.catchUpMissedReminders),
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
    return earliestIso([
      findNextReminderAt(this.options.store.listTasks(), this.now()),
      this.options.store.nextDeliveryRetryAt()
    ])
  }

  private tick(): void {
    const settings = this.options.store.getSettings()
    if (!settings.notificationsEnabled) return
    this.deliver(this.collectCandidates(this.now(), false), false)
  }

  private collectCandidates(now: Date, catchUp: boolean): ReminderCandidate[] {
    const tasks = this.options.store.listTasks()
    const tasksById = new Map(tasks.map((task) => [task.id, task]))
    const candidates = new Map<string, ReminderCandidate>()
    for (const candidate of findDueReminderCandidates(tasks, now, {
      catchUp,
      catchUpWindowMs: this.catchUpWindowMs,
      lateWindowMs: this.lateWindowMs
    })) {
      candidates.set(reminderCandidateKey(candidate), candidate)
    }
    for (const failure of this.options.store.listDueDeliveryFailures(now.toISOString())) {
      if (candidates.has(failure.dedupeKey)) continue
      const candidate = reminderCandidateFromFailure(failure, tasksById, now)
      if (!candidate) {
        this.options.store.markDeliveryFailureExhausted(failure.dedupeKey)
        continue
      }
      candidates.set(reminderCandidateKey(candidate), candidate)
    }
    return [...candidates.values()]
  }

  private deliver(candidates: ReminderCandidate[], startup: boolean): number {
    let delivered = 0
    let attempted = false
    for (const candidate of candidates) {
      const existing = this.options.store.hasDelivery(
        candidate.task.id,
        candidate.ruleId,
        candidate.dueAt
      )
      if (existing) continue
      const key = reminderCandidateKey(candidate)
      const failure = this.options.store.getDeliveryFailure(key)
      if (failure?.nextRetryAt === null) continue
      if (failure?.nextRetryAt && Date.parse(failure.nextRetryAt) > this.now().getTime()) {
        continue
      }
      const claim = this.options.store.claimDelivery({
        taskId: candidate.task.id,
        ruleId: candidate.ruleId,
        dueAt: candidate.dueAt,
        scheduledFor: candidate.scheduledFor
      })
      if (!claim) continue
      attempted = true
      const firedAt = this.now()
      const event: ReminderFiredEvent = {
        taskId: candidate.task.id,
        taskTitle: candidate.task.title,
        dueAt: candidate.dueAt,
        offsetMinutes: candidate.offsetMinutes,
        firedAt: firedAt.toISOString()
      }
      try {
        this.options.notify(event)
        this.options.onSchedulerEvent?.(event)
        this.options.store.clearDeliveryFailure(key)
        delivered += 1
      } catch (error) {
        this.options.store.releaseDelivery(claim)
        const attemptCount = (this.options.store.getDeliveryFailure(key)?.attemptCount ?? 0) + 1
        const retry = decideDeliveryRetry({
          attemptCount,
          dueAt: candidate.dueAt,
          now: firedAt
        })
        this.options.store.recordDeliveryFailure({
          dedupeKey: key,
          taskId: candidate.task.id,
          ruleId: candidate.ruleId,
          dueAt: candidate.dueAt,
          scheduledFor: candidate.scheduledFor,
          error: error instanceof Error ? error.message : String(error),
          at: firedAt.toISOString(),
          nextRetryAt: retry.nextRetryAt
        })
      }
    }
    if (attempted) this.options.onSchedulerSettled?.()
    if (startup) return delivered
    return delivered
  }
}
