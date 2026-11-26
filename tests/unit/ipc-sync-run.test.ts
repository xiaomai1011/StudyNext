import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../src/shared/ipc'
import type { SyncStatus } from '../../src/shared/types'
import { SyncService } from '../../src/main/integrations/sync'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
    on: vi.fn()
  },
  app: { quit: vi.fn() },
  Notification: { isSupported: () => false },
  shell: { openPath: vi.fn(), openExternal: vi.fn() }
}))

import { registerIpc } from '../../src/main/ipc'

const T1 = '2026-11-20T10:00:00.000Z'
const T2 = '2026-11-21T11:00:00.000Z'

function initialStatus(lastSuccessAt: string | null): SyncStatus {
  return {
    state: 'partial',
    message: '上次同步部分失败',
    source: 'chaoxing',
    lastAttemptAt: T2,
    lastSuccessAt,
    detail: null,
    snapshot: null
  }
}

function install(
  lastSuccessAt: string | null,
  checkResult: {
    authState: 'logged_out' | 'expired' | 'authenticated'
    message: string
    lastSyncAt: string | null
    lastCompleteSyncAt: string | null
    lastRunStage?: 'auth' | 'pull' | 'persist' | 'done' | null
    lastRunCached?: boolean | null
    lastRunCommitted?: boolean | null
    lastOutcome?:
      | 'success'
      | 'partial'
      | 'failure'
      | 'not_configured'
      | 'cancelled'
      | 'too_late'
      | null
    lastOperationId?: string | null
    lastOperationKind?:
      | 'manual_sync'
      | 'auto_sync'
      | 'retry_course'
      | 'submit_verify'
      | 'auth_check'
      | 'auto_login'
      | null
    lastOperationState?:
      | 'success'
      | 'partial'
      | 'cached'
      | 'not_configured'
      | 'failure'
      | 'cancelled'
      | 'too_late'
      | 'busy'
      | null
    detail?: string | null
    userDisconnected?: boolean
  }
) {
  const store = {
    readOnly: false,
    getMeta: () => null
  }
  const sync = new SyncService(store as never)
  sync.recordSessionResult({
    state: 'partial',
    message: initialStatus(lastSuccessAt).message,
    detail: null,
    lastSuccessAt
  })

  const chaoxing = {
    check: vi.fn(async () => checkResult),
    syncWithAuthCheck: vi.fn(async () => checkResult),
    getStatus: vi.fn(() => checkResult)
  }

  handlers.clear()
  registerIpc({
    store,
    scheduler: { refresh: vi.fn() },
    sync,
    chaoxing,
    credentials: {},
    workspaces: {},
    portal: {},
    getWindow: () => ({ isDestroyed: () => false, webContents: { id: 1 } }),
    appInfo: {},
    notices: [],
    isSwitchingAccount: () => false,
    requestAccountSwitch: vi.fn(),
    requestRestartToSafeWorkspace: vi.fn(),
    requestRestartForAccount: vi.fn(),
    onSettingsChanged: vi.fn(),
    onTestNotification: vi.fn(),
    onDemoReset: vi.fn()
  } as never)

  return { getCurrent: () => sync.getStatus(), sync }
}

async function runSync() {
  const handler = handlers.get(IPC.syncRun)
  if (!handler) throw new Error('syncRun handler not registered')
  return handler({ sender: { id: 1 } })
}

