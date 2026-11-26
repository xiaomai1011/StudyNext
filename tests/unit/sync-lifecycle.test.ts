import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BootstrapData,
  ChaoxingSessionStatus,
  Course,
  SyncProgressEvent,
  Task
} from '@shared/types'
import { StudyNextStore } from '../../src/main/storage/store'
import { SyncService } from '../../src/main/integrations/sync'
import {
  ChaoxingAccessError,
  ChaoxingSessionAdapter,
  type ChaoxingAdapterLike,
  type ChaoxingPullResult
} from '../../src/main/integrations/chaoxing/adapter'
import { ChaoxingSessionService } from '../../src/main/integrations/chaoxing/service'
import { buildRecentOpenedTaskContext } from '@shared/sync-feedback'
import { SyncController, type SyncCoordinatorSnapshot } from '@shared/sync-controller'

const AUTH_PROFILE = { name: '测试同学', school: '示例大学', uid: '10001', fid: '427' }

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
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

function seedChaoxingCourse(
  store: StudyNextStore,
  externalId: string,
  name: string,
  clazzId: string
): Course {
  return store.upsertProviderCourse(
    {
      externalId,
      name,
      teacher: '王老师',
      clazzId,
      className: `${clazzId}班`,
      sourceUrl: `https://mooc1.chaoxing.com/course?courseid=${externalId.split(':')[0]}&clazzid=${clazzId}&cpi=1`
    },
    'chaoxing'
  ).course
}

function seedChaoxingTask(
  store: StudyNextStore,
  courseId: string,
  externalId: string,
  title: string,
  workId: string,
  platformStatusKind: Task['platformStatusKind'] = 'not_submitted'
): Task {
  return store.upsertImportedTask(
    {
      title,
      description: '',
      courseId,
      priority: 'medium',
      kind: 'homework',
      status: 'todo',
      dueAt: '2026-11-28T10:00:00.000Z',
      reminderOffsets: [60],
      sourceUrl: `https://mooc1.chaoxing.com/work/doHomeWorkNew?courseId=${externalId.split(':')[0]}&clazzId=${externalId.split(':')[1]}&workId=${workId}`
    },
    {
      externalId,
      source: 'chaoxing',
      sourceUpdatedAt: '2026-11-24T10:00:00.000Z',
      platformStatus: platformStatusKind === 'submitted' ? '已提交' : '未交',
      platformStatusKind
    }
  ).task
}

