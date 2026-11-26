import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChaoxingSessionStatus, Course, SyncStatus, Task } from '@shared/types'
import { StudyNextStore } from '../../src/main/storage/store'
import {
  ChaoxingAccessError,
  type ChaoxingAdapterLike,
  type ChaoxingPullResult
} from '../../src/main/integrations/chaoxing/adapter'
import { ChaoxingSessionService } from '../../src/main/integrations/chaoxing/service'
import { SyncController } from '@shared/sync-controller'

const AUTH_PROFILE = { name: '测试同学', school: '示例大学', uid: '10001', fid: '427' }

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function emptyPull(overrides: Partial<ChaoxingPullResult> = {}): ChaoxingPullResult {
  return {
    courses: [],
    tasks: [],
    errors: [],
    warnings: [],
    checkedAt: new Date().toISOString(),
    ...overrides
  }
}

function authStatus(): ChaoxingSessionStatus {
  return {
    authState: 'authenticated',
    connection: 'web_session',
    message: '已登录',
    displayName: '测试同学',
    school: '示例大学',
    studentId: '10001',
    avatarUrl: null,
    checkedAt: new Date().toISOString(),
    lastSyncAt: null,
    lastCompleteSyncAt: null,
    lastAttemptAt: null,
    lastOutcome: null,
    lastOutcomeMessage: null,
    lastOutcomeDetail: null,
    lastOutcomeAt: null,
    lastCourseRetryOutcome: null,
    lastCourseRetryObservedTaskExternalIds: null,
    lastRunCached: null,
    syncedCourses: 0,
    syncedTasks: 0,
    syncedChapters: 0,
    syncedExams: 0,
    syncedNotices: 0,
    syncedMaterials: 0,
    transport: 'session_fetch',
    httpStatus: 200,
    cookieDomainCount: 2,
    detail: null
  }
}

function seedCourse(store: StudyNextStore): Course {
  return store.upsertProviderCourse(
    {
      externalId: '100:201',
      name: '高等数学',
      teacher: '王老师',
      clazzId: '201',
      className: '1班',
      sourceUrl: 'https://mooc1.chaoxing.com/course?courseid=100&clazzid=201&cpi=1'
    },
    'chaoxing'
  ).course
}

function seedTask(store: StudyNextStore, course: Course): Task {
  return store.upsertImportedTask(
    {
      title: '作业一',
      description: '',
      courseId: course.id,
      priority: 'medium',
      kind: 'homework',
      status: 'todo',
      dueAt: '2026-11-28T10:00:00.000Z',
      reminderOffsets: [60],
      sourceUrl: 'https://mooc1.chaoxing.com/work/doHomeWorkNew?courseId=100&clazzId=201&workId=w1'
    },
    {
      externalId: '100:201:work1',
      source: 'chaoxing',
      sourceUpdatedAt: '2026-11-24T10:00:00.000Z',
      platformStatus: '未交',
      platformStatusKind: 'not_submitted'
    }
  ).task
}

function courseBundle(course: Course): ChaoxingPullResult['courses'][number] {
  return {
    externalId: '100:201',
    courseId: '100',
    cpi: '1',
    name: course.name,
    teacher: course.teacher,
    clazzId: '201',
    sourceUrl: course.sourceUrl ?? '',
    schedule: []
  }
}

function taskRecord(task: Task): ChaoxingPullResult['tasks'][number] {
  return {
    externalId: '100:201:work1',
    courseExternalId: '100:201',
    title: task.title,
    description: '',
    dueAt: task.dueAt,
    sourceUrl: task.sourceUrl ?? '',
    platformStatus: '已提交',
    platformStatusKind: 'submitted',
    submittedAt: null,
    score: null,
    fullScore: null,
    teacherFeedback: null,
    attachments: []
  }
}

const stores: StudyNextStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function openStore(): StudyNextStore {
  const store = new StudyNextStore(':memory:')
  stores.push(store)
  return store
}

