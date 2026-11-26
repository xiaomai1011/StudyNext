import { describe, expect, it } from 'vitest'
import type { ChaoxingSessionStatus, Course, SyncStatus, Task } from '@shared/types'
import {
  buildRecentOpenedTaskContext,
  classifyCourseRetryResult,
  classifyManualSyncResult,
  describePostSubmitVerification,
  isDataFreshnessStale,
  isSecurityBlockedMessage,
  resolveLastCompleteSyncAt,
  resolveSubmitVerificationPlan,
  resolveTopbarSyncIndicator,
  summarizeSyncIssueDetail
} from '@shared/sync-feedback'

function makeSyncStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    state: 'success',
    message: '同步完成',
    source: 'chaoxing',
    lastAttemptAt: '2026-11-24T10:00:00.000Z',
    lastSuccessAt: '2026-11-24T10:00:00.000Z',
    detail: null,
    snapshot: null,
    ...overrides
  }
}

function makeChaoxing(overrides: Partial<ChaoxingSessionStatus> = {}): ChaoxingSessionStatus {
  return {
    authState: 'authenticated',
    connection: 'web_session',
    message: '同步完成',
    displayName: '测试同学',
    school: '示例大学',
    studentId: '10001',
    avatarUrl: null,
    checkedAt: '2026-11-24T10:00:00.000Z',
    lastSyncAt: '2026-11-24T10:00:00.000Z',
    lastCompleteSyncAt: '2026-11-24T10:00:00.000Z',
    lastAttemptAt: '2026-11-24T10:00:00.000Z',
    lastOutcome: 'success',
    lastOutcomeMessage: '同步完成',
    lastOutcomeDetail: null,
    lastOutcomeAt: '2026-11-24T10:00:00.000Z',
    lastCourseRetryOutcome: null,
    syncedCourses: 3,
    syncedTasks: 5,
    syncedChapters: 12,
    syncedExams: 1,
    syncedNotices: 2,
    syncedMaterials: 4,
    transport: 'session_fetch',
    httpStatus: 200,
    cookieDomainCount: 3,
    detail: null,
    ...overrides
  }
}

function makeCourse(overrides: Partial<Course>): Course {
  return {
    id: 'course-1',
    externalId: '100:200',
    name: '高等数学',
    code: 'MATH101',
    teacher: '王老师',
    semester: '2026 秋',
    category: '必修课',
    color: '#2563eb',
    favorite: false,
    source: 'chaoxing',
    className: '1 班',
    clazzId: '200',
    sourceUrl: 'https://mooc1.chaoxing.com/course?courseid=100&clazzid=200&cpi=1',
    schedule: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides
  }
}

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-1',
    title: '第三章作业',
    description: '',
    courseId: 'course-1',
    priority: 'medium',
    kind: 'homework',
    status: 'todo',
    dueAt: '2026-11-25T10:00:00.000Z',
    completedAt: null,
    completionSource: null,
    source: 'chaoxing',
    externalId: '100:200:w1',
    sourceUpdatedAt: null,
    sourceUrl: 'https://mooc1.chaoxing.com/work/doHomeWorkNew?courseId=100&clazzId=200&workId=w1',
    platformStatus: '未交',
    platformStatusKind: 'not_submitted',
    submittedAt: null,
    score: null,
    fullScore: null,
    teacherFeedback: null,
    attachments: [],
    manualFields: [],
    fieldSources: {},
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    reminders: [],
    ...overrides
  }
}