function makeBootstrap(
  store: StudyNextStore,
  chaoxing: ChaoxingSessionStatus,
  sync: SyncService
): BootstrapData {
  return {
    courses: store.listCourses(),
    chapters: store.listChapters(),
    studyPoints: store.listStudyPoints(),
    tasks: store.listTasks(),
    exams: store.listExams(),
    materials: store.listMaterials(),
    settings: store.getSettings(),
    notices: store.listNotices(),
    syncStatus: sync.getStatus(),
    chaoxing,
    officialEntries: store.listOfficialEntries(),
    appInfo: {
      version: '0.5.0',
      platform: 'win32',
      dataPath: ':memory:',
      isPackaged: false,
      workspace: { id: 'local', mode: 'local', accountId: null }
    },
    reminderRuntime: {
      mode: 'process_running',
      note: '',
      systemNotificationsSupported: false,
      startupCatchUpCount: 0,
      nextReminderAt: null,
      system: {
        supported: false,
        taskName: null,
        registered: false,
        executablePath: null,
        nextRunAt: null,
        lastCheckAt: null,
        lastDeliveryAt: null,
        lastDeliveryError: null,
        lastScheduleError: null,
        lastError: null,
        needsReregister: false
      }
    }
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

describe('N-003-R 同步身份、互斥、取消与单课结果回归', () => {
  it('R01: 同课程多教学班提交时优先精确匹配提交教学班，明确 ID 不匹配时不回退到最近打开教学班', async () => {
    const store = openStore()
    const sync = new SyncService(store)
    const classA = seedChaoxingCourse(store, '100:201', '高等数学', '201')
    const classB = seedChaoxingCourse(store, '100:202', '高等数学', '202')
    const taskA = seedChaoxingTask(
      store,
      classA.id,
      '100:201:workA',
      '1班作业',
      'workA',
      'not_submitted'
    )
    seedChaoxingTask(store, classB.id, '100:202:workB', '2班作业', 'workB', 'not_submitted')

    const retriedCourses: string[] = []
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
      pullCourse: async (externalId) => {
        retriedCourses.push(externalId)
        if (externalId === '100:202') {
          return emptyPull({
            courses: [
              {
                externalId: '100:202',
                courseId: '100',
                cpi: '1',
                name: '高等数学',
                teacher: '王老师',
                clazzId: '202',
                sourceUrl: classB.sourceUrl ?? '',
                schedule: []
              }
            ],
            tasks: [
              {
                externalId: '100:202:workB',
                courseExternalId: '100:202',
                title: '2班作业',
                description: '',
                dueAt: '2026-11-28T10:00:00.000Z',
                sourceUrl:
                  'https://mooc1.chaoxing.com/work/doHomeWorkNew?courseId=100&clazzId=202&workId=workB',
                platformStatus: '已提交',
                platformStatusKind: 'submitted',
                submittedAt: null,
                score: null,
                fullScore: null,
                teacherFeedback: null,
                attachments: []
              }
            ]
          })
        }
        return emptyPull()
      }
    }

    const service = new ChaoxingSessionService(store, adapter, (o) => sync.recordSessionResult(o))
    let currentData = makeBootstrap(store, service.getStatus(), sync)
    const toasts: Array<{ kind: string; message: string }> = []
    const controller = new SyncController({
      api: {
        check: () => service.check(),
        autoLogin: async () => ({ ok: true, message: 'ok' }),
        sync: (force) => service.sync(force),
        retryCourse: (courseId) => service.retryCourse(courseId),
        cancel: async () => service.cancel()
      },
      getData: () => currentData,
      setChaoxingStatus: (s) => {
        currentData = { ...currentData, chaoxing: s }
      },
      refreshBootstrap: async () => {
        currentData = makeBootstrap(store, service.getStatus(), sync)
        return currentData
      },
      setAutoSyncError: () => undefined,
      notify: (kind, message) => toasts.push({ kind, message }),
      errorMessage: (e) => (e instanceof Error ? e.message : String(e)),
      canRunAutoSync: () => true,
      getRecentOpenedTask: () => buildRecentOpenedTaskContext(taskA, classA, Date.now()),
      delay: async () => undefined
    })

    // Case 1: User recently opened class A, but submits workB in class B
    await controller.handleSubmitDetected(
      {
        url: 'https://mooc1.chaoxing.com/work/prompt',
        platformCourseId: '100',
        platformClazzId: '202',
        platformWorkId: 'workB',
        detectedAt: new Date().toISOString()
      },
      { initialDelayMs: 0, busyRetryDelayMs: 0, lagRetryDelayMs: 0 }
    )
    expect(retriedCourses).toEqual(['100:202'])
    expect(
      toasts.some(
        (t) => t.kind === 'success' && t.message.includes('已核验「2班作业」最新状态：已提交')
      )
    ).toBe(true)
    expect(toasts.some((t) => t.message.includes('1班作业'))).toBe(false)

    // Case 2: Event carries an explicit clazzId that doesn't match any local class -> must NOT fall back to class A
    retriedCourses.length = 0
    toasts.length = 0
    await controller.handleSubmitDetected(
      {
        url: 'https://mooc1.chaoxing.com/work/prompt',
        platformCourseId: '100',
        platformClazzId: '999',
        platformWorkId: null,
        detectedAt: new Date().toISOString()
      },
      { initialDelayMs: 0, busyRetryDelayMs: 0, lagRetryDelayMs: 0 }
    )
    expect(retriedCourses).toEqual([])
    expect(toasts.some((t) => t.kind === 'error' && t.message.includes('未匹配到本地记录'))).toBe(
      true
    )

    // Case 3: Event carries only platformCourseId (ambiguous across class A & B) -> refreshes both, never claims class A's task verified
    retriedCourses.length = 0
    toasts.length = 0
    await controller.handleSubmitDetected(
      {
        url: 'https://mooc1.chaoxing.com/work/prompt',
        platformCourseId: '100',
        platformClazzId: null,
        platformWorkId: null,
        detectedAt: new Date().toISOString()
      },
      { initialDelayMs: 0, busyRetryDelayMs: 0, lagRetryDelayMs: 0 }
    )
    expect(retriedCourses).toEqual(['100:201', '100:202'])
    expect(toasts.some((t) => t.message.includes('1班作业'))).toBe(false)
  })

  it('R02: 提交核验期间触发全量同步遵守互斥，不报告虚假成功且不提前清除持有者进度', async () => {
    const store = openStore()
    const sync = new SyncService(store)
    const course = seedChaoxingCourse(store, '100:201', '高等数学', '201')
    const task = seedChaoxingTask(
      store,
      course.id,
      '100:201:work1',
      '作业一',
      'work1',
      'not_submitted'
    )
    const gate = deferred<void>()
    let pullCalls = 0
    let onProgressRef: ((event: SyncProgressEvent) => void) | undefined

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
      pullCourse: async () => {
        onProgressRef?.({
          phase: 'homework',
          message: '正在核验高等数学作业…',
          current: 1,
          total: 1
        })
        await gate.promise
        return emptyPull({
          courses: [
            {
              externalId: '100:201',
              courseId: '100',
              cpi: '1',
              name: '高等数学',
              teacher: '王老师',
              clazzId: '201',
              sourceUrl: course.sourceUrl ?? '',
              schedule: []
            }
          ],
          tasks: [
            {
              externalId: '100:201:work1',
              courseExternalId: '100:201',
              title: '作业一',
              description: '',
              dueAt: '2026-11-28T10:00:00.000Z',
              sourceUrl: task.sourceUrl,
              platformStatus: '已提交',
              platformStatusKind: 'submitted',
              submittedAt: null,
              score: null,
              fullScore: null,
              teacherFeedback: null,
              attachments: []
            }
          ]
        })
      }
    }

    const snapshots: SyncCoordinatorSnapshot[] = []
    let controller!: SyncController
    const service = new ChaoxingSessionService(
      store,
      adapter,
      (o) => sync.recordSessionResult(o),
      (event) => controller?.handleProgressEvent(event)
    )
    onProgressRef = (event) => controller.handleProgressEvent(event)

    let currentData = makeBootstrap(store, service.getStatus(), sync)
    const toasts: Array<{ kind: string; message: string }> = []
    controller = new SyncController({
      api: {
        check: () => service.check(),
        autoLogin: async () => ({ ok: true, message: 'ok' }),
        sync: (force) => service.sync(force),
        retryCourse: (courseId) => service.retryCourse(courseId),
        cancel: async () => service.cancel()
      },
      getData: () => currentData,
      setChaoxingStatus: (s) => {
        currentData = { ...currentData, chaoxing: s }
      },
      refreshBootstrap: async () => {
        currentData = makeBootstrap(store, service.getStatus(), sync)
        return currentData
      },
      setAutoSyncError: () => undefined,
      notify: (kind, message) => toasts.push({ kind, message }),
      errorMessage: (e) => (e instanceof Error ? e.message : String(e)),
      canRunAutoSync: () => true,
      getRecentOpenedTask: () => buildRecentOpenedTaskContext(task, course, Date.now()),
      delay: async () => undefined,
      onStateChange: (s) => snapshots.push(s)
    })

    // Start submit verification (blocks on gate)
    const verifyPromise = controller.handleSubmitDetected(
      {
        url: 'https://mooc1.chaoxing.com/work/prompt',
        platformCourseId: '100',
        platformClazzId: '201',
        platformWorkId: 'work1',
        detectedAt: new Date().toISOString()
      },
      { initialDelayMs: 0, busyRetryDelayMs: 0, lagRetryDelayMs: 0 }
    )
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(controller.getSnapshot().isSyncing).toBe(true)
    expect(controller.getSnapshot().activeKind).toBe('submit_verify')
    expect(controller.getSnapshot().progress?.message).toBe('正在核验高等数学作业…')

    // Main-process ChaoxingSessionService.sync() must also reject with CHAOXING_SYNC_BUSY instead of returning stale status
    await expect(service.sync(true)).rejects.toThrow('同步正在进行')

    // Trigger manual full sync while submit verification is active
    const manualResult = await controller.runManualSync(true)
    expect(manualResult.executed).toBe(false)
    expect(pullCalls).toBe(0)
    // Must NOT report success and must NOT clear submit_verify's active state/progress!
    expect(toasts.some((t) => t.kind === 'success')).toBe(false)
    expect(toasts.some((t) => t.kind === 'info' && t.message.includes('同步正在进行'))).toBe(true)
    expect(controller.getSnapshot().isSyncing).toBe(true)
    expect(controller.getSnapshot().activeKind).toBe('submit_verify')
    expect(controller.getSnapshot().progress?.message).toBe('正在核验高等数学作业…')

    // Finish submit verification -> only owner clears syncing & progress
    gate.resolve()
    await verifyPromise
    expect(controller.getSnapshot().isSyncing).toBe(false)
    expect(controller.getSnapshot().progress).toBeNull()
    expect(
      toasts.some(
        (t) => t.kind === 'success' && t.message.includes('已核验「作业一」最新状态：已提交')
      )
    ).toBe(true)
  })

  it('R03: 鉴权阶段取消不被后续 pull 覆盖、不影响下一次同步，且不误报已落库操作为已取消', async () => {
    const store = openStore()
    const sync = new SyncService(store)
    const authGate = deferred<void>()
    let pullStarted = 0

    const courseListHtml = `<ul class="course-list">
      <li>
        <a href="/visit/stucoursemiddle?courseid=1001&clazzid=2001&cpi=3001&ismooc2=1">
          <span class="course-name" title="数据结构">数据结构</span>
        </a>
        <p class="line2 color3" title="张老师">张老师</p>
      </li>
    </ul>`

    // Real ChaoxingSessionAdapter wired with a mocked HTTP client so we exercise real adapter.pull(signal)
    const fakeClient = {
      countCookieDomains: async () => 2,
      request: vi.fn(async ({ url }: { url: string }) => {
        pullStarted += 1
        if (url.includes('i.chaoxing.com/base')) {
          return {
            status: 200,
            finalUrl: 'https://i.chaoxing.com/base',
            body: '<title>个人空间</title><iframe id="frame_content"></iframe><div class="personalName">测试同学</div><p>示例大学</p><input id="uid" value="10001" />',
            transport: 'session_fetch' as const
          }
        }
        return {
          status: 200,
          finalUrl: url,
          body: '<div class="bottomList"><ul></ul></div>',
          transport: 'session_fetch' as const
        }
      })
    }
    const adapter = new ChaoxingSessionAdapter(
      fakeClient as never,
      async () => courseListHtml,
      async () => JSON.stringify({ curriculum: {}, weeks: [] }),
      async () => '<ul></ul>',
      async () => null,
      async () => JSON.stringify({ notices: { list: [] } }),
      async () => null
    )
    const progressEvents: SyncProgressEvent[] = []
    const service = new ChaoxingSessionService(
      store,
      adapter,
      (o) => sync.recordSessionResult(o),
      (ev) => progressEvents.push(ev)
    )

    // 1. Cancel DURING beforePull (auth verification gate)
    const firstSync = service.sync(true, {
      beforePull: async () => {
        await authGate.promise
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    service.cancel()
    authGate.resolve()

    const cancelledStatus = await firstSync
    expect(pullStarted).toBe(0) // pull NEVER started after cancel during auth!
    expect(cancelledStatus.message).toContain('同步已取消')
    expect(progressEvents.at(-1)?.phase).toBe('done')

    // 2. Next sync MUST NOT be affected by previous cancellation
    const secondStatus = await service.sync(true)
    expect(pullStarted).toBeGreaterThan(0)
    expect(secondStatus.authState).toBe('authenticated')
    expect(secondStatus.syncedCourses).toBe(1)
    expect(secondStatus.lastOutcome).not.toBe('failure')
    expect(secondStatus.message).not.toContain('同步已取消')
    expect(progressEvents.at(-1)?.phase).toBe('done')

    // 2b. Cancel arriving during adapter.checkSession() stops before loadCourses()
    const sessionGate = deferred<void>()
    let loadCoursesCalled = false
    const checkCancelClient = {
      countCookieDomains: async () => 2,
      request: vi.fn(async ({ url }: { url: string }) => {
        if (url.includes('i.chaoxing.com/base')) {
          await sessionGate.promise
          return {
            status: 200,
            finalUrl: 'https://i.chaoxing.com/base',
            body: '<title>个人空间</title><iframe id="frame_content"></iframe><div class="personalName">测试同学</div>',
            transport: 'session_fetch' as const
          }
        }
        loadCoursesCalled = true
        return {
          status: 200,
          finalUrl: url,
          body: courseListHtml,
          transport: 'session_fetch' as const
        }
      })
    }
    const checkCancelAdapter = new ChaoxingSessionAdapter(checkCancelClient as never, async () => {
      loadCoursesCalled = true
      return courseListHtml
    })
    const checkCancelService = new ChaoxingSessionService(store, checkCancelAdapter)
    const midAuthSync = checkCancelService.sync(true)
    await new Promise((resolve) => setTimeout(resolve, 10))
    checkCancelService.cancel()
    sessionGate.resolve()
    const midAuthStatus = await midAuthSync
    expect(midAuthStatus.message).toContain('同步已取消')
    expect(loadCoursesCalled).toBe(false)

    // 3. Cancel during renderer runAutoSync auth step never triggers sync()
    const checkGate = deferred<ChaoxingSessionStatus>()
    const syncSpy = vi.fn(async () => secondStatus)
    const autoToasts: Array<{ kind: string; message: string }> = []
    const autoController = new SyncController({
      api: {
        check: () => checkGate.promise,
        autoLogin: async () => ({ ok: true, message: 'ok' }),
        sync: syncSpy,
        retryCourse: async () => secondStatus,
        cancel: async () => service.cancel()
      },
      getData: () => makeBootstrap(store, secondStatus, sync),
      setChaoxingStatus: () => undefined,
      refreshBootstrap: async () => makeBootstrap(store, secondStatus, sync),
      setAutoSyncError: () => undefined,
      notify: (kind, message) => autoToasts.push({ kind, message }),
      errorMessage: (e) => (e instanceof Error ? e.message : String(e)),
      canRunAutoSync: () => true,
      getRecentOpenedTask: () => null
    })

    const autoPromise = autoController.runAutoSync('startup')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await autoController.requestCancel()
    checkGate.resolve(secondStatus)
    expect(await autoPromise).toBe(false)
    expect(syncSpy).not.toHaveBeenCalled()
    expect(autoController.getSnapshot().isSyncing).toBe(false)
    expect(autoController.getSnapshot().cancelling).toBe(false)

    // 4. Cancel arriving AFTER persistence already committed must NOT misreport cancelled
    const endNavGate = deferred<void>()
    const lateStore = openStore()
    const lateSync = new SyncService(lateStore)
    const lateService = new ChaoxingSessionService(
      lateStore,
      {
        checkSession: async () => ({
          authState: 'authenticated',
          message: '已登录',
          profile: AUTH_PROFILE,
          httpStatus: 200,
          transport: 'session_fetch',
          cookieDomainCount: 2
        }),
        pull: async () =>
          emptyPull({
            courses: [
              {
                externalId: '200:301',
                courseId: '200',
                cpi: '1',
                name: '数据结构',
                teacher: '李老师',
                clazzId: '301',
                sourceUrl: 'https://mooc1.chaoxing.com/course?courseid=200&clazzid=301&cpi=1',
                schedule: []
              }
            ]
          })
      },
      (o) => lateSync.recordSessionResult(o),
      undefined,
      {
        begin: async () => undefined,
        end: async () => {
          await endNavGate.promise
          return { restored: true, message: null }
        }
      }
    )

    const lateToasts: Array<{ kind: string; message: string }> = []
    const lateController = new SyncController({
      api: {
        check: () => lateService.check(),
        autoLogin: async () => ({ ok: true, message: 'ok' }),
        sync: (force) => lateService.sync(force),
        retryCourse: (id) => lateService.retryCourse(id),
        cancel: async () => lateService.cancel()
      },
      getData: () => makeBootstrap(lateStore, lateService.getStatus(), lateSync),
      setChaoxingStatus: () => undefined,
      refreshBootstrap: async () => makeBootstrap(lateStore, lateService.getStatus(), lateSync),
      setAutoSyncError: () => undefined,
      notify: (kind, message) => lateToasts.push({ kind, message }),
      errorMessage: (e) => (e instanceof Error ? e.message : String(e)),
      canRunAutoSync: () => true,
      getRecentOpenedTask: () => null
    })

    const lateSyncPromise = lateController.runManualSync(true)
    await new Promise((resolve) => setTimeout(resolve, 15))
    // Data is already persisted by now; navigationGuard.end() is still waiting
    expect(lateStore.listCourses()).toHaveLength(1)
    await lateController.requestCancel()
    endNavGate.resolve()
    const lateResult = await lateSyncPromise
    expect(lateResult.status?.lastOutcome).toBe('success')
    expect(lateToasts.some((t) => t.message.includes('取消请求无法撤销已完成持久化'))).toBe(true)
    expect(lateToasts.some((t) => t.message.includes('本地数据未受影响'))).toBe(false)
  })

  it('R04: 全量同步失败后单课重试成功不受污染，单课失败也不破坏全量状态与 lastCompleteSyncAt', async () => {
    const store = openStore()
    const sync = new SyncService(store)
    const course = seedChaoxingCourse(store, '100:201', '操作系统', '201')
    let shouldFailFull = false
    let shouldFailCourse = false

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
        if (shouldFailFull) throw new Error('HTTP 502 Bad Gateway')
        return emptyPull()
      },
      pullCourse: async () => {
        if (shouldFailCourse) throw new ChaoxingAccessError('NETWORK', '单课网络超时')
        return emptyPull({
          courses: [
            {
              externalId: '100:201',
              courseId: '100',
              cpi: '1',
              name: '操作系统',
              teacher: '王老师',
              clazzId: '201',
              sourceUrl: course.sourceUrl ?? '',
              schedule: []
            }
          ]
        })
      }
    }

    const service = new ChaoxingSessionService(store, adapter, (o) => sync.recordSessionResult(o))
    let currentData = makeBootstrap(store, service.getStatus(), sync)
    let autoSyncError: string | null = null
    const toasts: Array<{ kind: string; message: string }> = []

    const controller = new SyncController({
      api: {
        check: () => service.check(),
        autoLogin: async () => ({ ok: true, message: 'ok' }),
        sync: (force) => service.sync(force),
        retryCourse: (id) => service.retryCourse(id),
        cancel: async () => service.cancel()
      },
      getData: () => currentData,
      setChaoxingStatus: (s) => {
        currentData = { ...currentData, chaoxing: s }
      },
      refreshBootstrap: async () => {
        currentData = makeBootstrap(store, service.getStatus(), sync)
        return currentData
      },
      setAutoSyncError: (err) => {
        autoSyncError = err
      },
      notify: (kind, message) => toasts.push({ kind, message }),
      errorMessage: (e) => (e instanceof Error ? e.message : String(e)),
      canRunAutoSync: () => true,
      getRecentOpenedTask: () => null
    })

    // 1. Initial complete full sync establishes T1
    await controller.runManualSync(true)
    const t1 = service.getStatus().lastCompleteSyncAt
    expect(t1).not.toBeNull()

    // 2. Subsequent full sync fails -> lastOutcome = 'failure', lastCompleteSyncAt stays T1
    shouldFailFull = true
    toasts.length = 0
    await controller.runManualSync(true)
    expect(service.getStatus().lastOutcome).toBe('failure')
    expect(service.getStatus().lastCompleteSyncAt).toBe(t1)
    expect(sync.getStatus().state).toBe('failure')
    expect(autoSyncError).toContain('HTTP 502')

    // 3. Single-course retry SUCCEEDS -> must toast success (NOT polluted by HTTP 502!)
    //    and must preserve full-sync failure state + lastCompleteSyncAt = T1
    toasts.length = 0
    await controller.runCourseRetry(course)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.kind).toBe('success')
    expect(toasts[0]?.message).toContain('课程重试完成：操作系统')
    expect(toasts[0]?.message).not.toContain('HTTP 502')
    expect(service.getStatus().lastOutcome).toBe('failure')
    expect(service.getStatus().lastCompleteSyncAt).toBe(t1)
    expect(sync.getStatus().state).toBe('failure')
    expect(sync.getStatus().lastSuccessAt).toBe(t1)

    // 4. Single-course retry FAILS -> must toast course failure and preserve T1
    shouldFailCourse = true
    toasts.length = 0
    await controller.runCourseRetry(course)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.kind).toBe('error')
    expect(toasts[0]?.message).toContain('课程重试失败')
    expect(service.getStatus().lastCompleteSyncAt).toBe(t1)
    expect(sync.getStatus().lastSuccessAt).toBe(t1)
  })

  it('N-003-R2 #1: 同班不同作业缺 workId 时不借用最近打开作业，且目标作业未出现在本次回读时不宣称核验成功', async () => {
    const store = openStore()
    const sync = new SyncService(store)
    const course = seedChaoxingCourse(store, '100:201', '高等数学', '201')
    // Homework A is ALREADY cached as submitted in local SQLite!
    const taskA = seedChaoxingTask(store, course.id, '100:201:workA', '作业A', 'workA', 'submitted')
    seedChaoxingTask(store, course.id, '100:201:workB', '作业B', 'workB', 'not_submitted')

    let returnedTasks: ChaoxingPullResult['tasks'] = []
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
      pullCourse: async () =>
        emptyPull({
          courses: [
            {
              externalId: '100:201',
              courseId: '100',
              cpi: '1',
              name: '高等数学',
              teacher: '王老师',
              clazzId: '201',
              sourceUrl: course.sourceUrl ?? '',
              schedule: []
            }
          ],
          tasks: returnedTasks
        })
    }

    const service = new ChaoxingSessionService(store, adapter, (o) => sync.recordSessionResult(o))
    let currentData = makeBootstrap(store, service.getStatus(), sync)
    const toasts: Array<{ kind: string; message: string }> = []
    const controller = new SyncController({
      api: {
        check: () => service.check(),
        autoLogin: async () => ({ ok: true, message: 'ok' }),
        sync: (force) => service.sync(force),
        retryCourse: (id) => service.retryCourse(id),
        cancel: async () => service.cancel()
      },
      getData: () => currentData,
      setChaoxingStatus: (s) => {
        currentData = { ...currentData, chaoxing: s }
      },
      refreshBootstrap: async () => {
        currentData = makeBootstrap(store, service.getStatus(), sync)
        return currentData
      },
      setAutoSyncError: () => undefined,
      notify: (kind, message) => toasts.push({ kind, message }),
      errorMessage: (e) => (e instanceof Error ? e.message : String(e)),
      canRunAutoSync: () => true,
      getRecentOpenedTask: () => buildRecentOpenedTaskContext(taskA, course, Date.now()),
      delay: async () => undefined
    })

    // Scenario A: Same class, different task submitted, prompt URL omits workId -> must report course refresh only, NEVER "已核验「作业A」"
    returnedTasks = [
      {
        externalId: '100:201:workA',
        courseExternalId: '100:201',
        title: '作业A',
        description: '',
        dueAt: '2026-11-28T10:00:00.000Z',
        sourceUrl: taskA.sourceUrl,
        platformStatus: '已提交',
        platformStatusKind: 'submitted',
        submittedAt: null,
        score: null,
        fullScore: null,
        teacherFeedback: null,
        attachments: []
      }
    ]
    await controller.handleSubmitDetected(
      {
        url: 'https://mooc1.chaoxing.com/work/prompt',
        platformCourseId: '100',
        platformClazzId: '201',
        platformWorkId: null,
        detectedAt: new Date().toISOString()
      },
      { initialDelayMs: 0, busyRetryDelayMs: 0, lagRetryDelayMs: 0 }
    )
    expect(toasts.some((t) => t.kind === 'success' && t.message === '已重新同步本课平台状态')).toBe(
      true
    )
    expect(toasts.some((t) => t.message.includes('作业A'))).toBe(false)

    // Scenario B: Explicit workId=workA, but THIS platform pull returns empty tasks (workA NOT observed!)
    // Must NOT use stale cached SQLite row (which has submitted) to claim verification success!
    toasts.length = 0
    returnedTasks = []
    await controller.handleSubmitDetected(
      {
        url: 'https://mooc1.chaoxing.com/work/prompt',
        platformCourseId: '100',
        platformClazzId: '201',
        platformWorkId: 'workA',
        detectedAt: new Date().toISOString()
      },
      { initialDelayMs: 0, busyRetryDelayMs: 0, lagRetryDelayMs: 0 }
    )
    expect(toasts.some((t) => t.kind === 'success')).toBe(false)
    expect(
      toasts.some((t) => t.kind === 'info' && t.message.includes('本次平台回读未包含「作业A」'))
    ).toBe(true)
  })

  it('N-003-R2 #2: 提交核验期间点击设置页「仅同步学习通」及通用同步均按真实结果反馈，不以缓存态误报成功', async () => {
    const store = openStore()
    const sync = new SyncService(store)
    const course = seedChaoxingCourse(store, '100:201', '编译原理', '201')
    const task = seedChaoxingTask(store, course.id, '100:201:w1', '词法分析', 'w1', 'not_submitted')
    const gate = deferred<void>()
    let failManual = false

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
        if (failManual) throw new Error('upstream 503')
        return emptyPull()
      },
      pullCourse: async () => {
        await gate.promise
        return emptyPull({
          courses: [
            {
              externalId: '100:201',
              courseId: '100',
              cpi: '1',
              name: '编译原理',
              teacher: '王老师',
              clazzId: '201',
              sourceUrl: course.sourceUrl ?? '',
              schedule: []
            }
          ],
          tasks: [
            {
              externalId: '100:201:w1',
              courseExternalId: '100:201',
              title: '词法分析',
              description: '',
              dueAt: '2026-11-28T10:00:00.000Z',
              sourceUrl: task.sourceUrl,
              platformStatus: '已提交',
              platformStatusKind: 'submitted',
              submittedAt: null,
              score: null,
              fullScore: null,
              teacherFeedback: null,
              attachments: []
            }
          ]
        })
      }
    }

    const service = new ChaoxingSessionService(store, adapter, (o) => sync.recordSessionResult(o))
    // Seed a prior successful authenticated status in cache (the exact trap Settings previously fell into!)
    await service.sync(true)
    expect(service.getStatus().authState).toBe('authenticated')

    let currentData = makeBootstrap(store, service.getStatus(), sync)
    const appToasts: Array<{ kind: string; message: string }> = []
    const settingsToasts: Array<{ kind: string; message: string }> = []
    const controller = new SyncController({
      api: {
        check: () => service.check(),
        autoLogin: async () => ({ ok: true, message: 'ok' }),
        sync: (force) => service.sync(force),
        retryCourse: (id) => service.retryCourse(id),
        cancel: async () => service.cancel()
      },
      getData: () => currentData,
      setChaoxingStatus: (s) => {
        currentData = { ...currentData, chaoxing: s }
      },
      refreshBootstrap: async () => {
        currentData = makeBootstrap(store, service.getStatus(), sync)
        return currentData
      },
      setAutoSyncError: () => undefined,
      notify: (kind, message) => appToasts.push({ kind, message }),
      errorMessage: (e) => (e instanceof Error ? e.message : String(e)),
      canRunAutoSync: () => true,
      getRecentOpenedTask: () => null,
      delay: async () => undefined
    })

    // Start submit verification (holds mutex)
    const verifyPromise = controller.handleSubmitDetected(
      {
        url: 'https://mooc1.chaoxing.com/work/prompt',
        platformCourseId: '100',
        platformClazzId: '201',
        platformWorkId: 'w1',
        detectedAt: new Date().toISOString()
      },
      { initialDelayMs: 0, busyRetryDelayMs: 0, lagRetryDelayMs: 0 }
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(controller.getSnapshot().activeKind).toBe('submit_verify')

    // Exact Settings.tsx syncChaoxing call chain: App passes (force) => runManualSync(force, { silent: true })
    // and Settings consumes result.toastKind / result.message
    const settingsSyncResult = await controller.runManualSync(true, { silent: true })
    settingsToasts.push({ kind: settingsSyncResult.toastKind, message: settingsSyncResult.message })
    expect(settingsSyncResult.outcome).toBe('busy')
    expect(settingsSyncResult.executed).toBe(false)
    expect(settingsSyncResult.status).toBeNull()
    expect(settingsToasts[0]?.kind).toBe('info')
    expect(settingsToasts[0]?.message).toContain('同步正在进行中')
    // Must never disrupt submit_verify ownership!
    expect(controller.getSnapshot().isSyncing).toBe(true)
    expect(controller.getSnapshot().activeKind).toBe('submit_verify')

    // Exact Settings.tsx runSync call chain while busy
    const settingsRunResult = await controller.runSyncRun(async () => sync.getStatus(), {
      silent: true
    })
    expect(settingsRunResult.outcome).toBe('busy')
    expect(settingsRunResult.executed).toBe(false)
    expect(settingsRunResult.toastKind).toBe('info')

    gate.resolve()
    await verifyPromise
    expect(controller.getSnapshot().isSyncing).toBe(false)

    // When Settings triggers sync after idle and it FAILS while still authenticated -> must report failure/error, NOT success!
    failManual = true
    const failedResult = await controller.runManualSync(true, { silent: true })
    expect(failedResult.outcome).toBe('failure')
    expect(failedResult.executed).toBe(true)
    expect(failedResult.toastKind).toBe('error')
    expect(failedResult.message).toContain('upstream 503')
  })

  it('N-003-R2 #3: 自动同步鉴权未结束时通过 Portal 入口打开作业，取消接入协调器且不再发起全量拉取', async () => {
    const store = openStore()
    const sync = new SyncService(store)
    const checkGate = deferred<ChaoxingSessionStatus>()
    const authStatus: ChaoxingSessionStatus = {
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

    const syncSpy = vi.fn(async () => ({
      ...authStatus,
      lastOutcome: 'success' as const,
      message: '同步完成'
    }))
    const cancelSpy = vi.fn(async () => authStatus)
    let portalOverlayOpen = false
    let syncSuspendUntil = 0
    const toasts: Array<{ kind: string; message: string }> = []

    const controller = new SyncController({
      api: {
        check: () => checkGate.promise,
        autoLogin: async () => ({ ok: true, message: 'ok' }),
        sync: syncSpy,
        retryCourse: async () => authStatus,
        cancel: cancelSpy
      },
      getData: () => makeBootstrap(store, authStatus, sync),
      setChaoxingStatus: () => undefined,
      refreshBootstrap: async () => makeBootstrap(store, authStatus, sync),
      setAutoSyncError: () => undefined,
      notify: (kind, message) => toasts.push({ kind, message }),
      errorMessage: (e) => (e instanceof Error ? e.message : String(e)),
      canRunAutoSync: () => !portalOverlayOpen && Date.now() >= syncSuspendUntil,
      getRecentOpenedTask: () => null
    })

    // 1. Start auto-sync; it blocks inside api.check() (auth phase before pull)
    const autoSyncPromise = controller.runAutoSync('startup')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(controller.getSnapshot().isSyncing).toBe(true)
    expect(controller.getSnapshot().activeKind).toBe('auto_sync')

    // 2. Simulate the real handleOpenTaskInPortal entry: suspend auto-sync + cancelForPortalOpen + open Portal
    syncSuspendUntil = Date.now() + 60_000
    await controller.cancelForPortalOpen()
    portalOverlayOpen = true
    expect(cancelSpy).toHaveBeenCalledTimes(1)

    // 3. Auth finishes AFTER user already opened homework in Portal
    checkGate.resolve(authStatus)
    const autoSyncOk = await autoSyncPromise
    expect(autoSyncOk).toBe(false)
    expect(syncSpy).not.toHaveBeenCalled()
    expect(controller.getSnapshot().isSyncing).toBe(false)
    expect(controller.getSnapshot().cancelling).toBe(false)
    expect(toasts.some((t) => t.kind === 'error')).toBe(false)

    // 4. After closing Portal, a fresh manual sync must succeed cleanly (no leaked cancel!)
    portalOverlayOpen = false
    syncSuspendUntil = 0
    const nextManual = await controller.runManualSync(true)
    expect(nextManual.outcome).toBe('success')
    expect(nextManual.executed).toBe(true)
    expect(syncSpy).toHaveBeenCalledTimes(1)
  })
})
