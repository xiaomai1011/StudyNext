import type { PlatformStatusKind, PortalState, Task } from './types'
import { dueBucket } from './domain'
import { isAllowedPortalUrl, isPortalLoginUrl, normalizePortalTargetUrl } from './portal-url'

export const PLATFORM_STATUS_LABEL: Record<PlatformStatusKind, string> = {
  not_submitted: '未提交',
  submitted: '已提交',
  pending_review: '待审核',
  reviewed: '已批阅',
  done: '已完成',
  unknown: '未知'
}

export function platformStatusLabel(kind: PlatformStatusKind): string {
  return PLATFORM_STATUS_LABEL[kind] ?? '未知'
}

export function isPlatformTask(task: Pick<Task, 'source'>): boolean {
  return task.source === 'chaoxing'
}

export function isHttpUrl(value: string | null | undefined): value is string {
  if (!value || !value.trim()) return false
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export interface TaskOpenTarget {
  url: string
  kind: 'task' | 'course'
}

/**
 * Returns a safe Portal target for the embedded viewer, aligned with the strict
 * Portal allowlist (`ALLOWED_PORTAL_HOSTS`). A valid task URL wins; if missing
 * or outside the allowlist, a valid course URL is used as an explicit fallback.
 * No URL is ever inferred from titles or other mutable fields.
 */
export function getTaskOpenTarget(
  task: Pick<Task, 'sourceUrl'>,
  course: Pick<Task, 'sourceUrl'> | { sourceUrl: string | null } | null | undefined
): TaskOpenTarget | null {
  const taskUrl = normalizePortalTargetUrl(task.sourceUrl)
  if (taskUrl) {
    return { url: taskUrl, kind: 'task' }
  }
  const courseUrl = normalizePortalTargetUrl(course?.sourceUrl)
  if (courseUrl) {
    return { url: courseUrl, kind: 'course' }
  }
  return null
}

const TERMINAL_PLATFORM_STATUS: ReadonlySet<PlatformStatusKind> = new Set([
  'submitted',
  'pending_review',
  'reviewed',
  'done'
])

/** A task can open the homework answer flow only while it is still actionable. */
export function isTaskActionable(task: Pick<Task, 'status' | 'platformStatusKind'>): boolean {
  return task.status !== 'done' && !TERMINAL_PLATFORM_STATUS.has(task.platformStatusKind)
}

export type TaskPortalActionKind = 'answer' | 'view' | 'course' | 'unavailable'

export interface TaskPortalAction {
  kind: TaskPortalActionKind
  label: '去作答' | '查看作业' | '打开课程页' | '无可用入口'
  title: string
  disabled: boolean
  target: TaskOpenTarget | null
}

/**
 * Single source of truth for a portal action. The label depends on the task's
 * current state AND the destination that will actually be opened:
 * - a task page is actionable only while the platform status is non-terminal;
 * - a course page is an explicit fallback, never presented as homework intake;
 * - no safe URL means a disabled control with a concrete reason.
 */
export function getTaskPortalAction(
  task: Pick<Task, 'status' | 'platformStatusKind' | 'sourceUrl'>,
  course: Pick<Task, 'sourceUrl'> | { sourceUrl: string | null } | null | undefined
): TaskPortalAction {
  const target = getTaskOpenTarget(task, course)
  if (!target) {
    return {
      kind: 'unavailable',
      label: '无可用入口',
      title: '学习通未提供该作业或课程的官方入口，请从所属课程页进入',
      disabled: true,
      target: null
    }
  }
  if (target.kind === 'course') {
    return {
      kind: 'course',
      label: '打开课程页',
      title: '该作业缺少原页入口，将打开所属课程页；请在课程内定位作业',
      disabled: false,
      target
    }
  }
  if (isTaskActionable(task)) {
    return {
      kind: 'answer',
      label: '去作答',
      title: '在应用内打开学习通作业页并作答',
      disabled: false,
      target
    }
  }
  return {
    kind: 'view',
    label: '查看作业',
    title: '在应用内查看学习通作业原页与提交记录',
    disabled: false,
    target
  }
}

export interface TaskPortalOpenFeedback {
  status: 'opened' | 'login_required' | 'error'
  message: string
}

/**
 * Classifies the actual Portal state after `portal.openUrl()` finishes.
 * A login redirect lands with `state: 'ready'` and `loginState: 'logged_out'`
 * (or on a passport/SSO URL) and must never be reported as ready to answer.
 */
export function resolveTaskPortalOpenFeedback(
  actionKind: Exclude<TaskPortalActionKind, 'unavailable'>,
  portalState: Pick<
    PortalState,
    'state' | 'loginState' | 'loggedIn' | 'url' | 'displayUrl' | 'error'
  >
): TaskPortalOpenFeedback {
  if (
    portalState.state === 'error' ||
    portalState.state === 'blocked' ||
    portalState.state === 'idle'
  ) {
    return {
      status: 'error',
      message: portalState.error ?? '学习通页面打开失败'
    }
  }
  const landedUrl = (portalState.url || portalState.displayUrl || '').trim()
  const redirectedOffPortal = landedUrl.length > 0 && !isAllowedPortalUrl(landedUrl)
  const needsLogin =
    portalState.loginState === 'logged_out' ||
    portalState.loggedIn === false ||
    isPortalLoginUrl(landedUrl) ||
    redirectedOffPortal
  if (needsLogin) {
    return {
      status: 'login_required',
      message:
        actionKind === 'answer'
          ? '学习通登录状态已失效，已跳转至登录页；请先完成登录后再进入作业作答'
          : actionKind === 'view'
            ? '学习通登录状态已失效，已跳转至登录页；请先完成登录后再查看作业'
            : '学习通登录状态已失效，已跳转至登录页；请先完成登录后再进入课程页'
    }
  }
  return {
    status: 'opened',
    message:
      actionKind === 'answer'
        ? '已在官方页面打开作业，可直接编辑、上传附件并提交'
        : actionKind === 'view'
          ? '已打开作业原页；该任务当前不可再次作答，仅可查看提交记录'
          : '该作业缺少原页，已打开所属课程页，请从课程进入作业'
  }
}

export interface TaskStatusView {
  bucket: ReturnType<typeof dueBucket>
  overdue: boolean
  platformLabel: string | null
  platformClass: PlatformStatusKind | null
  localLabel: string | null
  showLocalPill: boolean
  canToggleLocal: boolean
}

/**
 * Single source of truth for task status presentation. Platform status, local
 * completion and due state are separate dimensions and never overwrite one another.
 */
export function getTaskStatusView(task: Task, now = new Date()): TaskStatusView {
  const bucket = dueBucket(task, now)
  const overdue = task.status !== 'done' && bucket === 'overdue'
  const platform = isPlatformTask(task)
  const platformDone = task.platformStatusKind === 'done' || task.platformStatusKind === 'reviewed'
  const mismatch = platform && platformDone !== (task.status === 'done')
  return {
    bucket,
    overdue,
    platformLabel: platform ? platformStatusLabel(task.platformStatusKind) : null,
    platformClass: platform ? task.platformStatusKind : null,
    localLabel: task.status === 'done' ? '已完成' : '未完成',
    showLocalPill: platform ? mismatch : task.status === 'done',
    canToggleLocal: !platform
  }
}

export function formatTaskScore(
  score: string | null | undefined,
  fullScore: string | null | undefined,
  platformStatusKind?: PlatformStatusKind
): string {
  const normalizedScore = score?.trim() ?? ''
  const normalizedFull = fullScore?.trim() ?? ''
  if (normalizedScore !== '') {
    return normalizedFull ? `${normalizedScore} / ${normalizedFull}` : normalizedScore
  }
  if (normalizedFull !== '') {
    return `未出分 / ${normalizedFull}`
  }
  if (platformStatusKind === 'reviewed' || platformStatusKind === 'done') {
    return '成绩未读取'
  }
  return '未评分'
}

export interface TaskScoreView {
  text: string
  hasScore: boolean
  state: 'graded' | 'ungraded' | 'unread'
}

export function getTaskScoreView(
  task: Pick<Task, 'score' | 'fullScore' | 'platformStatusKind'>
): TaskScoreView {
  const hasScore = (task.score?.trim() ?? '') !== ''
  const hasFullScore = (task.fullScore?.trim() ?? '') !== ''
  const text = formatTaskScore(task.score, task.fullScore, task.platformStatusKind)
  return {
    text,
    hasScore: hasScore || hasFullScore,
    state: hasScore ? 'graded' : text === '成绩未读取' ? 'unread' : 'ungraded'
  }
}