describe('D-005 同步生命周期回归', () => {
  it('R01: check 完成后合并当前状态，不覆盖并发 retry 的回读证据', async () => {
    const store = openStore()
    const course = seedCourse(store)
    const task = seedTask(store, course)
    const checkGate = deferred<void>()
    const pullGate = deferred<void>()

    const adapter: ChaoxingAdapterLike = {
      checkSession: async () => {
        await checkGate.promise
        return {
          authState: 'authenticated',
          message: '已登录',
          profile: AUTH_PROFILE,
          httpStatus: 200,
          transport: 'session_fetch',
          cookieDomainCount: 2
        }
      },
      pull: async () => emptyPull(),
      pullCourse: async () => {
        await pullGate.promise
        return emptyPull({ courses: [courseBundle(course)], tasks: [taskRecord(task)] })
      }
    }
    const service = new ChaoxingSessionService(store, adapter)

    const checkPromise = service.check()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const retryPromise = service.retryCourse(course.id)
    await new Promise((resolve) => setTimeout(resolve, 5))
    pullGate.resolve()
    await retryPromise
    checkGate.resolve()

    const checked = await checkPromise
    expect(checked.lastCourseRetryObservedTaskExternalIds).toContain('100:201:work1')
    expect(checked.lastCourseRetryOutcome).toBe('success')
  })

  it('R02: syncWithAuthCheck 在首次鉴权期间取消，不会继续发起 pull', async () => {
    const store = openStore()
    const checkGate = deferred<void>()
    let pullCalls = 0
    let checkSignal: AbortSignal | undefined
    const adapter: ChaoxingAdapterLike = {
      checkSession: async (signal?: AbortSignal) => {
        checkSignal = signal
        await checkGate.promise
        if (signal?.aborted) {
          const error = new Error('请求已取消')
          error.name = 'AbortError'
          throw error
        }
        return {
          authState: 'authenticated',
          message: '已登录',
          profile: AUTH_PROFILE,
          httpStatus: 200,
          transport: 'session_fetch',
          cookieDomainCount: 2
        }
      },
      pull: async () => {
        pullCalls += 1
        return emptyPull()
      },
      pullCourse: async () => emptyPull()
    }
    const service = new ChaoxingSessionService(store, adapter)
    const promise = service.syncWithAuthCheck()
    await new Promise((resolve) => setTimeout(resolve, 5))
    service.cancel()
    expect(checkSignal?.aborted).toBe(true)
    checkGate.resolve()

    const result = await promise
    expect(result.lastOperationState).toBe('cancelled')
    expect(result.lastRunCommitted).toBe(false)
    expect(pullCalls).toBe(0)
  })

  it('R02a: 拉取前账号核验等待期间取消，不会继续发起 pull', async () => {
    const store = openStore()
    const gate = deferred<void>()
    let pullCalls = 0
    let beforePullSignal: AbortSignal | undefined
    const adapter: ChaoxingAdapterLike = {
      checkSession: async () => ({
        authState: 'authenticated',
        message: '已登录',
        profile: AUTH_PROFILE,
        httpStatus: 200,
        transport: 'session_fetch',
        cookieDomainCount: 2
      }),
      pull: async () => {
        pullCalls += 1
        return emptyPull()
      },
      pullCourse: async () => emptyPull()
    }
    const service = new ChaoxingSessionService(store, adapter)
    const promise = service.syncWithAuthCheck(true, {
      beforePull: async (signal) => {
        beforePullSignal = signal
        await gate.promise
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    service.cancel()
    expect(beforePullSignal?.aborted).toBe(true)
    gate.resolve()

    const result = await promise
    expect(result.lastOperationState).toBe('cancelled')
    expect(result.lastRunCommitted).toBe(false)
    expect(pullCalls).toBe(0)
  })

  it('R02b: 鉴权成功后课程拉取返回 401 时保留 expired 与 pull 阶段', async () => {
    const store = openStore()
    const adapter: ChaoxingAdapterLike = {
      checkSession: async () => ({
        authState: 'authenticated',
        message: '已登录',
        profile: AUTH_PROFILE,
        httpStatus: 200,
        transport: 'session_fetch',
        cookieDomainCount: 2
      }),
      pull: async () => {
        throw new ChaoxingAccessError('EXPIRED', '课程拉取返回 401')
      },
      pullCourse: async () => emptyPull()
    }
    const service = new ChaoxingSessionService(store, adapter)
    const status = await service.syncWithAuthCheck(true)
    expect(status.authState).toBe('expired')
    expect(status.lastRunStage).toBe('pull')
    expect(status.lastOutcome).toBe('failure')
  })

  it('R03: 缓存命中会保留 lastRunCached 且不重新发起 pull', async () => {
    const store = openStore()
    let pullCalls = 0
    const adapter: ChaoxingAdapterLike = {
      checkSession: async () => ({
        authState: 'authenticated',
        message: '已登录',
        profile: AUTH_PROFILE,
        httpStatus: 200,
        transport: 'session_fetch',
        cookieDomainCount: 2
      }),
      pull: async () => {
        pullCalls += 1
        return emptyPull()
      },
      pullCourse: async () => emptyPull()
    }
    const service = new ChaoxingSessionService(store, adapter)
    const first = await service.syncWithAuthCheck(true)
    expect(first.lastRunCached).toBe(false)
    const second = await service.syncWithAuthCheck(false)
    expect(second.lastRunCached).toBe(true)
    expect(pullCalls).toBe(1)
  })

  it('R04: runSyncRun 将 cached 结果映射为 info 提示而非成功', async () => {
    const cachedStatus: SyncStatus = {
      state: 'success',
      message: '最近 5 分钟内已同步，本次使用短期缓存',
      source: 'chaoxing',
      lastAttemptAt: null,
      lastSuccessAt: null,
      detail: null,
      snapshot: null,
      cached: true
    }
    const controller = new SyncController({
      api: {
        check: async () => authStatus(),
        autoLogin: async () => ({ ok: true, message: 'ok' }),
        sync: async () => authStatus(),
        retryCourse: async () => authStatus(),
        cancel: async () => authStatus()
      },
      getData: () => null,
      setChaoxingStatus: () => undefined,
      refreshBootstrap: async () => ({}) as never,
      setAutoSyncError: () => undefined,
      notify: vi.fn(),
      errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
      canRunAutoSync: () => true,
      getRecentOpenedTask: () => null
    })
    const result = await controller.runSyncRun(async () => cachedStatus)
    expect(result.outcome).toBe('cached')
    expect(result.toastKind).toBe('info')
    expect(result.message).toContain('短期缓存')
  })

  it('R04b: runSyncRun 以结构化 partial 为准，即使 legacy state 被历史成功污染', async () => {
    const partialStatus: SyncStatus = {
      state: 'success',
      message: '部分数据读取失败，本地旧数据已保留',
      source: 'chaoxing',
      lastAttemptAt: null,
      lastSuccessAt: null,
      detail: '课程 B 请求失败',
      snapshot: null,
      operationState: 'partial',
      committed: true
    }
    const controller = new SyncController({
      api: {
        check: async () => authStatus(),
        autoLogin: async () => ({ ok: true, message: 'ok' }),
        sync: async () => authStatus(),
        retryCourse: async () => authStatus(),
        cancel: async () => authStatus()
      },
      getData: () => null,
      setChaoxingStatus: () => undefined,
      refreshBootstrap: async () => ({}) as never,
      setAutoSyncError: () => undefined,
      notify: vi.fn(),
      errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
      canRunAutoSync: () => true,
      getRecentOpenedTask: () => null
    })
    const result = await controller.runSyncRun(async () => partialStatus)
    expect(result.outcome).toBe('partial')
    expect(result.toastKind).toBe('info')
    expect(result.message).toContain('部分数据读取失败')
  })

  it('R05: 缓存结果只属于本次响应，不污染可持久化状态', async () => {
    const store = openStore()
    const adapter: ChaoxingAdapterLike = {
      checkSession: async () => ({
        authState: 'authenticated',
        message: '已登录',
        profile: AUTH_PROFILE,
        httpStatus: 200,
        transport: 'session_fetch',
        cookieDomainCount: 2
      }),
      pull: async () => emptyPull(),
      pullCourse: async () => emptyPull()
    }
    const service = new ChaoxingSessionService(store, adapter)
    await service.syncWithAuthCheck(true)
    const stableStatus = service.getStatus()
    const cached = await service.syncWithAuthCheck(false)

    expect(cached.lastRunCached).toBe(true)
    expect(cached.message).toContain('短期缓存')
    expect(stableStatus.lastRunCached).toBe(false)
    expect(service.getStatus().lastRunCached).toBe(false)
    expect(service.getStatus().message).toBe('已登录')
  })

  it('R06: 头像加载不阻塞鉴权完成', async () => {
    vi.useFakeTimers()
    try {
      const store = openStore()
      let resolveAvatar!: (value: string | null) => void
      const avatarGate = new Promise<string | null>((resolve) => {
        resolveAvatar = resolve
      })
      const adapter: ChaoxingAdapterLike = {
        checkSession: async () => ({
          authState: 'authenticated',
          message: '已登录',
          profile: AUTH_PROFILE,
          httpStatus: 200,
          transport: 'session_fetch',
          cookieDomainCount: 2
        }),
        pull: async () => emptyPull(),
        pullCourse: async () => emptyPull()
      }
      const service = new ChaoxingSessionService(
        store,
        adapter,
        () => undefined,
        () => undefined,
        undefined,
        () => avatarGate
      )
      const checked = await service.check()
      expect(checked.authState).toBe('authenticated')
      expect(service.getStatus().avatarUrl).toContain('photo.chaoxing.com')

      resolveAvatar('data:image/png;base64,avatar')
      await Promise.resolve()
      await Promise.resolve()
      vi.advanceTimersByTime(3_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('R07: 拉取阶段主动取消保留上次成功结果，不误报 failure', async () => {
    const store = openStore()
    let cancelPull = false
    const adapter: ChaoxingAdapterLike = {
      checkSession: async () => ({
        authState: 'authenticated',
        message: '已登录',
        profile: AUTH_PROFILE,
        httpStatus: 200,
        transport: 'session_fetch',
        cookieDomainCount: 2
      }),
      pull: async () => {
        if (cancelPull) throw new ChaoxingAccessError('CANCELLED', '同步已取消')
        return emptyPull()
      },
      pullCourse: async () => emptyPull()
    }
    const service = new ChaoxingSessionService(store, adapter)
    const first = await service.syncWithAuthCheck(true)
    expect(first.lastOutcome).toBe('success')

    cancelPull = true
    const cancelled = await service.syncWithAuthCheck(true)
    expect(cancelled.lastOperationState).toBe('cancelled')
    expect(cancelled.lastRunCommitted).toBe(false)
    expect(cancelled.lastOutcome).toBe('success')
    const status = service.getStatus()
    expect(status.lastOutcome).toBe('success')
    expect(status.message).toContain('同步已取消')
    expect(status.lastRunCached).toBe(false)
  })
})
