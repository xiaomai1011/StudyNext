import type {
  ChaoxingAvatarUpdatedEvent,
  ChaoxingSessionStatus,
  SyncOperationKind,
  SyncOperationState,
  SyncProgressEvent,
  SyncState
} from '@shared/types'
import { isDueAtUnknown, isPlatformTaskDone } from '@shared/domain'
import { resolveNoticeCourseName } from '@shared/notice-course'
import { UserFacingError } from '../../lib/errors'
import type { StudyNextStore } from '../../storage/store'
import type { SyncNavigationGuard, SyncNavigationResult } from '../../portal/service'
import { ChaoxingAccessError, ChaoxingSessionAdapter } from './adapter'
import type { ChaoxingAdapterLike, ChaoxingPullResult } from './adapter'
import { resolveTaskIdentityConflicts } from './identity'
import { resolveObservedAttachments, resolveObservedField } from './field-semantics'

const STATUS_META_KEY = 'chaoxing_session_status'
const STATUS_MAX_AGE_MS = 12 * 60 * 60 * 1000
const SHORT_CACHE_MS = 5 * 60 * 1000
const AVATAR_LOAD_TIMEOUT_MS = 3_000

export interface SessionSyncOutcome {
  state: Extract<SyncState, 'not_configured' | 'success' | 'partial' | 'failure'>
  message: string
  detail: string | null
  lastSuccessAt: string | null
  operationId?: string
}

/** 主进程操作所有权句柄：首次 await 前建立，取消/代次在异步边界统一校验。 */
export interface ChaoxingOwnedOperation {
  id: string
  kind: SyncOperationKind
  signal: AbortSignal
  generation: number
  assertActive: () => void
  commit: () => void
}

/**
 * 管理“用户本人 Web Session”的连接状态与手动同步。
 *
 * - 状态只保存非敏感摘要（昵称、学校、时间、计数），不保存 Cookie/Token。
 * - authenticated 的唯一依据是受保护资源请求成功，而不是 URL 路径。
 * - 401/403/登录页/安全验证页都会终止同步，不重试、不绕过。
 */
export class ChaoxingSessionService {
  private status: ChaoxingSessionStatus
  private activeOp: {
    id: string
    kind: SyncOperationKind
    controller: AbortController
    committed: boolean
  } | null = null
  private sessionResetting = false
  private preflightOp: {
    id: string
    kind: SyncOperationKind
    controller: AbortController
    generation: number
  } | null = null
  private nextOpId = 0
  private lastPullAt = 0
  private avatarRequestId = 0
  private workspaceGeneration = 0

  constructor(
    private readonly store: StudyNextStore,
    private readonly adapter: ChaoxingAdapterLike = new ChaoxingSessionAdapter(),
    private readonly onSyncOutcome: (outcome: SessionSyncOutcome) => void = () => undefined,
    private readonly onProgress: (event: SyncProgressEvent) => void = () => undefined,
    private readonly navigationGuard?: SyncNavigationGuard,
    private readonly avatarProvider?: (uid: string) => Promise<string | null>,
    private readonly onAvatarUpdated?: (event: ChaoxingAvatarUpdatedEvent) => void
  ) {
    this.status = this.readStatus()
    this.adapter.onProgress = (event): void => {
      this.onProgress({ ...event, ...(this.activeOp?.id ? { opId: this.activeOp.id } : {}) })
    }
  }

  private nextOperationId(kind: SyncOperationKind, explicit?: string): string {
    const normalized = explicit?.trim()
    if (normalized && normalized.length <= 200) return normalized
    return `${kind}-${Date.now()}-${++this.nextOpId}`
  }

  private setOperationStatus(
    id: string,
    kind: SyncOperationKind,
    stage: 'auth' | 'pull' | 'persist' | 'done',
    committed: boolean,
    state: SyncOperationState | null = null
  ): void {
    this.status = {
      ...this.status,
      lastOperationId: id,
      lastOperationKind: kind,
      lastRunStage: stage,
      lastRunCommitted: committed,
      lastOperationState: state
    }
  }

  cancel(operationId?: string): ChaoxingSessionStatus {
    // 取消只作用于本次调用指定的 opId。没有 opId 时才取消当前所有未提交操作。
    // 已提交事务的取消请求只返回 too_late，不篡改已持久化的成功结果。
    const requested = operationId?.trim()
    const matchesPreflight = Boolean(requested && this.preflightOp?.id === requested)
    const matchesActive = Boolean(requested && this.activeOp?.id === requested)
    if (requested && !matchesPreflight && !matchesActive) return this.getStatus()
    if (this.activeOp?.committed && (!requested || matchesActive)) {
      return {
        ...this.getStatus(),
        lastOutcome: 'too_late',
        lastOutcomeMessage: '同步已提交，本次取消请求未生效'
      }
    }
    const abortPreflight = !requested || matchesPreflight
    const abortActive = !requested || matchesActive
    if (abortPreflight && this.preflightOp) {
      const preflight = this.preflightOp
      preflight.controller.abort()
      this.setOperationStatus(preflight.id, preflight.kind, 'auth', false, 'cancelled')
      this.persist()
    }
    if (abortActive && this.activeOp && !this.activeOp.committed) {
      const active = this.activeOp
      active.controller.abort()
      this.setOperationStatus(active.id, active.kind, 'pull', false, 'cancelled')
      this.persist()
      this.adapter.cancel?.()
    }
    return this.getStatus()
  }

  /**
   * 统一操作所有权入口。自动登录等非同步流程也必须在首次 await 前占用
   * 当前操作槽，并使用同一 opId 与代次校验；不得另建无主的取消标记。
   */
  beginOwnedOperation(kind: SyncOperationKind, operationId?: string): ChaoxingOwnedOperation {
    if (this.sessionResetting) {
      throw new UserFacingError('CHAOXING_SESSION_CLEARING', '正在清除学习通会话，请稍候')
    }
    if (this.activeOp || this.preflightOp) {
      throw new UserFacingError('CHAOXING_SYNC_BUSY', '同步正在进行，请稍候或先取消当前同步')
    }
    const op = {
      id: this.nextOperationId(kind, operationId),
      kind,
      controller: new AbortController(),
      committed: false
    }
    this.activeOp = op
    const generation = this.workspaceGeneration
    this.setOperationStatus(op.id, kind, 'auth', false, 'busy')
    this.status = { ...this.status, lastOperationState: 'busy' }
    this.persist()
    return {
      id: op.id,
      kind,
      signal: op.controller.signal,
      generation,
      assertActive: (): void => this.assertOwnedOperation(op.id, generation),
      commit: (): void => {
        if (this.activeOp?.id === op.id) {
          this.activeOp.committed = true
          this.setOperationStatus(op.id, op.kind, 'done', true, 'success')
          this.persist()
        }
      }
    }
  }

