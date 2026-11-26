import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SyncService } from '../../src/main/integrations/sync'
import { resolveEffectiveSyncStatus } from '../../src/main/integrations/sync-status'
import { StudyNextStore } from '../../src/main/storage/store'
import { ChaoxingSessionService } from '../../src/main/integrations/chaoxing/service'
import type {
  ChaoxingAdapterLike,
  ChaoxingPullResult
} from '../../src/main/integrations/chaoxing/adapter'

const dirs: string[] = []
const AUTH_PROFILE = { name: '张三', school: '示例大学', uid: '1', fid: '427' }

function makeAdapter(pull: () => Promise<ChaoxingPullResult>): ChaoxingAdapterLike {
  return {
    checkSession: async () => ({
      authState: 'authenticated',
      message: '已登录',
      profile: AUTH_PROFILE,
      httpStatus: 200,
      transport: 'session_fetch',
      cookieDomainCount: 2
    }),
    pull
  }
}

function emptyResult(overrides: Partial<ChaoxingPullResult> = {}): ChaoxingPullResult {
  return {
    courses: [],
    tasks: [],
    errors: [],
    warnings: [],
    checkedAt: new Date().toISOString(),
    ...overrides
  }
}

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studynext-sync-r01-'))
  dirs.push(dir)
  return join(dir, 'workspace.sqlite')
}