describe('IPC syncRun 未认证分支', () => {
  beforeEach(() => {
    handlers.clear()
  })

  it('保留历史完整成功时间，不使用最近读取时间', async () => {
    const { getCurrent } = install(T1, {
      authState: 'logged_out',
      message: '登录已失效，请重新登录',
      lastSyncAt: T2,
      lastCompleteSyncAt: T1,
      lastRunStage: 'auth'
    })

    await runSync()

    expect(getCurrent().lastSuccessAt).toBe(T1)
    expect(getCurrent().lastSuccessAt).not.toBe(T2)
    expect(getCurrent().state).toBe('not_configured')
  })

  it('没有历史完整成功时不产生虚假成功时间', async () => {
    const { getCurrent } = install(null, {
      authState: 'logged_out',
      message: '登录已失效，请重新登录',
      lastSyncAt: T2,
      lastCompleteSyncAt: null,
      lastRunStage: 'auth'
    })

    await runSync()

    expect(getCurrent().lastSuccessAt).toBeNull()
    expect(getCurrent().state).toBe('not_configured')
  })

  it('拉取期间登录过期保留本次 failure，不重复写入 IPC 同步历史', async () => {
    const { getCurrent } = install(T1, {
      authState: 'expired',
      message: '学习通登录态已失效，请重新登录',
      lastSyncAt: T2,
      lastCompleteSyncAt: T1,
      lastRunStage: 'pull',
      lastOperationState: 'failure',
      lastOutcome: 'failure',
      detail: 'HTTP 401'
    })

    const status = (await runSync()) as SyncStatus

    expect(status.state).toBe('failure')
    expect(status.message).toBe('学习通登录态已失效，请重新登录')
    expect(status.lastSuccessAt).toBe(T1)
    expect(getCurrent().state).toBe('partial')
  })

  it('直接透传本次 cached 标记，即使历史状态是 partial', async () => {
    install(T1, {
      authState: 'authenticated',
      message: '使用短期缓存',
      lastSyncAt: T2,
      lastCompleteSyncAt: T1,
      lastRunCached: true,
      lastRunStage: 'pull'
    })

    const status = (await runSync()) as SyncStatus
    expect(status.cached).toBe(true)
    expect(status.message).toBe('使用短期缓存')
    expect(status.message).not.toContain('上次同步')
  })

  it('旧操作取消返回自身 cancelled，不改写历史同步结果', async () => {
    const { getCurrent } = install(T1, {
      authState: 'authenticated',
      message: '同步已取消，本地数据未受影响',
      lastSyncAt: T2,
      lastCompleteSyncAt: T1,
      lastRunStage: 'pull',
      lastRunCommitted: false,
      lastOperationId: 'd006-ipc-cancelled',
      lastOperationKind: 'manual_sync',
      lastOperationState: 'cancelled'
    })

    const status = (await runSync()) as SyncStatus
    expect(status.operationState).toBe('cancelled')
    expect(status.committed).toBe(false)
    expect(status.message).toBe('同步已取消，本地数据未受影响')
    expect(status.message).not.toContain('上次同步')
    expect(getCurrent().state).toBe('partial')
    expect(getCurrent().lastSuccessAt).toBe(T1)
  })

  it('blocks automatic login after the user explicitly cleared the session', async () => {
    install(T1, {
      authState: 'logged_out',
      message: '已清除学习通会话，请重新登录',
      lastSyncAt: T2,
      lastCompleteSyncAt: T1,
      userDisconnected: true
    })
    const handler = handlers.get(IPC.chaoxingAutoLogin)
    if (!handler) throw new Error('autoLogin handler not registered')
    const result = (await handler({ sender: { id: 1 } }, undefined, undefined, true)) as {
      ok: boolean
      needsManual: boolean
      message: string
    }
    expect(result.ok).toBe(false)
    expect(result.needsManual).toBe(true)
    expect(result.message).toContain('主动断开')
  })

  it('完整同步历史 + 本次 cached 仍使用本次缓存提示', async () => {
    install(T1, {
      authState: 'authenticated',
      message: '最近 5 分钟内已同步，本次使用短期缓存',
      lastSyncAt: T2,
      lastCompleteSyncAt: T1,
      lastRunCached: true,
      lastRunStage: 'pull'
    })

    const status = (await runSync()) as SyncStatus
    expect(status.cached).toBe(true)
    expect(status.message).toContain('本次使用短期缓存')
  })

  it('首次 partial 后的缓存命中不使用 partial 时间冒充完整成功时间', async () => {
    install(null, {
      authState: 'authenticated',
      message: '最近 5 分钟内已同步，本次使用短期缓存',
      lastSyncAt: T2,
      lastCompleteSyncAt: null,
      lastRunCached: true,
      lastRunStage: 'pull',
      lastOperationState: 'cached',
      lastOutcome: 'partial',
      lastRunCommitted: false
    })

    const status = (await runSync()) as SyncStatus
    expect(status.state).toBe('success')
    expect(status.cached).toBe(true)
    expect(status.lastSuccessAt).toBeNull()
  })

  it('拉取失败不覆盖 Portal 恢复期间已完成的快照导入状态', async () => {
    const { sync, getCurrent } = install(T1, {
      authState: 'expired',
      message: '学习通登录态已失效，请重新登录',
      lastSyncAt: T2,
      lastCompleteSyncAt: T1,
      lastRunStage: 'pull',
      lastOperationState: 'failure',
      lastOutcome: 'failure',
      detail: 'HTTP 401'
    })
    sync.recordSessionResult({
      state: 'success',
      message: '学习快照已导入：3 门课程',
      detail: '数据来自用户主动导入的本地 JSON 快照。',
      lastSuccessAt: T2
    })

    const status = (await runSync()) as SyncStatus
    expect(status.state).toBe('failure')
    expect(status.message).toContain('登录态已失效')
    expect(getCurrent().state).toBe('success')
    expect(getCurrent().message).toContain('快照已导入')
    expect(getCurrent().lastSuccessAt).toBe(T2)
  })

  it('本次 partial 回执不被快照导入后的全局 success 覆盖', async () => {
    const { sync } = install(T1, {
      authState: 'authenticated',
      message: '部分数据读取失败，本地旧数据已保留',
      lastSyncAt: T2,
      lastCompleteSyncAt: T1,
      lastRunStage: 'done',
      lastRunCommitted: true,
      lastOperationId: 'd006-partial-receipt',
      lastOperationKind: 'manual_sync',
      lastOperationState: 'partial',
      detail: '课程 B 请求失败'
    })
    sync.recordSessionResult({
      state: 'success',
      message: '学习快照已导入：2 门课程',
      detail: '数据来自用户主动导入的本地 JSON 快照，不是实时授权同步。',
      lastSuccessAt: T2
    })

    const status = (await runSync()) as SyncStatus
    expect(status.state).toBe('partial')
    expect(status.operationState).toBe('partial')
    expect(status.committed).toBe(true)
    expect(status.message).toContain('部分数据读取失败')
    expect(status.detail).toContain('课程 B')
  })
})
