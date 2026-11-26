import type { PlatformStatusKind } from '@shared/types'
import type { BadgeTone } from './primitives'

/**
 * Presentation-only mapping. Status semantics stay in @shared/task-state.
 */
export function platformStatusTone(kind: PlatformStatusKind): BadgeTone {
  switch (kind) {
    case 'submitted':
      return 'info'
    case 'pending_review':
      return 'warning'
    case 'reviewed':
      return 'accent'
    case 'done':
      return 'success'
    case 'not_submitted':
    case 'unknown':
    default:
      return 'neutral'
  }
}

export function scoreTone(state: 'graded' | 'ungraded' | 'unread'): BadgeTone {
  if (state === 'graded') return 'accent'
  if (state === 'unread') return 'neutral'
  return 'neutral'
}
