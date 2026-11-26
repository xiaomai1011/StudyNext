import type {
  BootstrapData,
  ChaoxingSessionStatus,
  Course,
  PortalSubmitEvent,
  SyncProgressEvent,
  SyncStatus
} from './types'
import {
  classifyCourseRetryResult,
  classifyManualSyncResult,
  describePostSubmitVerification,
  resolveSubmitVerificationPlan,
  type RecentOpenedTaskContext
} from './sync-feedback'

export type SyncOperationKind = 'manual_sync' | 'auto_sync' | 'retry_course' | 'submit_verify'

export type ManualSyncOutcomeKind =
  | 'success'
  | 'partial'
  | 'busy'
  | 'cancelled'
  | 'failure'
  | 'cached'

export interface ManualSyncResult {
  outcome: ManualSyncOutcomeKind
  executed: boolean
  status: ChaoxingSessionStatus | null
  toastKind: 'success' | 'info' | 'error'
  message: string
}

export interface SyncRunResult {
  outcome: 'success' | 'partial' | 'cached' | 'not_configured' | 'busy' | 'cancelled' | 'failure'
  executed: boolean
  status: SyncStatus | null
  toastKind: 'success' | 'info' | 'error'
  message: string
}

export interface SyncCoordinatorSnapshot {
  isSyncing: boolean
  activeKind: SyncOperationKind | null
  progress: SyncProgressEvent | null
  cancelling: boolean
}

export interface SyncControllerApi {
  check: (operationId?: string) => Promise<ChaoxingSessionStatus>
  autoLogin: (
    accountId?: string,
    operationId?: string,
    automatic?: boolean
  ) => Promise<{ ok: boolean; message: string }>
  sync: (force?: boolean, operationId?: string) => Promise<ChaoxingSessionStatus>
  retryCourse: (courseId: string, operationId?: string) => Promise<ChaoxingSessionStatus>
  cancel: (operationId?: string) => Promise<ChaoxingSessionStatus>
}

export interface SyncControllerDeps {
  api: SyncControllerApi
  getData: () => BootstrapData | null
  setChaoxingStatus: (status: ChaoxingSessionStatus) => void
  refreshBootstrap: () => Promise<BootstrapData>
  setAutoSyncError: (error: string | null) => void
  notify: (kind: 'info' | 'success' | 'error', message: string) => void
  errorMessage: (error: unknown) => string
  canRunAutoSync: () => boolean
  getRecentOpenedTask: () => RecentOpenedTaskContext | null
  delay?: (ms: number) => Promise<void>
  now?: () => number
  onStateChange?: (snapshot: SyncCoordinatorSnapshot) => void
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isBusyError(message: string): boolean {
  return (
    message.includes('同步正在进行') ||
    message.includes('CHAOXING_SYNC_BUSY') ||
    message.includes('CHAOXING_RETRY_BUSY')
  )
}

function isCancelledError(message: string): boolean {
  return message.includes('同步已取消') || message.includes('CHAOXING_RETRY_CANCELLED')
}

/**
 * Single owner-scoped coordinator for all renderer-side sync operations
 * (manual full sync, automatic sync, single-course retry, post-submit verification,
 * and cancellation). Guarantees:
 * - Strict mutual exclusion across all four operation types.
 * - Progress/syncing state is ONLY cleared by the current operation owner (`opId`).
 * - Busy requests never report success or disrupt the active operation's state.
 * - Cancellation binds strictly to the active operation token and never leaks into
 *   subsequent syncs or falsely reports cancelling already-committed persistence.
 */
export class SyncController {
  private activeOp: { id: string; kind: SyncOperationKind; cancelled: boolean } | null = null
  private nextOpId = 0
  private progress: SyncProgressEvent | null = null
  private cancelling = false
  private readonly pendingVerifyCourses = new Set<string>()

  constructor(private readonly deps: SyncControllerDeps) {}

