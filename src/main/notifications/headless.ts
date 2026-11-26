import type { ReminderFiredEvent, Task } from '@shared/types'
import type { StudyNextStore } from '../storage/store'
import {
  findDueReminderCandidates,
  findNextReminderAt,
  reminderCandidateFromFailure,
  reminderCandidateKey,
  type ReminderCandidate
} from './scheduler'
import { decideDeliveryRetry, earliestIso } from './retry-policy'

const HEADLESS_CATCH_UP_MS = 30 * 60_000
const HEADLESS_LATE_WINDOW_MS = 30 * 60_000

export interface HeadlessReminderResult {
  checkedAt: string
  candidates: number
  delivered: number
  failed: number
  retriesScheduled: number
  retriesExhausted: number
  errors: string[]
  nextReminderAt: string | null
}

export interface HeadlessReminderOptions {
  store: StudyNextStore
  notify: (event: ReminderFiredEvent, task: Task) => Promise<void>
  now?: Date
  catchUpWindowMs?: number
  lateWindowMs?: number
}

function eventFor(
  candidate: ReminderCandidate,
  store: StudyNextStore,
  firedAt: string
): ReminderFiredEvent {
  return {
    taskId: candidate.task.id,
    taskTitle: candidate.task.title,
    courseName: candidate.task.courseId
      ? (store.getCourse(candidate.task.courseId)?.name ?? null)
      : null,
    dueAt: candidate.dueAt,
    offsetMinutes: candidate.offsetMinutes,
    firedAt
  }
}

/**
 * Headless reminder check used by the Windows Scheduled Task.
 *
 * It processes normal due reminders and persisted retry entries. A delivery
 * failure is written to `notification_delivery_failures` before the claim is
 * released, so the next trigger can be positioned even when no other reminder
 * exists and the process exits immediately afterwards.
 */
export async function runHeadlessReminderCheck(
  options: HeadlessReminderOptions
): Promise<HeadlessReminderResult> {
  const now = options.now ?? new Date()
  const nowIso = now.toISOString()
  const settings = options.store.getSettings()
  const result: HeadlessReminderResult = {
    checkedAt: nowIso,
    candidates: 0,
    delivered: 0,
    failed: 0,
    retriesScheduled: 0,
    retriesExhausted: 0,
    errors: [],
    nextReminderAt: null
  }
  const tasks = options.store.listTasks()
  const tasksById = new Map(tasks.map((task) => [task.id, task]))
  if (!settings.notificationsEnabled) {
    result.nextReminderAt = options.store.nextDeliveryRetryAt()
    return result
  }

  const candidates = new Map<string, ReminderCandidate>()
  const normalCandidates = findDueReminderCandidates(tasks, now, {
    catchUp: true,
    catchUpWindowMs: options.catchUpWindowMs ?? HEADLESS_CATCH_UP_MS,
    lateWindowMs: options.lateWindowMs ?? HEADLESS_LATE_WINDOW_MS
  })
  for (const candidate of normalCandidates) {
    const key = reminderCandidateKey(candidate)
    const failure = options.store.getDeliveryFailure(key)
    if (options.store.hasDelivery(candidate.task.id, candidate.ruleId, candidate.dueAt)) {
      // A completed delivery wins over a stale failure left by an interrupted
      // process. Clear it only when we have proof that the notification landed.
      if (failure) options.store.clearDeliveryFailure(key)
      continue
    }
    if (failure?.nextRetryAt === null) continue
    if (failure?.nextRetryAt && Date.parse(failure.nextRetryAt) > now.getTime()) {
      continue
    }
    candidates.set(key, candidate)
  }

  // A retry may still be due after the normal catch-up window has elapsed.
  for (const failure of options.store.listDueDeliveryFailures(nowIso)) {
    const key = failure.dedupeKey
    if (candidates.has(key)) continue
    const candidate = reminderCandidateFromFailure(failure, tasksById, now)
    if (!candidate) {
      options.store.markDeliveryFailureExhausted(key)
      result.retriesExhausted += 1
      continue
    }
    candidates.set(key, candidate)
  }

  result.candidates = candidates.size
  for (const [key, candidate] of candidates) {
    const claim = options.store.claimDelivery({
      taskId: candidate.task.id,
      ruleId: candidate.ruleId,
      dueAt: candidate.dueAt,
      scheduledFor: candidate.scheduledFor
    })
    if (!claim) continue
    try {
      await options.notify(eventFor(candidate, options.store, nowIso), candidate.task)
      options.store.clearDeliveryFailure(key)
      result.delivered += 1
    } catch (error) {
      // Release the claim first: the retry row is the durable record, and the
      // next process must be able to claim this notification again.
      options.store.releaseDelivery(claim)
      const attemptCount = (options.store.getDeliveryFailure(key)?.attemptCount ?? 0) + 1
      const retry = decideDeliveryRetry({
        attemptCount,
        dueAt: candidate.dueAt,
        now
      })
      options.store.recordDeliveryFailure({
        dedupeKey: key,
        taskId: candidate.task.id,
        ruleId: candidate.ruleId,
        dueAt: candidate.dueAt,
        scheduledFor: candidate.scheduledFor,
        error: error instanceof Error ? error.message : String(error),
        at: nowIso,
        nextRetryAt: retry.nextRetryAt
      })
      if (retry.nextRetryAt) result.retriesScheduled += 1
      else result.retriesExhausted += 1
      result.failed += 1
      result.errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  result.nextReminderAt = earliestIso([
    findNextReminderAt(tasks, now),
    options.store.nextDeliveryRetryAt()
  ])
  return result
}