  finishOwnedOperation(operationId: string): void {
    if (this.activeOp?.id === operationId) {
      this.activeOp = null
    }
  }

  private throwIfSessionResetting(): void {
    if (this.sessionResetting) {
      throw new UserFacingError('CHAOXING_SESSION_CLEARING', '正在清除学习通会话，请稍候')
    }
  }

  /**
   * 同步槽必须由同一 owner 从鉴权阶段一路持有到 pull 结束。
   * syncWithAuthCheck 会在 preflight 仍存在时以同一 opId 调用 sync；
   * 其他任何 preflight/active 组合都必须拒绝，避免不同操作共享同一会话。
   */
  private assertSyncSlotAvailable(kind: SyncOperationKind, operationId?: string): void {
    if (this.activeOp) {
      throw new UserFacingError('CHAOXING_SYNC_BUSY', '同步正在进行，请稍候或先取消当前同步')
    }
    const preflight = this.preflightOp
    if (!preflight) return
    const requested = operationId?.trim()
    if (requested && preflight.id === requested && preflight.kind === kind) return
    throw new UserFacingError('CHAOXING_SYNC_BUSY', '同步正在进行，请稍候或先取消当前同步')
  }

  private staleOperationStatus(
    operationId: string,
    kind: SyncOperationKind,
    stage: 'auth' | 'pull' | 'persist' | 'done' = 'pull'
  ): ChaoxingSessionStatus {
    // 账号切换已有更准确的用户提示；会话清理则必须明确返回取消，
    // 不能把“已清除登录态”当成旧操作自身的失败或完成。
    return this.cancelledOperationStatus(
      operationId,
      kind,
      stage,
      this.sessionResetting ? undefined : this.status.message
    )
  }

  private cancelledOperationStatus(
    operationId: string,
    kind: SyncOperationKind,
    stage: 'auth' | 'pull' | 'persist' | 'done' = 'pull',
    message = '同步已取消，本地数据未受影响'
  ): ChaoxingSessionStatus {
    return {
      ...this.getStatus(),
      message,
      checkedAt: new Date().toISOString(),
      lastRunCached: false,
      lastRunStage: stage,
      lastRunCommitted: false,
      lastOperationId: operationId,
      lastOperationKind: kind,
      lastOperationState: 'cancelled',
      detail: null
    }
  }

  private assertOwnedOperation(operationId: string, generation: number): void {
    if (
      this.sessionResetting ||
      generation !== this.workspaceGeneration ||
      this.activeOp?.id !== operationId ||
      this.activeOp.controller.signal.aborted
    ) {
      throw new ChaoxingAccessError('CANCELLED', '同步已取消')
    }
  }

  /**
   * 清除 Portal 会话前调用：先让旧代次失效、取消未提交操作并阻断新操作，
   * 再执行真正耗时的 session.clearStorageData()/clearCache()。
   */
  beginSessionReset(): ChaoxingSessionStatus {
    this.sessionResetting = true
    this.workspaceGeneration += 1
    this.avatarRequestId += 1
    this.preflightOp?.controller.abort()
    this.activeOp?.controller.abort()
    this.preflightOp = null
    this.activeOp = null
    this.adapter.cancel?.()
    // 立即发布“未登录”状态，而不是等 Portal 清理完成后才让界面知道。
    // 同步历史（lastSyncAt/lastCompleteSyncAt/lastOutcome）保留，供用户查看真实记录。
    this.status = {
      ...this.status,
      authState: 'logged_out',
      message: '已清除学习通会话，请重新登录',
      displayName: null,
      school: null,
      studentId: null,
      avatarUrl: null,
      checkedAt: new Date().toISOString(),
      lastRunCached: false,
      lastRunStage: null,
      lastRunCommitted: false,
      lastOperationId: null,
      lastOperationKind: null,
      lastOperationState: null,
      userDisconnected: true,
      transport: 'none',
      httpStatus: null,
      cookieDomainCount: 0,
      detail: null
    }
    this.persist()
    return this.getStatus()
  }

  endSessionReset(): ChaoxingSessionStatus {
    this.sessionResetting = false
    return this.getStatus()
  }

  /**
   * 统一账号切换失效入口。
   * 在任何异步等待开始前同步递增代次并取消适配器，确保旧任务后续的
   * 持久化、状态更新和事件都不会再落到新账号状态上。
   */
  beginAccountSwitch(): ChaoxingSessionStatus {
    this.workspaceGeneration += 1
    if (this.preflightOp) {
      this.preflightOp.controller.abort()
    }
    if (this.activeOp && !this.activeOp.committed) {
      this.activeOp.controller.abort()
    }
    this.adapter.cancel?.()
    return this.getStatus()
  }

  resetForAccountSwitch(): ChaoxingSessionStatus {
    this.beginAccountSwitch()
    this.lastPullAt = 0
    this.status = {
      ...this.status,
      authState: 'logged_out',
      message: '已切换学习通账号，请在新打开的登录页完成登录',
      displayName: null,
      school: null,
      studentId: null,
      avatarUrl: null,
      checkedAt: null,
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
      lastRunStage: null,
      lastRunCommitted: null,
      lastOperationId: null,
      lastOperationKind: null,
      lastOperationState: null,
      userDisconnected: false,
      syncedCourses: 0,
      syncedTasks: 0,
      syncedChapters: 0,
      syncedExams: 0,
      syncedNotices: 0,
      syncedMaterials: 0,
      transport: 'none',
      httpStatus: null,
      cookieDomainCount: 0,
      detail: null
    }
    this.persist()
    return this.getStatus()
  }

  getStatus(): ChaoxingSessionStatus {
    return { ...this.status }
  }