  getSnapshot(): SyncCoordinatorSnapshot {
    return {
      isSyncing: this.activeOp !== null,
      activeKind: this.activeOp?.kind ?? null,
      progress: this.progress,
      cancelling: this.cancelling
    }
  }

  isBusy(): boolean {
    return this.activeOp !== null
  }

  private emit(): void {
    this.deps.onStateChange?.(this.getSnapshot())
  }

  private tryBegin(kind: SyncOperationKind): string | null {
    if (this.activeOp !== null) return null
    const id = `${kind}-${Date.now()}-${++this.nextOpId}`
    this.activeOp = { id, kind, cancelled: false }
    this.progress = null
    this.cancelling = false
    this.emit()
    return id
  }

  private isCancelled(opId: string): boolean {
    return this.activeOp?.id === opId && this.activeOp.cancelled
  }

  private finish(opId: string): void {
    if (this.activeOp?.id !== opId) return
    this.activeOp = null
    this.progress = null
    this.cancelling = false
    this.emit()
  }

  handleProgressEvent(event: SyncProgressEvent): void {
    if (!this.activeOp) return
    if (event.opId && event.opId !== this.activeOp.id) return
    if (event.phase === 'done' || event.phase === 'failed') {
      this.progress = null
    } else {
      this.progress = event
    }
    this.emit()
  }

  async requestCancel(options?: { silent?: boolean }): Promise<boolean> {
    if (!this.activeOp) return false
    const targetOpId = this.activeOp.id
    const alreadyCancelling = this.cancelling
    this.activeOp.cancelled = true
    this.cancelling = true
    this.emit()
    if (!options?.silent && !alreadyCancelling) {
      this.deps.notify('info', '正在请求取消当前同步…')
    }
    try {
      await this.deps.api.cancel(targetOpId)
      return true
    } catch (error) {
      if (this.activeOp?.id === targetOpId && !alreadyCancelling) {
        this.cancelling = false
        this.emit()
      }
      if (!options?.silent) {
        this.deps.notify('error', this.deps.errorMessage(error))
      }
      return false
    }
  }

  /**
   * Unified hook for all Portal-opening entry points (homework, course, chapter,
   * material preview, Chaoxing home). Suspends/cancels any in-flight sync
   * (including auth checks before pull starts) via this coordinator so a
   * pending auth step can never proceed into a full pull behind the user's back.
   */
  async cancelForPortalOpen(): Promise<boolean> {
    return this.requestCancel({ silent: true })
  }

  async runManualSync(force = true, options?: { silent?: boolean }): Promise<ManualSyncResult> {
    const busyMessage = '同步正在进行中，请稍候或先取消当前同步'
    const opId = this.tryBegin('manual_sync')
    if (opId === null) {
      if (!options?.silent) {
        this.deps.notify('info', busyMessage)
      }
      return {
        outcome: 'busy',
        executed: false,
        status: null,
        toastKind: 'info',
        message: busyMessage
      }
    }
    try {
      const next = await this.deps.api.sync(force, opId)
      await this.deps.refreshBootstrap()
      const toast = classifyManualSyncResult(next)
      if (toast.isFailure) {
        this.deps.setAutoSyncError(toast.message)
      } else if (!toast.isCancelled) {
        this.deps.setAutoSyncError(null)
      }
      const message =
        this.isCancelled(opId) && !toast.isCancelled && !toast.isFailure
          ? `${toast.message}（数据已写入本地，取消请求无法撤销已完成持久化）`
          : toast.message
      const outcome: ManualSyncOutcomeKind = toast.isCancelled
        ? 'cancelled'
        : toast.isFailure
          ? 'failure'
          : message.includes('使用短期缓存')
            ? 'cached'
            : toast.kind === 'info'
              ? 'partial'
              : 'success'
      if (!options?.silent) {
        this.deps.notify(toast.kind, message)
      }
      return {
        outcome,
        executed: true,
        status: next,
        toastKind: toast.kind,
        message
      }
    } catch (error) {
      const message = this.deps.errorMessage(error)
      if (isBusyError(message)) {
        if (!options?.silent) {
          this.deps.notify('info', busyMessage)
        }
        return {
          outcome: 'busy',
          executed: false,
          status: null,
          toastKind: 'info',
          message: busyMessage
        }
      }
      if (isCancelledError(message)) {
        const cancelledMsg = '同步已取消，本地数据未受影响'
        if (!options?.silent) {
          this.deps.notify('info', cancelledMsg)
        }
        return {
          outcome: 'cancelled',
          executed: true,
          status: null,
          toastKind: 'info',
          message: cancelledMsg
        }
      }
      this.deps.setAutoSyncError(message)
      if (!options?.silent) this.deps.notify('error', message)
      return {
        outcome: 'failure',
        executed: true,
        status: null,
        toastKind: 'error',
        message
      }
    } finally {
      this.finish(opId)
    }
  }

