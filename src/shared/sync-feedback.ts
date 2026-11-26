import type {
  ChaoxingSessionStatus,
  Course,
  PortalSubmitEvent,
  SyncProgressEvent,
  SyncStatus,
  Task
} from './types'
import { isTaskActionable, platformStatusLabel } from './task-state'

export const SUBMIT_CONTEXT_WINDOW_MS = 30 * 60_000

/**
 * Returns the authoritative timestamp of the last COMPLETE platform sync.
 * Strictly respects `lastCompleteSyncAt` semantics:
 * - Local snapshot imports never count as a platform complete sync.
 * - Partial or failed syncs must never fall back to `chaoxing.lastSyncAt`.
 * - Only legacy successful sync records without `lastCompleteSyncAt` may fall
 *   back to `chaoxing.lastSyncAt`.
 */
export function resolveLastCompleteSyncAt(
  syncStatus: Pick<SyncStatus, 'state' | 'source' | 'lastSuccessAt'>,
  chaoxing: Pick<ChaoxingSessionStatus, 'lastCompleteSyncAt' | 'lastSyncAt' | 'lastOutcome'>
): string | null {
  if (syncStatus.source === 'import') return null
  if (syncStatus.lastSuccessAt) return syncStatus.lastSuccessAt
  if (chaoxing.lastCompleteSyncAt) return chaoxing.lastCompleteSyncAt
  if (
    syncStatus.state === 'success' &&
    (chaoxing.lastOutcome === 'success' ||
      chaoxing.lastOutcome === null ||
      chaoxing.lastOutcome === undefined)
  ) {
    return chaoxing.lastSyncAt ?? null
  }
  return null
}

/**
 * Returns true when the last complete sync is noticeably old so the UI can warn
 * the user that deadlines/statuses may be outdated without crying wolf on fresh data.
 */
export function isDataFreshnessStale(
  lastCompleteSyncAt: string | null | undefined,
  autoRefreshMinutes: number,
  nowMs = Date.now()
): boolean {
  if (!lastCompleteSyncAt) return false
  const parsed = Date.parse(lastCompleteSyncAt)
  if (!Number.isFinite(parsed)) return false
  const thresholdMinutes =
    Number.isFinite(autoRefreshMinutes) && autoRefreshMinutes > 0
      ? Math.max(autoRefreshMinutes * 3, 60)
      : 60
  return nowMs - parsed >= thresholdMinutes * 60_000
}

export function isSecurityBlockedMessage(
  message: string | null | undefined,
  detail?: string | null
): boolean {
  const combined = `${message ?? ''} ${detail ?? ''}`
  return /安全验证|验证码|BLOCKED/i.test(combined)
}