  /**
   * 设置页“检查同步”的入口：鉴权检查本身也必须是一个可取消操作。
   * 旧实现先单独 await check()，取消信号在鉴权阶段没有活动操作可绑定，
   * 鉴权完成后仍会继续 pull；这里用 preflight op 覆盖整个鉴权窗口。
   */
  async syncWithAuthCheck(
    force = false,
    options: {
      beforePull?: (signal: AbortSignal) => Promise<void>
      operationId?: string
      operationKind?: SyncOperationKind
    } = {}
  ): Promise<ChaoxingSessionStatus> {
    this.throwIfSessionResetting()
    if (this.activeOp || this.preflightOp) {
      throw new UserFacingError('CHAOXING_SYNC_BUSY', '同步正在进行，请稍候或先取消当前同步')
    }
    const kind = options.operationKind ?? 'manual_sync'
    const op = {
      id: this.nextOperationId(kind, options.operationId),
      kind,
      controller: new AbortController(),
      generation: this.workspaceGeneration
    }
    this.preflightOp = op
    this.setOperationStatus(op.id, kind, 'auth', false)
    try {
      const checked = await this.check(op.controller.signal)
      if (op.generation !== this.workspaceGeneration) {
        return this.staleOperationStatus(op.id, kind, 'auth')
      }
      if (op.controller.signal.aborted) {
        return this.cancelledOperationStatus(op.id, kind, 'auth')
      }
      if (checked.authState !== 'authenticated') {
        this.setOperationStatus(op.id, kind, 'auth', false)
        this.persist()
        return {
          ...checked,
          lastRunStage: 'auth',
          lastRunCached: false,
          lastOperationId: op.id,
          lastOperationKind: kind,
          lastOperationState: 'not_configured'
        }
      }
      this.setOperationStatus(op.id, kind, 'pull', false)
      const result = await this.sync(force, {
        ...options,
        operationId: op.id,
        operationKind: kind
      })
      if (result.lastOperationState === 'cancelled') return result
      return result
    } catch (error) {
      if (op.controller.signal.aborted) {
        return this.cancelledOperationStatus(op.id, kind, 'pull')
      }
      throw error
    } finally {
      if (this.preflightOp?.id === op.id) this.preflightOp = null
    }
  }

  async checkWithOperation(operationId?: string): Promise<ChaoxingSessionStatus> {
    this.throwIfSessionResetting()
    if (this.preflightOp || this.activeOp) {
      throw new UserFacingError('CHAOXING_SYNC_BUSY', '同步正在进行，请稍候或先取消当前同步')
    }
    const op = {
      id: this.nextOperationId('auth_check', operationId),
      kind: 'auth_check' as const,
      controller: new AbortController(),
      generation: this.workspaceGeneration
    }
    this.preflightOp = op
    this.setOperationStatus(op.id, 'auth_check', 'auth', false)
    try {
      const result = await this.check(op.controller.signal)
      return {
        ...result,
        lastOperationId: op.id,
        lastOperationKind: 'auth_check',
        lastOperationState: result.authState === 'authenticated' ? 'success' : 'not_configured',
        lastRunStage: 'auth',
        lastRunCommitted: false
      }
    } finally {
      if (this.preflightOp?.id === op.id) this.preflightOp = null
    }
  }

  async check(signal?: AbortSignal): Promise<ChaoxingSessionStatus> {
    this.throwIfSessionResetting()
    const generation = this.workspaceGeneration
    const previous = this.status
    try {
      const result = await this.adapter.checkSession(signal)
      if (signal?.aborted) {
        throw new ChaoxingAccessError('CANCELLED', '同步已取消')
      }
      if (generation !== this.workspaceGeneration) return this.getStatus()
      const authState =
        result.authState === 'authenticated'
          ? 'authenticated'
          : result.authState === 'logged_out'
            ? previous.authState === 'authenticated'
              ? 'expired'
              : 'logged_out'
            : 'unknown'
      const loggedOut = authState === 'logged_out'
      const avatarUid = result.profile.uid ?? previous.studentId ?? null
      const shouldLoadAvatar = Boolean(!loggedOut && avatarUid && this.avatarProvider)
      if (generation !== this.workspaceGeneration) return this.getStatus()
      const sameAvatarIdentity = !!avatarUid && previous.studentId === avatarUid
      const cachedAvatar =
        sameAvatarIdentity && previous.avatarUrl?.startsWith('data:image/')
          ? previous.avatarUrl
          : null
      // 只覆盖本次鉴权负责的字段；保留并发 retry/sync 已写入的课程回读证据。
      this.status = {
        ...this.status,
        authState,
        message:
          authState === 'expired'
            ? '学习通登录态已失效，请重新登录'
            : authState === 'logged_out'
              ? '尚未登录学习通，请点击登录'
              : result.message,
        displayName: loggedOut ? null : (result.profile.name ?? this.status.displayName),
        school: loggedOut ? null : (result.profile.school ?? this.status.school),
        studentId: loggedOut ? null : (result.profile.uid ?? this.status.studentId ?? null),
        avatarUrl: loggedOut
          ? null
          : (cachedAvatar ??
            (result.profile.uid
              ? `https://photo.chaoxing.com/p/${result.profile.uid}_80`
              : (this.status.avatarUrl ?? null))),
        checkedAt: new Date().toISOString(),
        transport: result.transport,
        httpStatus: result.httpStatus,
        cookieDomainCount: result.cookieDomainCount,
        userDisconnected:
          authState === 'authenticated' ? false : (this.status.userDisconnected ?? false),
        detail:
          authState === 'authenticated'
            ? null
            : '仅当受保护页面请求成功时才会显示已登录；不会依据 URL 猜测。'
      }
      if (shouldLoadAvatar && avatarUid) {
        // 头像不是身份核验的前置条件：后台独立加载并限时，绝不阻塞 check()/取消。
        this.loadAvatarInBackground(avatarUid, generation)
      }
    } catch (error) {
      if (generation !== this.workspaceGeneration) return this.getStatus()
      if (signal?.aborted) {
        throw new ChaoxingAccessError('CANCELLED', '同步已取消')
      }
      this.status = {
        ...this.status,
        authState: 'unknown',
        message: '无法确认学习通登录状态',
        checkedAt: new Date().toISOString(),
        transport: 'none',
        httpStatus: null,
        detail: error instanceof Error ? error.message : '未知错误'
      }
    }
    if (generation !== this.workspaceGeneration) return this.getStatus()
    this.persist()
    return this.getStatus()
  }