  async runSyncRun(
    execute: (operationId: string) => Promise<SyncStatus>,
    options?: { silent?: boolean }
  ): Promise<SyncRunResult> {
    const busyMessage = '同步正在进行中，请稍候或先取消当前同步'
    const opId = this.tryBegin('manual_sync')
    if (opId === null) {
      if (!options?.silent) this.deps.notify('info', busyMessage)
      return {
        outcome: 'busy',
        executed: false,
        status: null,
        toastKind: 'info',
        message: busyMessage
      }
    }
    try {
      const next = await execute(opId)
      await this.deps.refreshBootstrap()
      const outcome: SyncRunResult['outcome'] =
        next.cached === true
          ? 'cached'
          : next.operationState === 'cancelled'
            ? next.committed === true
              ? 'success'
              : 'cancelled'
            : next.operationState === 'too_late'
              ? next.committed === true
                ? 'success'
                : 'cancelled'
              : next.operationState === 'partial'
                ? 'partial'
                : next.operationState === 'failure'
                  ? 'failure'
                  : next.operationState === 'not_configured'
                    ? 'not_configured'
                    : next.operationState === 'busy'
                      ? 'busy'
                      : next.state === 'not_configured'
                        ? 'not_configured'
                        : next.state === 'failure'
                          ? 'failure'
                          : next.state === 'partial'
                            ? 'partial'
                            : 'success'
      const toastKind: 'success' | 'info' | 'error' =
        outcome === 'failure' ? 'error' : outcome === 'success' ? 'success' : 'info'
      const baseMessage =
        outcome === 'not_configured' ? '学习通授权数据源尚未配置，未执行同步。' : next.message
      const message =
        this.isCancelled(opId) &&
        (outcome === 'success' || outcome === 'partial') &&
        next.committed === true
          ? `${baseMessage}（数据已写入本地，取消请求无法撤销已完成持久化）`
          : baseMessage
      if (!options?.silent) this.deps.notify(toastKind, message)
      return { outcome, executed: true, status: next, toastKind, message }
    } catch (error) {
      const message = this.deps.errorMessage(error)
      if (isBusyError(message)) {
        if (!options?.silent) this.deps.notify('info', busyMessage)
        return {
          outcome: 'busy',
          executed: false,
          status: null,
          toastKind: 'info',
          message: busyMessage
        }
      }
      if (isCancelledError(message)) {
        const cancelledMsg = '同步已取消，本地数据未受影响'
        if (!options?.silent) this.deps.notify('info', cancelledMsg)
        return {
          outcome: 'cancelled',
          executed: true,
          status: null,
          toastKind: 'info',
          message: cancelledMsg
        }
      }
      if (!options?.silent) this.deps.notify('error', message)
      return { outcome: 'failure', executed: true, status: null, toastKind: 'error', message }
    } finally {
      this.finish(opId)
    }
  }

