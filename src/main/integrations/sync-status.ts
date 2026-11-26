import type { ChaoxingSessionStatus, SyncStatus } from '@shared/types'

type SessionOutcome = NonNullable<ChaoxingSessionStatus['lastOutcome']>

/**
 * SyncStatus 是历史遗留的扁平状态；ChaoxingSessionStatus 才是持久化的真实
 * 会话同步结果。重启后 SyncService 会回到 not_configured，此时不能仅凭
 * lastSyncAt 合成 success，否则会把上一次 partial/failure 显示成绿色。
 */
export function resolveEffectiveSyncStatus(
  base: SyncStatus,
  session: ChaoxingSessionStatus
): SyncStatus {
  if (base.state !== 'not_configured' || session.authState !== 'authenticated') {
    return base
  }

  const outcome = resolveOutcome(session)
  if (
    !outcome ||
    outcome === 'not_configured' ||
    outcome === 'cancelled' ||
    outcome === 'too_late'
  ) {
    return base
  }

  return {
    state: outcome,
    message: session.lastOutcomeMessage ?? session.message,
    source: 'chaoxing',
    lastAttemptAt: session.lastOutcomeAt ?? session.lastAttemptAt,
    lastSuccessAt:
      session.lastCompleteSyncAt ?? (outcome === 'success' ? session.lastSyncAt : null),
    detail:
      session.lastOutcomeDetail ??
      (outcome === 'partial' ? '部分数据读取失败；本地旧数据已保留，尚未完成一次完整同步。' : null),
    snapshot: null
  }
}

function resolveOutcome(session: ChaoxingSessionStatus): SessionOutcome | null {
  if (session.lastOutcome) return session.lastOutcome

  // 兼容升级前只持久化了 message/lastSyncAt 的旧状态，避免旧数据被误报成功。
  const message = session.lastOutcomeMessage ?? session.message ?? ''
  if (/同步失败|课程重试失败/.test(message)) return 'failure'
  if (
    /部分数据读取失败/.test(message) ||
    /失败：/.test(session.lastOutcomeDetail ?? session.detail ?? '')
  ) {
    return 'partial'
  }
  if (session.lastSyncAt) return 'success'
  return null
}