function feed(
  store: StudyNextStore,
  adapter: ChaoxingAdapterLike,
  sync: SyncService
): ChaoxingSessionService {
  return new ChaoxingSessionService(store, adapter, (outcome) => sync.recordSessionResult(outcome))
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('SyncService 会话结果', () => {
  it('同实例 partial 使用会话服务提供的完整成功时间，不采用任意新时间', () => {
    const store = new StudyNextStore(':memory:')
    try {
      const sync = new SyncService(store)
      sync.recordSessionResult({
        state: 'success',
        message: '同步完成',
        detail: null,
        lastSuccessAt: '2026-01-02T00:00:00.000Z'
      })
      const partial = sync.recordSessionResult({
        state: 'partial',
        message: '同步完成；部分数据读取失败',
        detail: '失败：通知读取失败',
        lastSuccessAt: '2026-01-02T00:00:00.000Z'
      })
      expect(partial.state).toBe('partial')
      expect(partial.lastSuccessAt).toBe('2026-01-02T00:00:00.000Z')
      expect(partial.detail).toContain('通知读取失败')
    } finally {
      store.close()
    }
  })

  it('同实例 failure 保留会话服务提供的完整成功时间', () => {
    const store = new StudyNextStore(':memory:')
    try {
      const sync = new SyncService(store)
      sync.recordSessionResult({
        state: 'success',
        message: '同步完成',
        detail: null,
        lastSuccessAt: '2026-01-02T00:00:00.000Z'
      })
      const failed = sync.recordSessionResult({
        state: 'failure',
        message: '同步失败',
        detail: 'network down',
        lastSuccessAt: '2026-01-02T00:00:00.000Z'
      })
      expect(failed.state).toBe('failure')
      expect(failed.lastSuccessAt).toBe('2026-01-02T00:00:00.000Z')
    } finally {
      store.close()
    }
  })

  it('跨重启 partial 仍保留持久化的完整成功时间，不被快照导入时间替换', async () => {
    const dbPath = tempDbPath()
    const store1 = new StudyNextStore(dbPath)
    const sync1 = new SyncService(store1)
    const first = feed(
      store1,
      makeAdapter(async () => emptyResult()),
      sync1
    )
    await first.sync(true)
    const t1 = first.getStatus().lastCompleteSyncAt
    expect(t1).not.toBeNull()
    expect(sync1.getStatus().lastSuccessAt).toBe(t1)

    // 快照导入是另一个来源，不能成为学习通完整同步的成功时间。
    sync1.recordSnapshotImport({
      state: 'success',
      importedCourses: 1,
      updatedCourses: 0,
      importedChapters: 0,
      importedPoints: 0,
      importedTasks: 0,
      updatedTasks: 0,
      deadlineChanges: 0,
      conflicts: 0,
      skipped: 0,
      warnings: [],
      message: '导入完成',
      snapshot: {
        importedAt: '2026-02-02T00:00:00.000Z',
        fileName: 'snapshot.json',
        courses: 1,
        chapters: 0,
        points: 0,
        tasks: 0
      }
    })
    expect(sync1.getStatus().lastSuccessAt).not.toBe(t1)
    store1.close()

    const store2 = new StudyNextStore(dbPath)
    try {
      const sync2 = new SyncService(store2)
      // 新实例的基线状态会带上快照时间；这是测试要防止被误用的值。
      expect(sync2.getStatus().lastSuccessAt).toBe('2026-02-02T00:00:00.000Z')
      const second = feed(
        store2,
        makeAdapter(async () => emptyResult({ errors: ['课程页读取失败'], warnings: [] })),
        sync2
      )
      const partial = await second.sync(true)
      expect(partial.lastOutcome).toBe('partial')
      expect(sync2.getStatus().state).toBe('partial')
      expect(sync2.getStatus().lastSuccessAt).toBe(t1)
      expect(resolveEffectiveSyncStatus(sync2.getStatus(), partial).lastSuccessAt).toBe(t1)
    } finally {
      store2.close()
    }
  })

  it('跨重启 failure 仍保留持久化的完整成功时间', async () => {
    const dbPath = tempDbPath()
    const store1 = new StudyNextStore(dbPath)
    const sync1 = new SyncService(store1)
    const first = feed(
      store1,
      makeAdapter(async () => emptyResult()),
      sync1
    )
    await first.sync(true)
    const t1 = first.getStatus().lastCompleteSyncAt
    expect(t1).not.toBeNull()
    store1.close()

    const store2 = new StudyNextStore(dbPath)
    try {
      const sync2 = new SyncService(store2)
      const second = feed(
        store2,
        makeAdapter(async () => {
          throw new Error('network down')
        }),
        sync2
      )
      const failed = await second.sync(true)
      expect(failed.lastOutcome).toBe('failure')
      expect(sync2.getStatus().state).toBe('failure')
      expect(sync2.getStatus().lastSuccessAt).toBe(t1)
    } finally {
      store2.close()
    }
  })

  it('没有历史完整成功时，跨重启 partial 保持未同步，不伪造成功时间', async () => {
    const dbPath = tempDbPath()
    const store1 = new StudyNextStore(dbPath)
    store1.close()
    const store2 = new StudyNextStore(dbPath)
    try {
      const sync = new SyncService(store2)
      const service = feed(
        store2,
        makeAdapter(async () => emptyResult({ warnings: ['通知读取失败'] })),
        sync
      )
      const status = await service.sync(true)
      expect(status.lastOutcome).toBe('partial')
      expect(status.lastCompleteSyncAt).toBeNull()
      expect(sync.getStatus().lastSuccessAt).toBeNull()
    } finally {
      store2.close()
    }
  })

  it('新的完整成功覆盖旧值，后续失败仍保留最新完整成功时间', async () => {
    const dbPath = tempDbPath()
    const store1 = new StudyNextStore(dbPath)
    const sync1 = new SyncService(store1)
    const first = feed(
      store1,
      makeAdapter(async () => emptyResult()),
      sync1
    )
    await first.sync(true)
    const t1 = first.getStatus().lastCompleteSyncAt
    expect(t1).not.toBeNull()
    store1.close()

    const store2 = new StudyNextStore(dbPath)
    const sync2 = new SyncService(store2)
    const second = feed(
      store2,
      makeAdapter(async () => emptyResult()),
      sync2
    )
    await second.sync(true)
    const t3 = second.getStatus().lastCompleteSyncAt
    expect(t3).not.toBeNull()
    expect(t3).not.toBe(t1)
    expect(sync2.getStatus().lastSuccessAt).toBe(t3)
    store2.close()

    const store3 = new StudyNextStore(dbPath)
    try {
      const sync3 = new SyncService(store3)
      const third = feed(
        store3,
        makeAdapter(async () => {
          throw new Error('network down')
        }),
        sync3
      )
      const failed = await third.sync(true)
      expect(failed.lastOutcome).toBe('failure')
      expect(sync3.getStatus().lastSuccessAt).toBe(t3)
      expect(sync3.getStatus().lastSuccessAt).not.toBe(t1)
    } finally {
      store3.close()
    }
  })
})
