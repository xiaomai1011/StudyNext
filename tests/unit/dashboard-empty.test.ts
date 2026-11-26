import { describe, expect, it } from 'vitest'
import type { ChaoxingSessionStatus, SyncStatus } from '@shared/types'
import { getDashboardEmptyCopy, type DashboardEmptyContext } from '@shared/dashboard-empty'

const sync = (overrides: Partial<SyncStatus> = {}): SyncStatus => ({
  state: 'success',
  message: '',
  source: 'chaoxing',
  lastAttemptAt: '2026-11-19T10:00:00.000Z',
  lastSuccessAt: '2026-11-19T10:00:00.000Z',
  detail: null,
  snapshot: null,
  ...overrides
})

const chaoxing = (
  overrides: Partial<Pick<ChaoxingSessionStatus, 'authState' | 'lastSyncAt'>> = {}
): Pick<ChaoxingSessionStatus, 'authState' | 'lastSyncAt'> => ({
  authState: 'authenticated',
  lastSyncAt: '2026-11-19T10:00:00.000Z',
  ...overrides
})

const context = (overrides: Partial<DashboardEmptyContext> = {}): DashboardEmptyContext => ({
  syncStatus: sync(),
  chaoxing: chaoxing(),
  autoSyncError: null,
  ...overrides
})

describe('getDashboardEmptyCopy', () => {
  it('describes only local data after a successful empty sync', () => {
    const copy = getDashboardEmptyCopy('review', context())
    expect(copy.condition).toBe('success')
    expect(copy.title).toContain('当前本地暂无')
    expect(copy.description).toContain('本地已加载')
    expect(copy.description).not.toContain('平台同步成功')
  })

  it('never turns a shared success state into a global platform guarantee', () => {
    for (const kind of ['todo', 'review', 'upcoming', 'notices'] as const) {
      const copy = getDashboardEmptyCopy(kind, context())
      expect(copy.condition).toBe('success')
      expect(copy.title).toContain('本地')
      expect(`${copy.description} ${copy.summary}`).not.toMatch(
        /平台同步已完成|平台同步成功|学习通同步成功|所有课程均已更新|平台当前没有/
      )
    }
  })

  it('stays local-only when a single-course retry succeeds after an incomplete full sync', () => {
    // 共享 SyncStatus 只留下 success；没有结构化字段能证明其他课程、通知、
    // 考试也已完成同步，因此不能把这次 success 当成全量完成证据。
    const copy = getDashboardEmptyCopy(
      'review',
      context({
        syncStatus: sync({
          state: 'success',
          lastSuccessAt: '2026-11-18T10:00:00.000Z'
        })
      })
    )
    expect(copy.title).toContain('当前本地暂无')
    expect(copy.description).toContain('平台提交状态可能尚未全部同步')
    expect(copy.description).not.toContain('所有课程')
    expect(copy.summary).not.toContain('平台同步完成')
  })

  it('does not let a course retry claim that notifications were synced', () => {
    const copy = getDashboardEmptyCopy(
      'notices',
      context({
        syncStatus: sync({
          state: 'success',
          lastSuccessAt: '2026-11-18T10:00:00.000Z'
        })
      })
    )
    expect(copy.title).toContain('当前本地暂无通知')
    expect(copy.description).toContain('平台通知可能尚未更新')
    expect(copy.summary).toContain('平台通知可能尚未更新')
  })

  it('does not claim a complete platform deadline set from local data', () => {
    const copy = getDashboardEmptyCopy('upcoming', context())
    expect(copy.title).toContain('当前本地暂无')
    expect(copy.description).toContain('平台数据可能尚未全部更新')
    expect(copy.description).not.toContain('平台同步成功')
  })

  it('does not claim the platform is empty when the sync failed', () => {
    const copy = getDashboardEmptyCopy(
      'notices',
      context({ syncStatus: sync({ state: 'failure', lastSuccessAt: null }) })
    )
    expect(copy.condition).toBe('failure')
    expect(copy.title).toContain('暂不可用')
    expect(copy.description).toContain('无法确认')
    expect(copy.title).not.toContain('暂无通知')
  })

  it('preserves the old-data wording when the last attempt failed', () => {
    const copy = getDashboardEmptyCopy(
      'upcoming',
      context({ syncStatus: sync({ state: 'failure', lastSuccessAt: '2026-11-18T10:00:00.000Z' }) })
    )
    expect(copy.condition).toBe('failure')
    expect(copy.description).toContain('上次成功同步')
    expect(copy.description).toContain('可能不是最新')
  })

  it('distinguishes a partial update from a complete result', () => {
    const copy = getDashboardEmptyCopy(
      'notices',
      context({ syncStatus: sync({ state: 'partial' }) })
    )
    expect(copy.condition).toBe('partial')
    expect(copy.title).toContain('未完整')
  })

  it('does not require platform login for local tasks', () => {
    const copy = getDashboardEmptyCopy(
      'upcoming',
      context({
        syncStatus: sync({ state: 'not_configured', source: null, lastSuccessAt: null }),
        chaoxing: chaoxing({ authState: 'logged_out', lastSyncAt: null })
      })
    )
    expect(copy.condition).toBe('not_connected')
    expect(copy.description).toContain('本地任务仍会显示')
  })

  it('treats a successful import as a snapshot, not a notification sync', () => {
    const copy = getDashboardEmptyCopy(
      'notices',
      context({ syncStatus: sync({ source: 'import' }) })
    )
    expect(copy.condition).toBe('import')
    expect(copy.title).toContain('本地快照不含通知')
  })

  it('does not treat authentication as a completed sync', () => {
    const copy = getDashboardEmptyCopy(
      'review',
      context({
        syncStatus: sync({ state: 'not_configured', source: null, lastSuccessAt: null }),
        chaoxing: chaoxing({ authState: 'authenticated', lastSyncAt: null })
      })
    )
    expect(copy.condition).toBe('not_synced')
    expect(copy.title).toContain('尚未同步')
  })

  it('uses cautious wording when the source state is unknown', () => {
    const copy = getDashboardEmptyCopy(
      'todo',
      context({
        syncStatus: sync({ state: 'not_configured', source: null, lastSuccessAt: null }),
        chaoxing: chaoxing({ authState: 'unknown', lastSyncAt: null })
      })
    )
    expect(copy.condition).toBe('unknown')
    expect(copy.description).toContain('无法确认')
  })

  it('treats a recent automatic refresh error as stale even if the last sync succeeded', () => {
    const copy = getDashboardEmptyCopy('todo', context({ autoSyncError: '网络不可用' }))
    expect(copy.condition).toBe('failure')
    expect(copy.description).toContain('可能尚未更新')
  })
})