export function summarizeSyncIssueDetail(
  detail: string | null | undefined,
  maxLength = 120
): string | null {
  if (!detail) return null
  const normalized = detail.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`
}

export interface TopbarSyncIndicator {
  tone: 'syncing' | 'online' | 'warn' | 'danger'
  label: string
  tooltip: string
}

export function resolveTopbarSyncIndicator(input: {
  syncStatus: Pick<SyncStatus, 'state' | 'source' | 'message' | 'detail' | 'lastSuccessAt'>
  chaoxing: Pick<
    ChaoxingSessionStatus,
    | 'authState'
    | 'lastCompleteSyncAt'
    | 'lastSyncAt'
    | 'lastOutcome'
    | 'lastOutcomeDetail'
    | 'detail'
  >
  autoSyncError: string | null
  isSyncing: boolean
  syncProgress: SyncProgressEvent | null
  lastCompleteLabel?: string | null
}): TopbarSyncIndicator {
  const { syncStatus, chaoxing, autoSyncError, isSyncing, syncProgress, lastCompleteLabel } = input
  const snapshotImported = syncStatus.source === 'import'
  const authenticated = chaoxing.authState === 'authenticated'

  if (isSyncing) {
    const progressText = syncProgress?.message?.trim() || '正在同步学习通数据…'
    const step =
      syncProgress && syncProgress.total > 0
        ? ` (${syncProgress.current}/${syncProgress.total})`
        : ''
    return {
      tone: 'syncing',
      label: `正在同步${step}`,
      tooltip: `${progressText}${step}`
    }
  }

  if (syncStatus.state === 'failure' || Boolean(autoSyncError)) {
    const label = snapshotImported ? '快照导入失败 · 本地数据可用' : '同步失败 · 本地数据可用'
    const reason = summarizeSyncIssueDetail(
      autoSyncError ?? syncStatus.detail ?? chaoxing.lastOutcomeDetail ?? chaoxing.detail,
      90
    )
    return {
      tone: 'danger',
      label,
      tooltip: reason ? `${label}（${reason}）· 点击重试` : `${label} · 点击重试`
    }
  }

  if (syncStatus.state === 'partial') {
    const label = snapshotImported ? '快照部分导入 · 检查详情' : '部分同步 · 检查详情'
    const reason = summarizeSyncIssueDetail(
      syncStatus.detail ?? chaoxing.lastOutcomeDetail ?? chaoxing.detail,
      90
    )
    return {
      tone: 'warn',
      label,
      tooltip: reason ? `${label}（${reason}）· 点击重试` : `${label} · 点击重试`
    }
  }

  if (chaoxing.authState === 'expired') {
    return {
      tone: 'warn',
      label: '学习通会话已失效 · 点击重新登录',
      tooltip: '学习通会话已失效 · 点击重新登录'
    }
  }

  if (authenticated) {
    const label = '已连接学习通 · Web Session'
    return {
      tone: 'online',
      label,
      tooltip: lastCompleteLabel
        ? `${label} · 上次完整同步 ${lastCompleteLabel} · 点击同步`
        : `${label} · 点击同步`
    }
  }

  const label = snapshotImported ? '本地快照 · 未连接学习通' : '本地模式 · 未连接学习通'
  return {
    tone: 'warn',
    label,
    tooltip: `${label} · 点击连接学习通`
  }
}

export interface ManualSyncToast {
  kind: 'success' | 'info' | 'error'
  message: string
  isFailure: boolean
  isCancelled?: boolean
}

export function classifyManualSyncResult(
  status: Pick<
    ChaoxingSessionStatus,
    'authState' | 'message' | 'detail' | 'lastOutcome' | 'lastOutcomeDetail' | 'lastOperationState'
  >
): ManualSyncToast {
  const message = status.message?.trim() || '同步已完成'
  const detail = summarizeSyncIssueDetail(status.lastOutcomeDetail ?? status.detail, 90)

  if (status.lastOperationState === 'cancelled' || status.lastOutcome === 'cancelled') {
    return { kind: 'info', message, isFailure: false, isCancelled: true }
  }
  if (message.includes('同步已取消')) {
    return { kind: 'info', message, isFailure: false, isCancelled: true }
  }
  if (message.includes('使用短期缓存')) {
    return { kind: 'info', message, isFailure: false }
  }
  if (isSecurityBlockedMessage(message, detail)) {
    return { kind: 'error', message, isFailure: true }
  }
  if (
    status.lastOutcome === 'failure' ||
    status.authState === 'expired' ||
    status.authState === 'logged_out' ||
    message.startsWith('同步失败') ||
    message.startsWith('尚未在 Portal 登录')
  ) {
    return {
      kind: 'error',
      message: detail && !message.includes(detail) ? `${message}（${detail}）` : message,
      isFailure: true
    }
  }
  if (status.lastOutcome === 'partial' || message.includes('部分数据读取失败')) {
    return {
      kind: 'info',
      message: detail ? `${message}：${detail}` : message,
      isFailure: false
    }
  }
  return { kind: 'success', message, isFailure: false }
}

/**
 * Classifies a single-course retry result STRICTLY from this retry's own outcome.
 * Never reads full-sync `lastOutcome` or `lastOutcomeDetail`, preventing a
 * previous failed full sync from polluting a successful single-course refresh.
 */
export function classifyCourseRetryResult(
  status: Pick<ChaoxingSessionStatus, 'authState' | 'message' | 'detail' | 'lastCourseRetryOutcome'>
): ManualSyncToast {
  const message = status.message?.trim() || '课程重试已完成'
  const detail = summarizeSyncIssueDetail(status.detail, 90)

  if (status.lastCourseRetryOutcome === 'cancelled' || message.includes('同步已取消')) {
    return { kind: 'info', message, isFailure: false, isCancelled: true }
  }
  if (isSecurityBlockedMessage(message, detail)) {
    return { kind: 'error', message, isFailure: true }
  }
  if (
    status.lastCourseRetryOutcome === 'failure' ||
    status.authState === 'expired' ||
    status.authState === 'logged_out' ||
    message.startsWith('课程重试失败') ||
    message.startsWith('尚未在 Portal 登录')
  ) {
    return {
      kind: 'error',
      message: detail && !message.includes(detail) ? `${message}（${detail}）` : message,
      isFailure: true
    }
  }
  if (status.lastCourseRetryOutcome === 'partial' || message.includes('部分数据读取失败')) {
    return {
      kind: 'info',
      message: detail ? `${message}：${detail}` : message,
      isFailure: false
    }
  }
  return { kind: 'success', message, isFailure: false }
}

function readLowerQueryParams(rawUrl: string | null | undefined): Map<string, string> {
  const map = new Map<string, string>()
  if (!rawUrl) return map
  try {
    const parsed = new URL(rawUrl)
    for (const [key, value] of parsed.searchParams.entries()) {
      const lower = key.toLowerCase()
      if (!map.has(lower) && value.trim()) {
        map.set(lower, value.trim())
      }
    }
  } catch {
    // Ignore malformed URLs.
  }
  return map
}

export function extractCoursePlatformIds(
  course: Pick<Course, 'externalId' | 'clazzId' | 'sourceUrl'>
): { platformCourseId: string | null; platformClazzId: string | null } {
  const parts = (course.externalId ?? '').split(':').map((part) => part.trim())
  const params = readLowerQueryParams(course.sourceUrl)
  const platformCourseId = parts[0] || params.get('courseid') || null
  const platformClazzId =
    course.clazzId?.trim() || parts[1] || params.get('clazzid') || params.get('classid') || null
  return { platformCourseId, platformClazzId }
}

export function extractTaskPlatformWorkId(
  task: Pick<Task, 'externalId' | 'sourceUrl'>
): string | null {
  const params = readLowerQueryParams(task.sourceUrl)
  const fromUrl =
    params.get('workid') ??
    params.get('workanswerid') ??
    params.get('answerid') ??
    params.get('taskrefid') ??
    params.get('jobid') ??
    params.get('workrefid') ??
    null
  if (fromUrl) return fromUrl
  const parts = (task.externalId ?? '').split(':').map((part) => part.trim())
  if (parts.length >= 3) {
    const suffix = parts[2]
    if (suffix && !suffix.startsWith('t')) return suffix
  }
  return null
}

export interface RecentOpenedTaskContext {
  taskId: string
  courseId: string | null
  platformCourseId: string | null
  platformClazzId: string | null
  platformWorkId: string | null
  openedAt: number
}

export function buildRecentOpenedTaskContext(
  task: Pick<Task, 'id' | 'courseId' | 'externalId' | 'sourceUrl'>,
  course: Pick<Course, 'id' | 'externalId' | 'clazzId' | 'sourceUrl'> | null | undefined,
  openedAt = Date.now()
): RecentOpenedTaskContext {
  const courseIds = course
    ? extractCoursePlatformIds(course)
    : { platformCourseId: null, platformClazzId: null }
  return {
    taskId: task.id,
    courseId: course?.id ?? task.courseId ?? null,
    platformCourseId: courseIds.platformCourseId,
    platformClazzId: courseIds.platformClazzId,
    platformWorkId: extractTaskPlatformWorkId(task),
    openedAt
  }
}

export interface SubmitVerificationTarget {
  course: Course
  /** Non-null ONLY when the submitted work/class identity is verified to match this exact task. */
  trackedTaskId: string | null
}

export interface SubmitVerificationPlan {
  targets: SubmitVerificationTarget[]
  reason:
    | 'matched_explicit'
    | 'matched_course_ambiguous_class'
    | 'fallback_recent'
    | 'unmatched_explicit'
    | 'unidentifiable'
}

/**
 * Resolves post-submission verification targets with strict identity safety:
 * 1. Explicit event IDs (`platformWorkId`, `platformClazzId`, `platformCourseId`)
 *    always take priority.
 * 2. When explicit IDs cannot match any local course/class, NEVER fall back to
 *    a recently opened task from a different class/course.
 * 3. Same `platformCourseId` across multiple teaching classes NEVER implies
 *    class equality — refresh all matched classes without claiming a specific
 *    task from `recentOpenedTask` was verified.
 * 4. Only bind `trackedTaskId` when identity is genuinely proven.
 */
export function resolveSubmitVerificationPlan(
  courses: readonly Course[],
  tasks: readonly Task[],
  event: Pick<PortalSubmitEvent, 'platformCourseId' | 'platformClazzId' | 'platformWorkId'>,
  recentOpenedTask: RecentOpenedTaskContext | null,
  nowMs = Date.now()
): SubmitVerificationPlan {
  const chaoxingCourses = courses.filter((course) => course.source === 'chaoxing')
  const courseById = new Map(chaoxingCourses.map((course) => [course.id, course]))
  const eventCourseId = event.platformCourseId?.trim() || null
  const eventClazzId = event.platformClazzId?.trim() || null
  const eventWorkId = event.platformWorkId?.trim() || null
  const hasExplicitId = Boolean(eventCourseId || eventClazzId || eventWorkId)

  const recentValid =
    recentOpenedTask &&
    recentOpenedTask.courseId &&
    nowMs - recentOpenedTask.openedAt <= SUBMIT_CONTEXT_WINDOW_MS
      ? recentOpenedTask
      : null
  const recentCourse = recentValid?.courseId ? (courseById.get(recentValid.courseId) ?? null) : null

  const matchesCourseFilters = (course: Course): boolean => {
    const ids = extractCoursePlatformIds(course)
    if (eventCourseId && ids.platformCourseId !== eventCourseId) return false
    if (eventClazzId && ids.platformClazzId !== eventClazzId) return false
    return true
  }

  if (hasExplicitId) {
    // 1) Explicit work ID present: match exact task + class/course constraints first.
    if (eventWorkId) {
      const matchedTasks = tasks.filter((task) => {
        if (task.source !== 'chaoxing' || !task.courseId) return false
        const course = courseById.get(task.courseId)
        if (!course || !matchesCourseFilters(course)) return false
        return extractTaskPlatformWorkId(task) === eventWorkId
      })
      if (matchedTasks.length > 0) {
        const seen = new Set<string>()
        const targets: SubmitVerificationTarget[] = []
        for (const task of matchedTasks) {
          const course = task.courseId ? courseById.get(task.courseId) : undefined
          if (!course || seen.has(course.id)) continue
          seen.add(course.id)
          const sameCourseTasks = matchedTasks.filter((item) => item.courseId === course.id)
          targets.push({
            course,
            trackedTaskId: sameCourseTasks.length === 1 ? task.id : null
          })
        }
        return { targets, reason: 'matched_explicit' }
      }
      // Explicit workId was not found locally: only fall back to course-level
      // refresh if explicit courseId/clazzId match local course(s), NEVER binding recentOpenedTask.taskId.
      if (!eventCourseId && !eventClazzId) {
        return { targets: [], reason: 'unmatched_explicit' }
      }
    }

    const matchedCourses = chaoxingCourses.filter(matchesCourseFilters)
    if (matchedCourses.length === 0) {
      return { targets: [], reason: 'unmatched_explicit' }
    }

    if (matchedCourses.length > 1) {
      // Multiple teaching classes share platformCourseId (and eventClazzId didn't disambiguate).
      // Never assume recentOpenedTask's class is the one submitted; refresh all matched classes without claiming a specific task.
      return {
        targets: matchedCourses.map((course) => ({ course, trackedTaskId: null })),
        reason: 'matched_course_ambiguous_class'
      }
    }

    const uniqueCourse = matchedCourses[0]!
    // 缺少明确平台作业 ID（eventWorkId）时，不得借由最近打开的作业推断提交对象，
    // 仅刷新课程并报告课程级同步结果，避免同班不同作业提交被误报为旧作业核验成功。
    return {
      targets: [
        {
          course: uniqueCourse,
          trackedTaskId: null
        }
      ],
      reason: 'matched_explicit'
    }
  }

  // No explicit IDs in submission event: fall back to recently opened course for
  // course-level refresh only, NEVER inferring which specific task was submitted.
  if (recentValid && recentCourse) {
    return {
      targets: [{ course: recentCourse, trackedTaskId: null }],
      reason: 'fallback_recent'
    }
  }

  return { targets: [], reason: 'unidentifiable' }
}

export interface PostSubmitVerificationOutcome {
  kind: 'success' | 'info' | 'error'
  message: string
  shouldRetryOnce: boolean
}

export function describePostSubmitVerification(
  beforeTask: Pick<Task, 'title' | 'status' | 'platformStatusKind'> | null,
  afterTask: Pick<Task, 'title' | 'status' | 'platformStatusKind' | 'externalId'> | null,
  status: Pick<
    ChaoxingSessionStatus,
    | 'authState'
    | 'message'
    | 'detail'
    | 'lastCourseRetryOutcome'
    | 'lastCourseRetryObservedTaskExternalIds'
  >,
  canRetry: boolean
): PostSubmitVerificationOutcome {
  const retryResult = classifyCourseRetryResult(status)
  if (retryResult.isCancelled) {
    return {
      kind: 'info',
      message: '提交后核验已取消，可稍后手动刷新课程状态',
      shouldRetryOnce: false
    }
  }
  if (retryResult.isFailure || status.authState !== 'authenticated') {
    return {
      kind: 'error',
      message:
        status.authState !== 'authenticated'
          ? '提交后核验失败：学习通登录状态已失效，请重新登录后手动刷新'
          : `提交后核验失败：${retryResult.message}`,
      shouldRetryOnce: false
    }
  }
  if (retryResult.kind === 'info') {
    return {
      kind: 'info',
      message: '已重新读取本课状态，但部分数据读取失败；请核对作业状态或稍后手动刷新',
      shouldRetryOnce: false
    }
  }
  if (afterTask) {
    // 必须确认本次平台回读实际包含目标作业，绝不使用旧缓存记录宣称核验成功。
    const observedIds = status.lastCourseRetryObservedTaskExternalIds
    const observedInCurrentRead = Boolean(
      afterTask.externalId &&
      Array.isArray(observedIds) &&
      observedIds.includes(afterTask.externalId)
    )
    if (!observedInCurrentRead) {
      return {
        kind: 'info',
        message: `已刷新本课状态，但本次平台回读未包含「${afterTask.title}」，请以学习通页面为准或稍后手动同步`,
        shouldRetryOnce: false
      }
    }
    if (!isTaskActionable(afterTask)) {
      return {
        kind: 'success',
        message: `已核验「${afterTask.title}」最新状态：${platformStatusLabel(afterTask.platformStatusKind)}`,
        shouldRetryOnce: false
      }
    }
    if (beforeTask && isTaskActionable(beforeTask)) {
      if (canRetry) {
        return {
          kind: 'info',
          message: `「${afterTask.title}」暂未同步到已提交状态，平台可能存在延迟，5 秒后将自动复核一次…`,
          shouldRetryOnce: true
        }
      }
      return {
        kind: 'info',
        message: `已刷新本课状态，「${afterTask.title}」仍显示为「${platformStatusLabel(afterTask.platformStatusKind)}」；若刚提交成功可稍后手动同步`,
        shouldRetryOnce: false
      }
    }
  }
  return {
    kind: 'success',
    message: '已重新同步本课平台状态',
    shouldRetryOnce: false
  }
}
