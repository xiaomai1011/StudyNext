import { describe, expect, it } from 'vitest'
import type { ChaoxingSessionStatus, SyncStatus } from '@shared/types'
import { resolveEffectiveSyncStatus } from '../../src/main/integrations/sync-status'

const base = (overrides: Partial<SyncStatus> = {}): SyncStatus => ({
  state: 'not_configured',
  message: 'Web Session 尚未连接',
  source: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  detail: null,
  snapshot: null,
  ...overrides
})

const session = (overrides: Partial<ChaoxingSessionStatus> = {}): ChaoxingSessionStatus => ({
  authState: 'authenticated',
  connection: 'web_session',
  message: '同步完成',
  displayName: '张三',
  school: '示例大学',
  studentId: '1',
  avatarUrl: null,
  checkedAt: '2026-01-02T00:00:00.000Z',
  lastSyncAt: '2026-01-02T00:00:00.000Z',
  lastCompleteSyncAt: '2026-01-02T00:00:00.000Z',
  lastAttemptAt: '2026-01-02T00:00:00.000Z',
  lastOutcome: 'success',
  lastOutcomeMessage: '同步完成',
  lastOutcomeDetail: null,
  lastOutcomeAt: '2026-01-02T00:00:00.000Z',
  syncedCourses: 1,
  syncedTasks: 1,
  syncedChapters: 0,
  syncedExams: 0,
  syncedNotices: 0,
  syncedMaterials: 0,
  transport: 'session_fetch',
  httpStatus: 200,
  cookieDomainCount: 1,
  detail: null,
  ...overrides
})

describe('重启后的有效同步状态', () => {
  it('保留部分成功，不把 lastSyncAt 当成完整成功', () => {
    const result = resolveEffectiveSyncStatus(
      base(),
      session({
        lastOutcome: 'partial',
        lastOutcomeMessage: '同步完成；部分数据读取失败',
        lastOutcomeDetail: '失败：通知读取失败',
        lastCompleteSyncAt: '2026-01-01T00:00:00.000Z'
      })
    )
    expect(result.state).toBe('partial')
    expect(result.lastSuccessAt).toBe('2026-01-01T00:00:00.000Z')
    expect(result.message).toContain('部分数据读取失败')
  })

  it('保留失败结果与上一次完整成功时间', () => {
    const result = resolveEffectiveSyncStatus(
      base(),
      session({
        lastOutcome: 'failure',
        lastOutcomeMessage: '同步失败，本地数据未受影响',
        lastOutcomeDetail: 'net::ERR_CONNECTION_RESET',
        lastCompleteSyncAt: '2026-01-01T00:00:00.000Z'
      })
    )
    expect(result.state).toBe('failure')
    expect(result.lastSuccessAt).toBe('2026-01-01T00:00:00.000Z')
    expect(result.detail).toBe('net::ERR_CONNECTION_RESET')
  })

  it('旧持久化状态只有“部分数据”文案时保守推为 partial', () => {
    const result = resolveEffectiveSyncStatus(
      base(),
      session({
        lastOutcome: null,
        lastOutcomeMessage: null,
        lastOutcomeDetail: null,
        message: '同步完成，3 门课程；部分数据读取失败'
      })
    )
    expect(result.state).toBe('partial')
  })

  it('旧持久化状态只有失败文案时推为 failure', () => {
    const result = resolveEffectiveSyncStatus(
      base(),
      session({
        lastOutcome: null,
        lastOutcomeMessage: null,
        lastOutcomeDetail: null,
        lastSyncAt: null,
        lastCompleteSyncAt: null,
        message: '同步失败，本地数据未受影响'
      })
    )
    expect(result.state).toBe('failure')
  })

  it('已有非 not_configured 的 SyncStatus 时保持原值', () => {
    const existing = base({
      state: 'success',
      source: 'import',
      lastSuccessAt: '2026-01-03T00:00:00.000Z'
    })
    expect(resolveEffectiveSyncStatus(existing, session())).toBe(existing)
  })

  it('未认证时不伪造同步结果', () => {
    const result = resolveEffectiveSyncStatus(base(), session({ authState: 'expired' }))
    expect(result.state).toBe('not_configured')
  })
})
