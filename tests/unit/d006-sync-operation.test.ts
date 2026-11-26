import { afterEach, describe, expect, it } from 'vitest'
import type { SyncProgressEvent } from '@shared/types'
import { StudyNextStore } from '../../src/main/storage/store'
import {
  ChaoxingAccessError,
  type ChaoxingAdapterLike,
  type ChaoxingPullResult
} from '../../src/main/integrations/chaoxing/adapter'
import { ChaoxingSessionService } from '../../src/main/integrations/chaoxing/service'

const stores: StudyNextStore[] = []

function openStore(): StudyNextStore {
  const store = new StudyNextStore(':memory:')
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function emptyPull(): ChaoxingPullResult {
  return {
    courses: [],
    tasks: [],
    errors: [],
    warnings: [],
    checkedAt: new Date().toISOString()
  }
}

function authenticatedAdapter(overrides: Partial<ChaoxingAdapterLike> = {}): ChaoxingAdapterLike {
  return {
    checkSession: async () => ({
      authState: 'authenticated',
      message: '已登录',
      profile: { name: '测试同学', school: '示例大学', uid: '10001', fid: null },
      httpStatus: 200,
      transport: 'session_fetch',
      cookieDomainCount: 2
    }),
    pull: async () => emptyPull(),
    ...overrides
  }
}

describe('D-006 unified operation identity', () => {
  it('uses the explicit operation id for progress and commits only after persistence', async () => {
    const store = openStore()
    const progress: SyncProgressEvent[] = []
    const service = new ChaoxingSessionService(
      store,
      authenticatedAdapter(),
      () => undefined,
      (event) => progress.push(event)
    )

    const status = await service.sync(true, {
      operationId: 'd006-sync-op',
      operationKind: 'manual_sync'
    })

    expect(status.lastOperationId).toBe('d006-sync-op')
    expect(status.lastRunStage).toBe('done')
    expect(status.lastRunCommitted).toBe(true)
    expect(status.lastOutcome).toBe('success')
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.every((event) => event.opId === 'd006-sync-op')).toBe(true)
  })

  it('lets a preflight auth operation be cancelled before its transport returns', async () => {
    const store = openStore()
    let resolveCheck!: (value: Awaited<ReturnType<ChaoxingAdapterLike['checkSession']>>) => void
    const adapter = authenticatedAdapter({
      checkSession: () =>
        new Promise((resolve) => {
          resolveCheck = resolve
        })
    })
    const service = new ChaoxingSessionService(store, adapter)

    const checkPromise = service.checkWithOperation('d006-auth-op')
    service.cancel('d006-auth-op')
    resolveCheck({
      authState: 'authenticated',
      message: '已登录',
      profile: { name: '测试同学', school: '示例大学', uid: '10001', fid: null },
      httpStatus: 200,
      transport: 'session_fetch',
      cookieDomainCount: 2
    })

    await expect(checkPromise).rejects.toBeInstanceOf(ChaoxingAccessError)
  })

  it('keeps the sync slot exclusive across preflight auth and only cancels the matching operation', async () => {
    const store = openStore()
    let resolveCheck!: (value: Awaited<ReturnType<ChaoxingAdapterLike['checkSession']>>) => void
    const service = new ChaoxingSessionService(
      store,
      authenticatedAdapter({
        checkSession: () =>
          new Promise((resolve) => {
            resolveCheck = resolve
          })
      })
    )

    const first = service.syncWithAuthCheck(true, { operationId: 'd006-owner-a' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(
      service.sync(true, { operationId: 'd006-owner-b', operationKind: 'manual_sync' })
    ).rejects.toThrow('同步正在进行')
    service.cancel('d006-owner-b')
    expect(service.getStatus().lastOperationId).toBe('d006-owner-a')
    service.cancel('d006-owner-a')
    resolveCheck({
      authState: 'authenticated',
      message: '已登录',
      profile: { name: '测试同学', school: '示例大学', uid: '10001', fid: null },
      httpStatus: 200,
      transport: 'session_fetch',
      cookieDomainCount: 2
    })
    const result = await first
    expect(result.lastOperationState).toBe('cancelled')
    expect(result.lastOperationId).toBe('d006-owner-a')
    expect(result.lastRunCommitted).toBe(false)
  })

  it('owns an auto-login operation, ignores unrelated cancellation, and releases the slot afterwards', () => {
    const store = openStore()
    const service = new ChaoxingSessionService(store, authenticatedAdapter())
    const op = service.beginOwnedOperation('auto_login', 'd006-auto-login')

    expect(op.kind).toBe('auto_login')
    expect(service.getStatus().lastOperationId).toBe('d006-auto-login')
    expect(service.getStatus().lastOperationKind).toBe('auto_login')
    service.cancel('another-operation')
    expect(op.signal.aborted).toBe(false)
    service.cancel('d006-auto-login')
    expect(op.signal.aborted).toBe(true)
    expect(() => op.assertActive()).toThrow(ChaoxingAccessError)
    service.finishOwnedOperation('d006-auto-login')
    const next = service.beginOwnedOperation('auto_login', 'd006-auto-login-2')
    expect(next.id).toBe('d006-auto-login-2')
    service.finishOwnedOperation(next.id)
  })

  it('invalidates old pull writes and blocks new operations while the session is being reset', async () => {
    const store = openStore()
    store.clearDemoData()
    let rejectPull!: (error: unknown) => void
    let pullStarted!: () => void
    const started = new Promise<void>((resolve) => {
      pullStarted = resolve
    })
    const service = new ChaoxingSessionService(store, {
      checkSession: async () => ({
        authState: 'authenticated',
        message: '已登录',
        profile: { name: '测试同学', school: '示例大学', uid: '10001', fid: null },
        httpStatus: 200,
        transport: 'session_fetch',
        cookieDomainCount: 2
      }),
      pull: (signal?: AbortSignal) => {
        pullStarted()
        return new Promise((_resolve, reject) => {
          rejectPull = reject
          signal?.addEventListener('abort', () =>
            reject(new ChaoxingAccessError('CANCELLED', '同步已取消'))
          )
        })
      }
    })

    const syncPromise = service.sync(true, { operationId: 'd006-reset' })
    await started
    const before = service.getStatus()
    const resetStatus = service.beginSessionReset()
    expect(resetStatus.authState).toBe('logged_out')
    expect(service.getStatus().authState).toBe('logged_out')
    expect(service.getStatus().lastSyncAt).toBe(before.lastSyncAt)
    expect(() => service.beginOwnedOperation('auto_login', 'd006-during-reset')).toThrow(
      '正在清除学习通会话'
    )
    rejectPull(new ChaoxingAccessError('CANCELLED', '同步已取消'))
    const after = await syncPromise
    expect(store.listCourses()).toHaveLength(0)
    expect(after.lastSyncAt).toBe(before.lastSyncAt)
    expect(after.lastOperationId).toBe('d006-reset')
    expect(after.lastOperationState).toBe('cancelled')
    expect(after.lastRunCommitted).toBe(false)
    service.endSessionReset()
  })

  it('keeps a committed sync receipt when the session is cleared during portal restore', async () => {
    const store = openStore()
    store.clearDemoData()
    let resolveRestore!: (value: { restored: boolean; message: string | null }) => void
    const guard = {
      begin: async () => undefined,
      end: () =>
        new Promise<{ restored: boolean; message: string | null }>((resolve) => {
          resolveRestore = resolve
        })
    }
    const service = new ChaoxingSessionService(
      store,
      authenticatedAdapter(),
      () => undefined,
      () => undefined,
      guard
    )

    const syncPromise = service.sync(true, {
      operationId: 'd006-committed-receipt',
      operationKind: 'manual_sync'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(service.getStatus().lastRunCommitted).toBe(true)
    expect(service.getStatus().lastOutcome).toBe('success')

    const reset = service.beginSessionReset()
    expect(reset.authState).toBe('logged_out')
    expect(reset.userDisconnected).toBe(true)
    resolveRestore({ restored: false, message: '恢复被会话清理中断' })

    const result = await syncPromise
    expect(result.lastOperationId).toBe('d006-committed-receipt')
    expect(result.lastOutcome).toBe('success')
    expect(result.lastRunCommitted).toBe(true)
    expect(service.getStatus().authState).toBe('logged_out')
    service.endSessionReset()
  })

  it('freezes a cancelled receipt when the session is cleared during portal restore', async () => {
    const store = openStore()
    store.clearDemoData()
    let pullCount = 0
    let resolveRestore!: (value: { restored: boolean; message: string | null }) => void
    let blockRestore = false
    const service = new ChaoxingSessionService(
      store,
      authenticatedAdapter({
        pull: (signal?: AbortSignal) => {
          pullCount += 1
          if (pullCount === 1) return Promise.resolve(emptyPull())
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () =>
              reject(new ChaoxingAccessError('CANCELLED', '同步已取消'))
            )
          })
        }
      }),
      () => undefined,
      () => undefined,
      {
        begin: async () => undefined,
        end: () =>
          blockRestore
            ? new Promise<{ restored: boolean; message: string | null }>((resolve) => {
                resolveRestore = resolve
              })
            : Promise.resolve({ restored: true, message: null })
      }
    )

    const previous = await service.sync(true, {
      operationId: 'd006-previous-success',
      operationKind: 'manual_sync'
    })
    blockRestore = true
    const syncPromise = service.sync(true, {
      operationId: 'd006-late-cancel',
      operationKind: 'manual_sync'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    service.cancel('d006-late-cancel')
    await new Promise((resolve) => setTimeout(resolve, 0))
    service.beginSessionReset()
    resolveRestore({ restored: false, message: '恢复被会话清理中断' })

    const result = await syncPromise
    expect(result.lastOperationId).toBe('d006-late-cancel')
    expect(result.lastOperationState).toBe('cancelled')
    expect(result.lastRunCommitted).toBe(false)
    expect(result.lastSyncAt).toBe(previous.lastSyncAt)
    expect(service.getStatus().authState).toBe('logged_out')
    service.endSessionReset()
  })

  it('persists the user-disconnected marker across a service restart', () => {
    const store = openStore()
    const first = new ChaoxingSessionService(store, authenticatedAdapter())
    first.beginSessionReset()

    const second = new ChaoxingSessionService(store, authenticatedAdapter())
    expect(second.getStatus().authState).toBe('logged_out')
    expect(second.getStatus().userDisconnected).toBe(true)
  })

  it('does not publish an avatar loaded for a previous UID', async () => {
    const store = openStore()
    let uid = '10001'
    let resolveFirst!: (value: string | null) => void
    const events: Array<{ uid: string; avatarUrl: string }> = []
    const service = new ChaoxingSessionService(
      store,
      authenticatedAdapter({
        checkSession: async () => ({
          authState: 'authenticated',
          message: '已登录',
          profile: { name: '测试同学', school: '示例大学', uid, fid: null },
          httpStatus: 200,
          transport: 'session_fetch',
          cookieDomainCount: 2
        })
      }),
      () => undefined,
      () => undefined,
      undefined,
      (requestedUid) =>
        requestedUid === '10001'
          ? new Promise((resolve) => {
              resolveFirst = resolve
            })
          : Promise.resolve('data:image/png;base64,SECOND'),
      (event) => events.push({ uid: event.uid, avatarUrl: event.avatarUrl })
    )

    await service.check()
    uid = '10002'
    await service.check()
    resolveFirst('data:image/png;base64,FIRST')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(service.getStatus().avatarUrl).toBe('data:image/png;base64,SECOND')
    expect(events).toHaveLength(1)
    expect(events[0]?.uid).toBe('10002')
  })
})
