/**
 * Shared bounded retry policy for reminder delivery failures.
 *
 * Attempt 1 is the normal scheduled delivery. After each failed attempt the
 * queue stores the next retry time; four consecutive failures stop automatic
 * retries while keeping the error record for the UI.
 */
export const DELIVERY_MAX_ATTEMPTS = 4
export const DELIVERY_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const

export interface DeliveryRetryDecision {
  nextRetryAt: string | null
  exhausted: boolean
}

export function decideDeliveryRetry(input: {
  attemptCount: number
  dueAt: string
  now: Date
}): DeliveryRetryDecision {
  const dueMs = Date.parse(input.dueAt)
  if (!Number.isFinite(dueMs) || dueMs <= input.now.getTime()) {
    return { nextRetryAt: null, exhausted: true }
  }
  if (input.attemptCount >= DELIVERY_MAX_ATTEMPTS) {
    return { nextRetryAt: null, exhausted: true }
  }
  const delay = DELIVERY_RETRY_DELAYS_MS[input.attemptCount - 1]
  if (!delay) return { nextRetryAt: null, exhausted: true }
  const retryMs = input.now.getTime() + delay
  // Never schedule a retry after the reminder's own deadline: it would be
  // useless and would keep a Windows task alive for a past task.
  if (retryMs >= dueMs) return { nextRetryAt: null, exhausted: true }
  return { nextRetryAt: new Date(retryMs).toISOString(), exhausted: false }
}

export function earliestIso(values: Array<string | null | undefined>): string | null {
  let earliest: number | null = null
  for (const value of values) {
    if (!value) continue
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) continue
    if (earliest === null || parsed < earliest) earliest = parsed
  }
  return earliest === null ? null : new Date(earliest).toISOString()
}