  async runAutoSync(reason: 'startup' | 'interval' | 'resume'): Promise<boolean> {
    if (!this.deps.canRunAutoSync()) return false
    const opId = this.tryBegin('auto_sync')
    if (opId === null) return false
    try {
      const live = await this.deps.api.check(opId)
      if (this.isCancelled(opId) || !this.deps.canRunAutoSync()) {
        return false
      }
      if (live.authState !== 'authenticated') {
        const login = await this.deps.api.autoLogin(undefined, opId, true)
        if (this.isCancelled(opId) || !this.deps.canRunAutoSync()) {
          return false
        }
        if (!login.ok) throw new Error(login.message)
        const afterLogin = await this.deps.api.check(opId)
        if (this.isCancelled(opId) || !this.deps.canRunAutoSync()) {
          return false
        }
        if (afterLogin.authState !== 'authenticated') {
          throw new Error('保存的账号未能恢复学习通登录，请手动登录')
        }
        this.deps.setChaoxingStatus(afterLogin)
      }
      if (this.isCancelled(opId) || !this.deps.canRunAutoSync()) {
        return false
      }
      const result = await this.deps.api.sync(false, opId)
      await this.deps.refreshBootstrap()
      const outcome = classifyManualSyncResult(result)
      if (outcome.isCancelled) {
        this.deps.notify('info', outcome.message)
        return false
      }
      if (outcome.isFailure) {
        throw new Error(outcome.message)
      }
      this.deps.setAutoSyncError(null)
      return true
    } catch (error: unknown) {
      const message = this.deps.errorMessage(error)
      if (isBusyError(message)) return false
      if (isCancelledError(message)) {
        this.deps.notify('info', '同步已取消，本地数据未受影响')
        return false
      }
      this.deps.setAutoSyncError(message)
      this.deps.notify('error', `自动刷新失败（${reason}）：${message}`)
      return false
    } finally {
      this.finish(opId)
    }
  }

  async runCourseRetry(course: Pick<Course, 'id' | 'name'>): Promise<{ executed: boolean }> {
    const opId = this.tryBegin('retry_course')
    if (opId === null) {
      this.deps.notify('info', '已有同步任务正在进行，请稍候再刷新本课')
      return { executed: false }
    }
    try {
      const next = await this.deps.api.retryCourse(course.id, opId)
      await this.deps.refreshBootstrap()
      const toast = classifyCourseRetryResult(next)
      const message =
        this.isCancelled(opId) && !toast.isCancelled && !toast.isFailure
          ? `${toast.message}（本课数据已写入本地，取消请求无法撤销已完成持久化）`
          : toast.message
      this.deps.notify(toast.kind, message)
      return { executed: true }
    } catch (error) {
      const message = this.deps.errorMessage(error)
      if (isBusyError(message)) {
        this.deps.notify('info', '已有同步任务正在进行，请稍候再刷新本课')
        return { executed: false }
      }
      if (isCancelledError(message)) {
        this.deps.notify('info', '同步已取消，本地数据未受影响')
        return { executed: true }
      }
      // 单课重试失败只提示本次单课失败，不覆盖全量同步状态与历史完整同步时间。
      this.deps.notify('error', message)
      return { executed: true }
    } finally {
      this.finish(opId)
    }
  }