describe('sync-feedback', () => {
  it('strictly preserves lastCompleteSyncAt and never promotes partial/import timestamps', () => {
    expect(
      resolveLastCompleteSyncAt(
        makeSyncStatus({ state: 'partial', lastSuccessAt: null }),
        makeChaoxing({
          lastOutcome: 'partial',
          lastSyncAt: '2026-11-24T11:00:00.000Z',
          lastCompleteSyncAt: null
        })
      )
    ).toBeNull()

    expect(
      resolveLastCompleteSyncAt(
        makeSyncStatus({ state: 'partial', lastSuccessAt: '2026-11-23T08:00:00.000Z' }),
        makeChaoxing({
          lastOutcome: 'partial',
          lastSyncAt: '2026-11-24T11:00:00.000Z',
          lastCompleteSyncAt: '2026-11-23T08:00:00.000Z'
        })
      )
    ).toBe('2026-11-23T08:00:00.000Z')

    expect(
      resolveLastCompleteSyncAt(
        makeSyncStatus({
          state: 'success',
          source: 'import',
          lastSuccessAt: '2026-11-24T09:00:00.000Z'
        }),
        makeChaoxing({ lastCompleteSyncAt: '2026-11-24T09:00:00.000Z' })
      )
    ).toBeNull()
  })

  it('detects stale data freshness based on auto-refresh interval and flags security blocks', () => {
    const now = Date.parse('2026-11-24T12:00:00.000Z')
    expect(isDataFreshnessStale('2026-11-24T11:30:00.000Z', 5, now)).toBe(false)
    expect(isDataFreshnessStale('2026-11-24T10:55:00.000Z', 5, now)).toBe(true)
    expect(isDataFreshnessStale('2026-11-24T10:55:00.000Z', 0, now)).toBe(true)
    expect(isDataFreshnessStale(null, 5, now)).toBe(false)

    expect(isSecurityBlockedMessage('学习通要求安全验证，自动同步已停止')).toBe(true)
    expect(isSecurityBlockedMessage('同步失败，本地数据未受影响', 'network timeout')).toBe(false)
    expect(summarizeSyncIssueDetail('  失败：通知读取失败 \n 警告：章节超时  ', 12)).toBe(
      '失败：通知读取失败 警…'
    )
  })

  it('never displays a green topbar dot on sync failure or partial outcome', () => {
    const failed = resolveTopbarSyncIndicator({
      syncStatus: makeSyncStatus({ state: 'failure', detail: 'ERR_CONNECTION_RESET' }),
      chaoxing: makeChaoxing({ authState: 'authenticated', lastOutcome: 'failure' }),
      autoSyncError: null,
      isSyncing: false,
      syncProgress: null
    })
    expect(failed.tone).toBe('danger')
    expect(failed.tooltip).toContain('ERR_CONNECTION_RESET')

    const partial = resolveTopbarSyncIndicator({
      syncStatus: makeSyncStatus({ state: 'partial', detail: '失败：通知读取失败' }),
      chaoxing: makeChaoxing({ authState: 'authenticated', lastOutcome: 'partial' }),
      autoSyncError: null,
      isSyncing: false,
      syncProgress: null
    })
    expect(partial.tone).toBe('warn')
    expect(partial.tooltip).toContain('失败：通知读取失败')

    const syncing = resolveTopbarSyncIndicator({
      syncStatus: makeSyncStatus(),
      chaoxing: makeChaoxing(),
      autoSyncError: null,
      isSyncing: true,
      syncProgress: { phase: 'homework', message: '正在同步作业…', current: 2, total: 5 }
    })
    expect(syncing.tone).toBe('syncing')
    expect(syncing.tooltip).toContain('2/5')
  })

  it('isolates single-course retry classification from previous full-sync failures', () => {
    const statusAfterFullFailThenCourseSuccess = makeChaoxing({
      lastOutcome: 'failure',
      lastOutcomeDetail: 'HTTP 502',
      lastCourseRetryOutcome: 'success',
      message: '课程重试完成：高等数学，2 项作业、5 个章节、1 个资料',
      detail: null
    })
    expect(classifyCourseRetryResult(statusAfterFullFailThenCourseSuccess)).toEqual({
      kind: 'success',
      message: '课程重试完成：高等数学，2 项作业、5 个章节、1 个资料',
      isFailure: false
    })
    expect(
      classifyManualSyncResult(
        makeChaoxing({
          lastOutcome: 'failure',
          message: '同步失败，本地数据未受影响',
          lastOutcomeDetail: 'HTTP 502'
        })
      )
    ).toMatchObject({ kind: 'error', isFailure: true })
  })

  it('enforces strict class and work identity during post-submit resolution (R01)', () => {
    const now = Date.parse('2026-11-24T12:00:00.000Z')
    const classA = makeCourse({
      id: 'c-a',
      externalId: '100:201',
      clazzId: '201',
      className: '1 班'
    })
    const classB = makeCourse({
      id: 'c-b',
      externalId: '100:202',
      clazzId: '202',
      className: '2 班'
    })
    const taskA = makeTask({
      id: 't-a',
      title: '1班作业',
      courseId: 'c-a',
      externalId: '100:201:workA',
      sourceUrl: 'https://mooc1.chaoxing.com/work?courseId=100&clazzId=201&workId=workA'
    })
    const taskB = makeTask({
      id: 't-b',
      title: '2班作业',
      courseId: 'c-b',
      externalId: '100:202:workB',
      sourceUrl: 'https://mooc1.chaoxing.com/work?courseId=100&clazzId=202&workId=workB'
    })
    const recentA = buildRecentOpenedTaskContext(taskA, classA, now - 60_000)

    // 1. Explicit class B + work B overrides recent class A
    const explicitB = resolveSubmitVerificationPlan(
      [classA, classB],
      [taskA, taskB],
      { platformCourseId: '100', platformClazzId: '202', platformWorkId: 'workB' },
      recentA,
      now
    )
    expect(explicitB).toEqual({
      targets: [{ course: classB, trackedTaskId: 't-b' }],
      reason: 'matched_explicit'
    })

    // 2. Explicit courseId only across multiple teaching classes must NEVER assume recent class A
    const ambiguousClass = resolveSubmitVerificationPlan(
      [classA, classB],
      [taskA, taskB],
      { platformCourseId: '100', platformClazzId: null, platformWorkId: null },
      recentA,
      now
    )
    expect(ambiguousClass.reason).toBe('matched_course_ambiguous_class')
    expect(ambiguousClass.targets).toEqual([
      { course: classA, trackedTaskId: null },
      { course: classB, trackedTaskId: null }
    ])

    // 3. Unmatched explicit courseId/clazzId must NEVER fall back to recent class A
    const unmatchedClass = resolveSubmitVerificationPlan(
      [classA, classB],
      [taskA, taskB],
      { platformCourseId: '100', platformClazzId: '999', platformWorkId: null },
      recentA,
      now
    )
    expect(unmatchedClass).toEqual({ targets: [], reason: 'unmatched_explicit' })

    const unmatchedCourse = resolveSubmitVerificationPlan(
      [classA, classB],
      [taskA, taskB],
      { platformCourseId: '999', platformClazzId: null, platformWorkId: null },
      recentA,
      now
    )
    expect(unmatchedCourse).toEqual({ targets: [], reason: 'unmatched_explicit' })

    // 4. Event without explicit workId NEVER infers recentOpenedTask.taskId (even in same class or fallback)
    const sameClassNoWorkId = resolveSubmitVerificationPlan(
      [classA, classB],
      [taskA, taskB],
      { platformCourseId: '100', platformClazzId: '201', platformWorkId: null },
      recentA,
      now
    )
    expect(sameClassNoWorkId).toEqual({
      targets: [{ course: classA, trackedTaskId: null }],
      reason: 'matched_explicit'
    })

    const fallbackRecent = resolveSubmitVerificationPlan(
      [classA, classB],
      [taskA, taskB],
      { platformCourseId: null, platformClazzId: null, platformWorkId: null },
      recentA,
      now
    )
    expect(fallbackRecent).toEqual({
      targets: [{ course: classA, trackedTaskId: null }],
      reason: 'fallback_recent'
    })
  })

  it('only announces specific task verification when target task appeared in the current platform read', () => {
    const before = makeTask({ platformStatusKind: 'not_submitted' })
    const stillOpen = makeTask({ platformStatusKind: 'not_submitted' })
    const submitted = makeTask({ platformStatusKind: 'submitted' })

    expect(
      describePostSubmitVerification(
        before,
        submitted,
        makeChaoxing({
          lastOutcome: 'failure',
          lastCourseRetryOutcome: 'success',
          lastCourseRetryObservedTaskExternalIds: ['100:200:w1']
        }),
        true
      )
    ).toMatchObject({
      kind: 'success',
      shouldRetryOnce: false
    })
    // Target task NOT observed in this read -> must NOT claim verified from stale cache!
    expect(
      describePostSubmitVerification(
        before,
        submitted,
        makeChaoxing({
          lastCourseRetryOutcome: 'success',
          lastCourseRetryObservedTaskExternalIds: ['100:200:other']
        }),
        true
      )
    ).toMatchObject({
      kind: 'info',
      shouldRetryOnce: false
    })
    expect(
      describePostSubmitVerification(
        before,
        submitted,
        makeChaoxing({
          lastCourseRetryOutcome: 'success',
          lastCourseRetryObservedTaskExternalIds: []
        }),
        true
      ).message
    ).toContain('本次平台回读未包含')
    expect(
      describePostSubmitVerification(
        before,
        stillOpen,
        makeChaoxing({
          lastCourseRetryOutcome: 'success',
          lastCourseRetryObservedTaskExternalIds: ['100:200:w1']
        }),
        true
      )
    ).toMatchObject({
      kind: 'info',
      shouldRetryOnce: true
    })
    expect(
      describePostSubmitVerification(
        before,
        submitted,
        makeChaoxing({
          lastCourseRetryOutcome: 'partial',
          lastCourseRetryObservedTaskExternalIds: ['100:200:w1'],
          message: '课程重试完成：高等数学；部分数据读取失败'
        }),
        true
      )
    ).toMatchObject({
      kind: 'info',
      shouldRetryOnce: false
    })
  })
})