  private loadAvatarInBackground(uid: string, generation: number): void {
    const provider = this.avatarProvider
    if (!provider) return
    const requestId = ++this.avatarRequestId
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), AVATAR_LOAD_TIMEOUT_MS)
    })
    void Promise.race([provider(uid).catch(() => null), timeout])
      .then((avatarUrl) => {
        if (timer) clearTimeout(timer)
        if (!avatarUrl || generation !== this.workspaceGeneration) return
        if (requestId !== this.avatarRequestId || this.status.authState !== 'authenticated') return
        // 头像缓存只能跨同一 UID 复用；账号切换后迟到的旧 UID 结果不得发布。
        if (this.status.studentId !== uid) return
        this.status = { ...this.status, avatarUrl }
        this.persist()
        this.onAvatarUpdated?.({
          uid,
          generation,
          requestId,
          avatarUrl
        })
      })
      .catch(() => undefined)
  }

  async sync(
    force = false,
    options: {
      beforePull?: (signal: AbortSignal) => Promise<void>
      operationId?: string
      operationKind?: SyncOperationKind
    } = {}
  ): Promise<ChaoxingSessionStatus> {
    this.throwIfSessionResetting()
    const kind = options.operationKind ?? 'manual_sync'
    this.assertSyncSlotAvailable(kind, options.operationId)
    if (
      !force &&
      this.lastPullAt > 0 &&
      Date.now() - this.lastPullAt < SHORT_CACHE_MS &&
      this.status.authState === 'authenticated' &&
      this.status.lastSyncAt
    ) {
      const opId = this.nextOperationId(kind, options.operationId)
      const cachedStatus: ChaoxingSessionStatus = {
        ...this.status,
        lastRunCached: true,
        lastRunStage: 'done',
        lastRunCommitted: false,
        lastOperationId: opId,
        lastOperationKind: kind,
        lastOperationState: 'cached',
        message: '最近 5 分钟内已同步，本次使用短期缓存；如需强制刷新请在设置页点击“仅同步学习通”。'
      }
      this.onProgress({ phase: 'done', message: cachedStatus.message, current: 0, total: 0, opId })
      return cachedStatus
    }
    const op = {
      id: this.nextOperationId(kind, options.operationId),
      kind,
      controller: new AbortController(),
      committed: false
    }
    this.activeOp = op
    const generation = this.workspaceGeneration
    const startedAt = new Date().toISOString()
    this.status = {
      ...this.status,
      lastAttemptAt: startedAt,
      lastRunCached: false,
      lastRunStage: 'pull',
      lastRunCommitted: false,
      lastOperationId: op.id,
      lastOperationKind: kind,
      lastOperationState: 'busy',
      message: '正在通过 Web Session 读取学习通数据…'
    }
    this.persist()
    this.onProgress({
      phase: 'start',
      message: '正在通过 Web Session 读取学习通数据…',
      current: 0,
      total: 0,
      opId: op.id
    })
    let navigationResult: SyncNavigationResult | null = null
    let failed = false
    let committedResult: ChaoxingSessionStatus | null = null
    let terminalResult: ChaoxingSessionStatus | null = null
    try {
      if (options.beforePull) {
        try {
          await options.beforePull(op.controller.signal)
        } catch (error) {
          if (op.controller.signal.aborted) {
            throw new ChaoxingAccessError('CANCELLED', '同步已取消')
          }
          throw error
        }
      }
      if (generation !== this.workspaceGeneration) {
        return this.staleOperationStatus(op.id, kind)
      }
      if (op.controller.signal.aborted) {
        throw new ChaoxingAccessError('CANCELLED', '同步已取消')
      }
      await this.navigationGuard?.begin(op.id)
      if (generation !== this.workspaceGeneration) {
        return this.staleOperationStatus(op.id, kind)
      }
      if (op.controller.signal.aborted) {
        throw new ChaoxingAccessError('CANCELLED', '同步已取消')
      }
      const result = await this.adapter.pull(op.controller.signal)
      if (generation !== this.workspaceGeneration) {
        return this.staleOperationStatus(op.id, kind)
      }
      if (op.controller.signal.aborted) {
        throw new ChaoxingAccessError('CANCELLED', '同步已取消')
      }
      this.setOperationStatus(op.id, kind, 'persist', false)
      const committed = this.store.runInTransaction(() => {
        const counts = this.persistResult(result)
        const now = new Date().toISOString()
        const partial = result.errors.length > 0 || result.warnings.length > 0
        const message = partial
          ? `同步完成，${counts.courses} 门课程、${counts.tasks} 项作业、${counts.chapters} 个章节、${counts.exams} 场考试、${counts.notices} 条通知、${counts.materials} 个资料；部分数据读取失败`
          : `同步完成，${counts.courses} 门课程、${counts.tasks} 项作业、${counts.chapters} 个章节、${counts.exams} 场考试、${counts.notices} 条通知、${counts.materials} 个资料`
        const detail = buildDetail(result)
        const nextStatus: ChaoxingSessionStatus = {
          ...this.status,
          authState: 'authenticated',
          message,
          checkedAt: now,
          lastRunCached: false,
          lastRunStage: 'done',
          lastRunCommitted: true,
          lastOperationId: op.id,
          lastOperationKind: kind,
          lastOperationState: partial ? 'partial' : 'success',
          lastSyncAt: now,
          lastCompleteSyncAt: partial ? (this.status.lastCompleteSyncAt ?? null) : now,
          lastOutcome: partial ? 'partial' : 'success',
          lastOutcomeMessage: message,
          lastOutcomeDetail: detail,
          lastOutcomeAt: now,
          lastCourseRetryOutcome: null,
          lastCourseRetryObservedTaskExternalIds: null,
          syncedCourses: counts.courses,
          syncedTasks: counts.tasks,
          syncedChapters: counts.chapters,
          syncedExams: counts.exams,
          syncedNotices: counts.notices,
          syncedMaterials: counts.materials,
          detail
        }
        this.persistStatus(nextStatus)
        return { counts, message, detail, status: nextStatus }
      })
      this.status = committed.status
      // 本次 COMMIT 的回执必须与后续 Portal 恢复、会话清理和活动槽释放隔离。
      committedResult = { ...committed.status }
      op.committed = true
      this.lastPullAt = Date.now()
      this.onSyncOutcome({
        state: this.status.lastOutcome === 'partial' ? 'partial' : 'success',
        message: committed.message,
        detail: committed.detail,
        lastSuccessAt:
          this.status.lastOutcome === 'partial'
            ? (this.status.lastCompleteSyncAt ?? null)
            : this.status.lastSyncAt,
        operationId: op.id
      })
    } catch (error) {
      if (error instanceof UserFacingError) throw error
      if (generation !== this.workspaceGeneration) {
        return this.staleOperationStatus(op.id, kind)
      }
      const access = error instanceof ChaoxingAccessError ? error : null
      const cancelled =
        access?.code === 'CANCELLED' ||
        op.controller.signal.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      failed = !cancelled
      const authState =
        access?.code === 'NOT_LOGGED_IN' || access?.code === 'EXPIRED'
          ? this.status.authState === 'authenticated'
            ? 'expired'
            : 'logged_out'
          : this.status.authState
      const failedAt = new Date().toISOString()
      const failureMessage =
        access?.code === 'BLOCKED'
          ? '学习通要求安全验证，自动同步已停止，请本人在 Portal 处理'
          : access?.code === 'NOT_LOGGED_IN'
            ? '尚未在 Portal 登录学习通'
            : cancelled
              ? '同步已取消，本地数据未受影响'
              : '同步失败，本地数据未受影响'
      const failureDetail = error instanceof Error ? error.message : '未知错误'
      this.status = {
        ...this.status,
        authState,
        message: failureMessage,
        checkedAt: failedAt,
        lastRunCached: false,
        lastRunStage: 'pull',
        lastRunCommitted: false,
        lastOperationId: op.id,
        lastOperationKind: kind,
        lastOperationState: cancelled
          ? 'cancelled'
          : access?.code === 'NOT_LOGGED_IN'
            ? 'not_configured'
            : 'failure',
        ...(cancelled
          ? {}
          : {
              lastOutcome:
                access?.code === 'NOT_LOGGED_IN'
                  ? ('not_configured' as const)
                  : ('failure' as const),
              lastOutcomeMessage: failureMessage,
              lastOutcomeDetail: failureDetail,
              lastOutcomeAt: failedAt
            }),
        lastCourseRetryOutcome: null,
        lastCourseRetryObservedTaskExternalIds: null,
        detail: failureDetail
      }
      // 本次操作的终态必须在进入 Portal 恢复前冻结；恢复期间会话被清理、
      // 账号切换或新的同步操作都不得改写原调用方看到的回执。
      terminalResult = { ...this.status }
      if (!cancelled) {
        this.onSyncOutcome({
          state: access?.code === 'NOT_LOGGED_IN' ? 'not_configured' : 'failure',
          message: this.status.message,
          detail: this.status.detail,
          lastSuccessAt: this.status.lastCompleteSyncAt ?? null,
          operationId: op.id
        })
      }
    } finally {
      if (generation === this.workspaceGeneration) {
        try {
          navigationResult = (await this.navigationGuard?.end(op.id)) ?? null
        } catch {
          navigationResult = { restored: false, message: '同步完成，但原页面恢复失败' }
        }
        if (generation === this.workspaceGeneration && !committedResult) {
          if (navigationResult?.message) {
            this.status = {
              ...this.status,
              detail: appendDetail(this.status.detail, navigationResult.message)
            }
          }
          this.persist()
        }
      }
      if (this.activeOp?.id === op.id) {
        this.activeOp = null
        this.onProgress({
          phase: failed ? 'failed' : 'done',
          message: committedResult?.message ?? this.status.message,
          current: 0,
          total: 0,
          opId: op.id
        })
      }
    }
    // 已提交或已到达终态的结果是本次调用的不可变回执；即使 Portal 恢复期间
    // 会话被清理，也不能把新会话的 logged_out 状态返回给原调用方。
    return committedResult ?? terminalResult ?? this.getStatus()
  }

  async retryCourse(
    courseId: string,
    options: {
      beforePull?: (signal: AbortSignal) => Promise<void>
      operationId?: string
    } = {}
  ): Promise<ChaoxingSessionStatus> {
    this.throwIfSessionResetting()
    if (this.activeOp || this.preflightOp) {
      throw new UserFacingError('CHAOXING_RETRY_BUSY', '同步正在进行，请稍后自动重试')
    }
    const course = this.store.getCourse(courseId)
    if (!course || course.source !== 'chaoxing' || !course.externalId) {
      throw new UserFacingError('CHAOXING_RETRY_FAILED', '该课程不是学习通同步课程，无法重试')
    }
    if (!this.adapter.pullCourse) {
      throw new UserFacingError('CHAOXING_RETRY_FAILED', '当前适配器不支持单课程重试')
    }
    const op = {
      id: this.nextOperationId('retry_course', options.operationId),
      kind: 'retry_course' as const,
      controller: new AbortController(),
      committed: false
    }
    this.activeOp = op
    const generation = this.workspaceGeneration
    const startedAt = new Date().toISOString()
    this.status = {
      ...this.status,
      lastAttemptAt: startedAt,
      lastRunCached: false,
      lastRunStage: 'pull',
      lastRunCommitted: false,
      lastOperationId: op.id,
      lastOperationKind: 'retry_course',
      lastOperationState: 'busy',
      message: `正在重试课程：${course.name}…`
    }
    this.persist()
    this.onProgress({
      phase: 'start',
      message: this.status.message,
      current: 0,
      total: 0,
      opId: op.id
    })
    let navigationResult: SyncNavigationResult | null = null
    let failed = false
    let committedResult: ChaoxingSessionStatus | null = null
    let terminalResult: ChaoxingSessionStatus | null = null
    let retryEvidence: {
      outcome: 'success' | 'partial'
      observedTaskExternalIds: string[]
    } | null = null
    try {
      if (options.beforePull) {
        try {
          await options.beforePull(op.controller.signal)
        } catch (error) {
          if (op.controller.signal.aborted) {
            throw new ChaoxingAccessError('CANCELLED', '同步已取消')
          }
          throw error
        }
      }
      if (generation !== this.workspaceGeneration) {
        return this.staleOperationStatus(op.id, 'retry_course')
      }
      if (op.controller.signal.aborted) {
        throw new ChaoxingAccessError('CANCELLED', '同步已取消')
      }
      await this.navigationGuard?.begin(op.id)
      if (generation !== this.workspaceGeneration) {
        return this.staleOperationStatus(op.id, 'retry_course')
      }
      if (op.controller.signal.aborted) {
        throw new ChaoxingAccessError('CANCELLED', '同步已取消')
      }
      const result = await this.adapter.pullCourse(course.externalId, op.controller.signal)
      if (generation !== this.workspaceGeneration) {
        return this.staleOperationStatus(op.id, 'retry_course')
      }
      if (op.controller.signal.aborted) {
        throw new ChaoxingAccessError('CANCELLED', '同步已取消')
      }
      this.setOperationStatus(op.id, 'retry_course', 'persist', false)
      const committed = this.store.runInTransaction(() => {
        const counts = this.persistResult(result)
        const materialCount = (result.materials ?? []).reduce(
          (sum, group) => sum + group.items.length,
          0
        )
        const now = new Date().toISOString()
        const partial = result.errors.length > 0 || result.warnings.length > 0
        const detail = buildDetail(result)
        const nextStatus: ChaoxingSessionStatus = {
          ...this.status,
          authState: 'authenticated',
          message: partial
            ? `课程重试完成：${course.name}，${counts.tasks} 项作业、${counts.chapters} 个章节、${materialCount} 个资料；部分数据读取失败`
            : `课程重试完成：${course.name}，${counts.tasks} 项作业、${counts.chapters} 个章节、${materialCount} 个资料`,
          checkedAt: now,
          lastRunCached: false,
          lastRunStage: 'done',
          lastRunCommitted: true,
          lastOperationId: op.id,
          lastOperationKind: 'retry_course',
          lastOperationState: partial ? 'partial' : 'success',
          // 单课程重试只记录本次单课结果与本次回读到的作业标识，不覆盖全量同步状态。
          lastCourseRetryOutcome: partial ? 'partial' : 'success',
          lastCourseRetryObservedTaskExternalIds: counts.observedTaskExternalIds,
          detail
        }
        this.persistStatus(nextStatus)
        return { counts, partial, status: nextStatus }
      })
      this.status = committed.status
      committedResult = { ...committed.status }
      op.committed = true
      const { counts, partial } = committed
      retryEvidence = {
        outcome: partial ? 'partial' : 'success',
        observedTaskExternalIds: counts.observedTaskExternalIds
      }
      // 单课程重试是局部操作，不更新全局 SyncStatus，避免覆盖上一次全量同步结果。
    } catch (error) {
      failed = true
      if (error instanceof UserFacingError) throw error
      if (generation !== this.workspaceGeneration) {
        return this.staleOperationStatus(op.id, 'retry_course')
      }
      const access = error instanceof ChaoxingAccessError ? error : null
      const cancelled =
        access?.code === 'CANCELLED' ||
        op.controller.signal.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      this.status = {
        ...this.status,
        message:
          access?.code === 'BLOCKED'
            ? '学习通要求安全验证，自动同步已停止，请本人在 Portal 处理'
            : cancelled
              ? '同步已取消，本地数据未受影响'
              : '课程重试失败，本地数据未受影响',
        checkedAt: new Date().toISOString(),
        lastRunCached: false,
        lastRunStage: 'done',
        lastRunCommitted: false,
        lastOperationId: op.id,
        lastOperationKind: 'retry_course',
        lastOperationState: cancelled ? 'cancelled' : 'failure',
        lastCourseRetryOutcome: cancelled ? 'cancelled' : 'failure',
        lastCourseRetryObservedTaskExternalIds: null,
        detail: error instanceof Error ? error.message : '未知错误'
      }
      terminalResult = { ...this.status }
      if (cancelled) return this.getStatus()
      throw new UserFacingError('CHAOXING_RETRY_FAILED', this.status.message)
    } finally {
      if (generation === this.workspaceGeneration) {
        try {
          navigationResult = (await this.navigationGuard?.end(op.id)) ?? null
        } catch {
          navigationResult = { restored: false, message: '同步完成，但原页面恢复失败' }
        }
        if (generation === this.workspaceGeneration && !committedResult) {
          if (navigationResult?.message) {
            this.status = {
              ...this.status,
              detail: appendDetail(this.status.detail, navigationResult.message)
            }
          }
          this.persist()
        }
      }
      if (this.activeOp?.id === op.id) {
        this.activeOp = null
        this.onProgress({
          phase: failed ? 'failed' : 'done',
          message: committedResult?.message ?? this.status.message,
          current: 0,
          total: 0,
          opId: op.id
        })
      }
    }
    const resultStatus = committedResult ?? this.getStatus()
    return retryEvidence
      ? {
          ...resultStatus,
          lastCourseRetryOutcome: retryEvidence.outcome,
          lastCourseRetryObservedTaskExternalIds: retryEvidence.observedTaskExternalIds
        }
      : resultStatus
  }

  private persistResult(result: ChaoxingPullResult): {
    courses: number
    tasks: number
    exams: number
    chapters: number
    notices: number
    materials: number
    observedTaskExternalIds: string[]
  } {
    const reminderOffsets = this.store.getSettings().defaultReminderOffsets
    if (result.courses.length > 0) {
      // 真实数据到达后移除演示种子，避免“同步成功但界面仍显示演示课程”。
      this.store.clearDemoData()
    }
    let courses = 0
    const courseIdMap = new Map<string, string>()
    for (const bundle of result.courses) {
      const { course } = this.store.upsertProviderCourse(
        {
          externalId: bundle.externalId,
          name: bundle.name,
          teacher: bundle.teacher,
          sourceUrl: bundle.sourceUrl,
          clazzId: bundle.clazzId,
          className: null,
          ...(result.schedule
            ? {
                schedule: bundle.schedule,
                semesterStart: result.schedule.semesterStart,
                maxWeek: result.schedule.maxWeek
              }
            : {})
        },
        'chaoxing'
      )
      courseIdMap.set(bundle.externalId, course.id)
      courses += 1
    }
    let tasks = 0
    // 同一作业可能在列表页出现多次（桌面/移动两套 DOM）。这里按 externalId 去重，
    // 但同一教学班内“无平台 ID 的同名作业”会得到相同 externalId：此时必须按页面
    // 稳定参数区分并显式报告冲突，不能由 Map 静默保留最后一条。
    const resolved = resolveTaskIdentityConflicts(result.tasks, (baseId) => {
      return this.store
        .listTasks()
        .filter(
          (task) =>
            task.source === 'chaoxing' &&
            typeof task.externalId === 'string' &&
            (task.externalId === baseId || task.externalId.startsWith(`${baseId}:`))
        )
        .map((task) => ({
          externalId: task.externalId as string,
          sourceUrl: task.sourceUrl,
          ...(task.platformStatus ? { platformStatus: task.platformStatus } : {})
        }))
    })
    for (const warning of resolved.warnings) {
      if (!result.warnings.includes(warning)) result.warnings.push(warning)
    }
    const uniqueTasks = resolved.records
    const observedTaskExternalIds: string[] = []
    for (const record of uniqueTasks) {
      observedTaskExternalIds.push(record.externalId)
      const existing = this.store.findTaskByExternalId('chaoxing', record.externalId)
      const detailRead = record.detailRead !== false
      const keepExistingDueAt =
        (!detailRead || isDueAtUnknown(record.dueAt)) && existing && !isDueAtUnknown(existing.dueAt)
          ? existing.dueAt
          : record.dueAt
      // DATA-012：按“未读取 / 读到有效值 / 平台明确为空”三态决定是否覆盖旧值。
      // 没有 fieldStates 的旧夹具只能按“实际有值才视为已读取”保守处理；
      // detailRead 不能单独证明所有字段都已可靠读取（CP3-04）。
      const states = record.fieldStates ?? {
        score: record.score !== null ? ('present' as const) : ('unread' as const),
        fullScore: record.fullScore !== null ? ('present' as const) : ('unread' as const),
        teacherFeedback:
          record.teacherFeedback !== null && record.teacherFeedback.trim().length > 0
            ? ('present' as const)
            : ('unread' as const),
        submittedAt: record.submittedAt !== null ? ('present' as const) : ('unread' as const),
        deadline: !isDueAtUnknown(record.dueAt) ? ('present' as const) : ('unread' as const),
        attachments: record.attachments.length > 0 ? ('present' as const) : ('unread' as const)
      }
      const score = resolveObservedField(
        { state: states.score, value: record.score },
        existing?.score
      )
      const fullScore = resolveObservedField(
        { state: states.fullScore, value: record.fullScore },
        existing?.fullScore
      )
      const teacherFeedback = resolveObservedField(
        { state: states.teacherFeedback, value: record.teacherFeedback },
        existing?.teacherFeedback
      )
      const submittedAt = resolveObservedField(
        { state: states.submittedAt, value: record.submittedAt },
        existing?.submittedAt
      )
      const attachments = resolveObservedAttachments(
        { state: states.attachments, value: record.attachments },
        existing?.attachments
      )
      this.store.upsertImportedTask(
        {
          title: record.title,
          description:
            (!detailRead || record.description.trim().length === 0) && existing?.description
              ? existing.description
              : record.description,
          courseId: courseIdMap.get(record.courseExternalId) ?? null,
          priority: 'medium',
          kind: 'homework',
          status: isPlatformTaskDone(record.platformStatusKind) ? 'done' : 'todo',
          dueAt: keepExistingDueAt,
          reminderOffsets,
          sourceUrl: record.sourceUrl ?? existing?.sourceUrl ?? null
        },
        {
          externalId: record.externalId,
          source: 'chaoxing',
          sourceUpdatedAt: result.checkedAt,
          platformStatus: record.platformStatus,
          platformStatusKind: record.platformStatusKind,
          ...(submittedAt !== undefined ? { submittedAt } : {}),
          ...(score !== undefined ? { score } : {}),
          ...(fullScore !== undefined ? { fullScore } : {}),
          ...(teacherFeedback !== undefined ? { teacherFeedback } : {}),
          ...(attachments !== undefined ? { attachments } : {})
        }
      )
      tasks += 1
    }
    return {
      courses,
      tasks,
      exams: this.persistExams(result),
      chapters: this.persistChapters(result, courseIdMap),
      notices: this.persistNotices(result),
      materials: this.persistMaterials(result, courseIdMap),
      observedTaskExternalIds
    }
  }

  private persistMaterials(result: ChaoxingPullResult, courseIdMap: Map<string, string>): number {
    let count = 0
    for (const group of result.materials ?? []) {
      const courseId = courseIdMap.get(group.courseExternalId)
      if (!courseId) continue
      count += this.store.replaceProviderMaterials(courseId, group.items, 'chaoxing')
    }
    return Math.max(count, this.store.listMaterials().length)
  }

  private persistNotices(result: ChaoxingPullResult): number {
    const knownCourseNames = Array.from(
      new Set([
        ...result.courses.map((course) => course.name),
        ...this.store.listCourses().map((course) => course.name)
      ])
    )
    let count = 0
    for (const notice of result.notices ?? []) {
      const courseName = resolveNoticeCourseName({
        title: notice.title,
        body: notice.body,
        sender: notice.sender,
        currentCourseName: notice.courseName,
        knownCourseNames
      })
      this.store.upsertProviderNotice(
        {
          ...notice,
          courseName,
          category: courseName ? 'course' : notice.category === 'system' ? 'system' : 'notice'
        },
        'chaoxing'
      )
      count += 1
    }
    return Math.max(count, this.store.listNotices().length)
  }

  private persistChapters(result: ChaoxingPullResult, courseIdMap: Map<string, string>): number {
    let chapters = 0
    for (const bundle of result.chapters ?? []) {
      const courseId = courseIdMap.get(bundle.courseExternalId)
      if (!courseId) continue
      // 不在这里物理删除 study_points。total 为 0 可能是“明确无任务点”，
      // 也可能是页面未完整加载；无法可靠区分时必须保留已有学习点和本地状态。
      const existingChapters = this.store
        .listChapters()
        .filter((item) => item.courseId === courseId)

      for (const chapter of bundle.chapters) {
        const existingChapter = existingChapters.find(
          (item) => item.externalId === chapter.externalId
        )
        // 全量同步不扫描章节附件；已有附件在本次结果为空时保留，避免被覆盖丢失。
        const sections = chapter.contentSections.map((section) => {
          const existingSection = existingChapter?.sections.find(
            (item) => item.number === section.number
          )
          return {
            ...section,
            resources:
              section.resources.length > 0 ? section.resources : (existingSection?.resources ?? [])
          }
        })

        const { chapter: stored } = this.store.upsertSnapshotChapter(
          {
            courseId,
            externalId: chapter.externalId,
            title: chapter.title,
            sortOrder: chapter.sortOrder,
            progress: chapter.progress,
            sourceUrl: bundle.sourceUrl,
            sections
          },
          'chaoxing'
        )
        for (const section of chapter.sections) {
          this.store.upsertSnapshotPoint(
            {
              chapterId: stored.id,
              courseId,
              externalId: section.externalId,
              title: section.title,
              kind: section.kind,
              completed: section.completed,
              durationMinutes: null,
              sortOrder: section.sortOrder
            },
            'chaoxing'
          )
        }
        chapters += 1
      }
    }
    return chapters
  }

  private persistExams(result: ChaoxingPullResult): number {
    let exams = 0
    for (const record of result.exams ?? []) {
      this.store.upsertProviderExam(
        {
          externalId: record.externalId,
          title: record.title,
          courseName: record.courseName,
          startAt: record.startAt,
          endAt: record.endAt,
          durationMinutes: record.durationMinutes,
          examStatus: record.examStatus,
          answerStatus: record.answerStatus,
          score: record.score,
          mode: record.mode,
          sourceUrl: record.sourceUrl
        },
        'chaoxing'
      )
      exams += 1
    }
    return exams
  }

  private readStatus(): ChaoxingSessionStatus {
    const raw = this.store.getMeta(STATUS_META_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<ChaoxingSessionStatus>
        if (
          parsed.authState === 'unknown' ||
          parsed.authState === 'logged_out' ||
          parsed.authState === 'authenticated' ||
          parsed.authState === 'expired'
        ) {
          const checkedAt = typeof parsed.checkedAt === 'string' ? parsed.checkedAt : null
          const stale = checkedAt !== null && Date.now() - Date.parse(checkedAt) > STATUS_MAX_AGE_MS
          const authState =
            stale && parsed.authState === 'authenticated' ? 'expired' : parsed.authState
          const loggedOut = authState === 'logged_out'
          const lastOutcome =
            parsed.lastOutcome === 'success' ||
            parsed.lastOutcome === 'partial' ||
            parsed.lastOutcome === 'failure' ||
            parsed.lastOutcome === 'not_configured' ||
            parsed.lastOutcome === 'cancelled' ||
            parsed.lastOutcome === 'too_late'
              ? parsed.lastOutcome
              : null
          return {
            authState,
            connection: 'web_session',
            message: stale
              ? '上次登录检查已超过 12 小时，请重新检查'
              : (parsed.message ?? '尚未检查学习通连接'),
            displayName: loggedOut ? null : (parsed.displayName ?? null),
            school: loggedOut ? null : (parsed.school ?? null),
            studentId: loggedOut ? null : (parsed.studentId ?? null),
            avatarUrl: loggedOut ? null : (parsed.avatarUrl ?? null),
            checkedAt,
            lastSyncAt: parsed.lastSyncAt ?? null,
            lastCompleteSyncAt: parsed.lastCompleteSyncAt ?? null,
            lastAttemptAt: parsed.lastAttemptAt ?? null,
            lastOutcome,
            lastOutcomeMessage: parsed.lastOutcomeMessage ?? null,
            lastOutcomeDetail: parsed.lastOutcomeDetail ?? null,
            lastOutcomeAt: parsed.lastOutcomeAt ?? null,
            lastCourseRetryOutcome: parsed.lastCourseRetryOutcome ?? null,
            lastCourseRetryObservedTaskExternalIds:
              parsed.lastCourseRetryObservedTaskExternalIds ?? null,
            lastRunCached: parsed.lastRunCached ?? null,
            lastRunStage: parsed.lastRunStage ?? null,
            lastRunCommitted: parsed.lastRunCommitted ?? null,
            lastOperationId: parsed.lastOperationId ?? null,
            lastOperationKind: parsed.lastOperationKind ?? null,
            lastOperationState: parsed.lastOperationState ?? null,
            userDisconnected: parsed.userDisconnected === true,
            syncedCourses: parsed.syncedCourses ?? 0,
            syncedTasks: parsed.syncedTasks ?? 0,
            syncedChapters: parsed.syncedChapters ?? 0,
            syncedExams: parsed.syncedExams ?? 0,
            syncedNotices: parsed.syncedNotices ?? 0,
            syncedMaterials: parsed.syncedMaterials ?? 0,
            transport: parsed.transport ?? 'none',
            httpStatus: parsed.httpStatus ?? null,
            cookieDomainCount: parsed.cookieDomainCount ?? 0,
            detail: parsed.detail ?? null
          }
        }
      } catch {
        // 损坏的状态按未知处理，不影响本地数据。
      }
    }
    return {
      authState: 'unknown',
      connection: 'web_session',
      message: '尚未检查学习通连接',
      displayName: null,
      school: null,
      studentId: null,
      avatarUrl: null,
      checkedAt: null,
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
      lastRunStage: null,
      lastRunCommitted: null,
      lastOperationId: null,
      lastOperationKind: null,
      lastOperationState: null,
      userDisconnected: false,
      syncedCourses: 0,
      syncedTasks: 0,
      syncedChapters: 0,
      syncedExams: 0,
      syncedNotices: 0,
      syncedMaterials: 0,
      transport: 'none',
      httpStatus: null,
      cookieDomainCount: 0,
      detail: null
    }
  }

  private persistStatus(status: ChaoxingSessionStatus): void {
    this.store.setMeta(STATUS_META_KEY, JSON.stringify(status))
  }

  private persist(): void {
    this.persistStatus(this.status)
  }
}

function isIdentityWarning(warning: string): boolean {
  return /identity_(?:unknown|conflict)|标识冲突|无法确认|身份不一致|缺少可靠平台 ID/.test(warning)
}

export function buildDetail(result: ChaoxingPullResult): string | null {
  const parts: string[] = []
  if (result.errors.length > 0) {
    const shown = result.errors.slice(0, 5).join('；')
    const omitted =
      result.errors.length > 5 ? `；另有 ${result.errors.length - 5} 条失败未显示` : ''
    parts.push(`失败：${shown}${omitted}`)
  }
  if (result.warnings.length > 0) {
    // 身份类警告优先展示，不能因为普通读取警告过多而被截掉。
    const identityWarnings = result.warnings.filter(isIdentityWarning)
    const otherWarnings = result.warnings.filter((warning) => !isIdentityWarning(warning))
    if (identityWarnings.length > 0) {
      parts.push(`身份提示：${identityWarnings.join('；')}`)
    }
    if (otherWarnings.length > 0) {
      parts.push(`提示：${otherWarnings.join('；')}`)
    }
  }
  return parts.length > 0 ? parts.join('。') : null
}

function appendDetail(detail: string | null, message: string): string {
  return detail ? `${detail}；${message}` : message
}