  async handleSubmitDetected(
    event: PortalSubmitEvent,
    timings: { initialDelayMs?: number; busyRetryDelayMs?: number; lagRetryDelayMs?: number } = {}
  ): Promise<void> {
    const delay = this.deps.delay ?? defaultDelay
    const now = this.deps.now ?? Date.now
    const initialDelayMs = timings.initialDelayMs ?? 3000
    const busyRetryDelayMs = timings.busyRetryDelayMs ?? 6000
    const lagRetryDelayMs = timings.lagRetryDelayMs ?? 5000

    this.deps.notify('info', '已检测到作业提交结果，正在等待平台写入后重新核验…')

    const snapshot = this.deps.getData()
    const plan = resolveSubmitVerificationPlan(
      snapshot?.courses ?? [],
      snapshot?.tasks ?? [],
      event,
      this.deps.getRecentOpenedTask(),
      now()
    )

    if (plan.targets.length === 0) {
      const message =
        plan.reason === 'unmatched_explicit'
          ? '提交页面中的课程/教学班或作业 ID 未匹配到本地记录，请先完整同步课程列表后再核对'
          : '无法从提交页面确定课程，请回到任务中心手动刷新状态'
      this.deps.notify('error', `提交后核验失败：${message}`)
      return
    }

    if (initialDelayMs > 0) await delay(initialDelayMs)

    for (const target of plan.targets) {
      if (this.pendingVerifyCourses.has(target.course.id)) continue
      this.pendingVerifyCourses.add(target.course.id)
      try {
        await this.verifySingleTarget(
          target.course.id,
          target.trackedTaskId,
          0,
          false,
          busyRetryDelayMs,
          lagRetryDelayMs
        )
      } finally {
        this.pendingVerifyCourses.delete(target.course.id)
      }
    }
  }

  private async verifySingleTarget(
    courseId: string,
    trackedTaskId: string | null,
    busyAttempt: number,
    lagRetryUsed: boolean,
    busyRetryDelayMs: number,
    lagRetryDelayMs: number
  ): Promise<void> {
    const delay = this.deps.delay ?? defaultDelay
    const opId = this.tryBegin('submit_verify')
    if (opId === null) {
      if (busyAttempt < 2) {
        await delay(busyRetryDelayMs)
        await this.verifySingleTarget(
          courseId,
          trackedTaskId,
          busyAttempt + 1,
          lagRetryUsed,
          busyRetryDelayMs,
          lagRetryDelayMs
        )
        return
      }
      this.deps.notify('error', '提交后核验失败：同步正在进行，请稍后手动刷新状态')
      return
    }

    let shouldScheduleLagRetry = false
    let retryDueToBusy = false
    try {
      const beforeTask = trackedTaskId
        ? (this.deps.getData()?.tasks.find((item) => item.id === trackedTaskId) ?? null)
        : null
      const status = await this.deps.api.retryCourse(courseId, opId)
      const refreshed = await this.deps.refreshBootstrap()
      const afterTask = trackedTaskId
        ? (refreshed.tasks.find((item) => item.id === trackedTaskId) ?? null)
        : null
      const outcome = describePostSubmitVerification(beforeTask, afterTask, status, !lagRetryUsed)
      const cancelledLate =
        this.isCancelled(opId) && outcome.kind !== 'error' && !status.message.includes('同步已取消')
      const message = cancelledLate
        ? `${outcome.message}（本课状态已写入本地，取消请求无法撤销已完成持久化）`
        : outcome.message
      this.deps.notify(outcome.kind, message)
      shouldScheduleLagRetry = outcome.shouldRetryOnce && !this.isCancelled(opId)
    } catch (error) {
      const message = this.deps.errorMessage(error)
      if (isBusyError(message) && busyAttempt < 2) {
        retryDueToBusy = true
      } else if (isCancelledError(message)) {
        this.deps.notify('info', '提交后核验已取消，可稍后手动刷新课程状态')
      } else {
        this.deps.notify('error', `提交后核验失败：${message}`)
      }
    } finally {
      this.finish(opId)
    }

    if (retryDueToBusy) {
      await delay(busyRetryDelayMs)
      await this.verifySingleTarget(
        courseId,
        trackedTaskId,
        busyAttempt + 1,
        lagRetryUsed,
        busyRetryDelayMs,
        lagRetryDelayMs
      )
      return
    }

    if (shouldScheduleLagRetry) {
      await delay(lagRetryDelayMs)
      await this.verifySingleTarget(
        courseId,
        trackedTaskId,
        busyAttempt,
        true,
        busyRetryDelayMs,
        lagRetryDelayMs
      )
    }
  }
}
