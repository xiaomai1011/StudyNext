import { app, ipcMain, Notification, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { IPC } from '@shared/ipc'
import type {
  AppNotice,
  AppSettings,
  BootstrapData,
  ChaoxingSessionStatus,
  OfficialEntryInput,
  SyncStatus,
  Task,
  TaskUpsertInput
} from '@shared/types'
import {
  entryInputSchema,
  importPayloadSchema,
  settingsPatchSchema,
  studyPointStatusSchema,
  taskUpsertSchema,
  type ParsedTaskUpsert
} from '@shared/validation'
import type { StudyNextStore } from './storage/store'
import type { NotificationScheduler } from './notifications/scheduler'
import type { SystemReminderService } from './notifications/system-reminder'
import { findNextReminderAt } from './notifications/scheduler'
import { earliestIso } from './notifications/retry-policy'
import type { SyncService } from './integrations/sync'
import type { PortalService } from './portal/service'
import type { ChaoxingSessionService } from './integrations/chaoxing/service'
import type { ChaoxingCredentialStore } from './integrations/chaoxing/credentials'
import { importTasksFromFile } from './integrations/import'
import { importStudySnapshot } from './integrations/snapshot'
import { isAllowedPortalUrl } from './portal/security'
import { resolveMaterialDownloadSource } from './materials/download-source'
import { resolveEffectiveSyncStatus } from './integrations/sync-status'
import { errorMessage, UserFacingError } from './lib/errors'
import type { WorkspaceManager } from './storage/workspaces'

/**
 * Mutating IPC channels are blocked when the application is opened against a
 * read-only historical workspace. Reads and navigation remain available.
 */
const READ_ONLY_BLOCKED_CHANNELS = new Set<string>([
  IPC.tasksCreate,
  IPC.tasksUpdate,
  IPC.tasksRemove,
  IPC.tasksSetCompleted,
  IPC.coursesSetFavorite,
  IPC.studySetPointCompleted,
  IPC.settingsUpdate,
  IPC.demoReset,
  IPC.importsCsvIcs,
  IPC.importsSnapshot,
  IPC.syncRun,
  IPC.chaoxingSync,
  IPC.chaoxingRetryCourse,
  IPC.portalClearNavigationLog,
  IPC.portalDownload,
  IPC.portalCancelDownload,
  IPC.portalRetryDownload,
  IPC.portalRetryFailedDownloads,
  IPC.portalDeleteDownload,
  IPC.portalClearDownloads,
  IPC.portalChooseDownloadDirectory,
  IPC.materialsDownload,
  IPC.notificationsRepairSystemTask,
  IPC.entriesCreate,
  IPC.entriesUpdateEnabled,
  IPC.entriesRemove
])

interface RegisterIpcOptions {
  store: StudyNextStore
  scheduler: NotificationScheduler
  systemReminder: SystemReminderService | null
  sync: SyncService
  chaoxing: ChaoxingSessionService
  credentials: ChaoxingCredentialStore
  workspaces: WorkspaceManager
  portal: PortalService
  getWindow: () => BrowserWindow | null
  appInfo: BootstrapData['appInfo']
  notices: AppNotice[]
  isSwitchingAccount: () => boolean
  requestAccountSwitch: (
    accountId: string
  ) => Promise<import('@shared/types').ChaoxingCredentialStatus>
  requestRestartToSafeWorkspace: () => Promise<import('@shared/types').ChaoxingCredentialStatus>
  requestRestartForAccount: (
    accountId: string
  ) => Promise<import('@shared/types').ChaoxingCredentialStatus>
  onSettingsChanged: (settings: AppSettings) => void
  onTestNotification: () => void
  onDemoReset: () => void
  onRendererReady: () => void
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new UserFacingError('VALIDATION', first?.message ?? '输入无效')
  }
  return result.data
}

function parseOperationId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined
}

function toTaskUpsertInput(parsed: ParsedTaskUpsert): TaskUpsertInput {
  return {
    title: parsed.title,
    description: parsed.description,
    courseId: parsed.courseId,
    priority: parsed.priority,
    kind: parsed.kind,
    dueAt: parsed.dueAt,
    reminderOffsets: parsed.reminderOffsets,
    ...(parsed.status !== undefined ? { status: parsed.status } : {})
  }
}

function requireTask(store: StudyNextStore, id: string): Task {
  const task = store.getTask(id)
  if (!task) throw new UserFacingError('TASK_NOT_FOUND', '任务不存在')
  return task
}

function rejectPlatformTaskMutation(task: Task, action: string): void {
  if (task.source !== 'chaoxing') return
  throw new UserFacingError(
    'TASK_PLATFORM_READ_ONLY',
    `学习通任务的${action}由平台同步，不能在本地修改。`
  )
}

function toSettingsPatch(parsed: z.infer<typeof settingsPatchSchema>): Partial<AppSettings> {
  const patch: Partial<AppSettings> = {}
  if (parsed.theme !== undefined) patch.theme = parsed.theme
  if (parsed.closeToTray !== undefined) patch.closeToTray = parsed.closeToTray
  if (parsed.launchAtLogin !== undefined) patch.launchAtLogin = parsed.launchAtLogin
  if (parsed.notificationsEnabled !== undefined)
    patch.notificationsEnabled = parsed.notificationsEnabled
  if (parsed.defaultReminderOffsets !== undefined)
    patch.defaultReminderOffsets = parsed.defaultReminderOffsets
  if (parsed.calendarWeekStartsOn !== undefined)
    patch.calendarWeekStartsOn = parsed.calendarWeekStartsOn
  if (parsed.catchUpMissedReminders !== undefined)
    patch.catchUpMissedReminders = parsed.catchUpMissedReminders
  if (parsed.trustedSsoDomains !== undefined) patch.trustedSsoDomains = parsed.trustedSsoDomains
  if (parsed.downloadDirectory !== undefined) patch.downloadDirectory = parsed.downloadDirectory
  if (parsed.autoRefreshMinutes !== undefined) patch.autoRefreshMinutes = parsed.autoRefreshMinutes
  if (parsed.uiZoom !== undefined) patch.uiZoom = Math.round(parsed.uiZoom * 100) / 100
  return patch
}

export function registerIpc(options: RegisterIpcOptions): void {
  const {
    store,
    scheduler,
    systemReminder,
    sync,
    chaoxing,
    credentials,
    workspaces,
    portal,
    getWindow,
    appInfo,
    notices,
    isSwitchingAccount,
    requestAccountSwitch,
    requestRestartToSafeWorkspace,
    requestRestartForAccount,
    onSettingsChanged,
    onTestNotification,
    onDemoReset
  } = options

  const handle = (
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  ): void => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const window = getWindow()
      if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id) {
        throw new Error('请求来源无效')
      }
      if (isSwitchingAccount() && channel !== IPC.chaoxingCredentialsStatus) {
        throw new UserFacingError('ACCOUNT_SWITCHING', '正在切换学习通账号，应用即将重启，请稍候')
      }
      if (store.readOnly && READ_ONLY_BLOCKED_CHANNELS.has(channel)) {
        throw new UserFacingError(
          'WORKSPACE_READ_ONLY',
          '当前打开的是只读历史工作区，不能修改任务、设置、下载或提醒；请登录账号进入独立工作区。'
        )
      }
      try {
        return await handler(event, ...args)
      } catch (error) {
        if (!(error instanceof UserFacingError)) {
          console.error(`[ipc:${channel}] ${errorMessage(error)}`)
        }
        throw new Error(errorMessage(error))
      }
    })
  }

  /**
   * 进程重启后 SyncService 的内存状态会回到 not_configured，
   * 但学习通会话和上次同步结果已经持久化；bootstrap 时用会话状态补齐，
   * 避免“明明同步成功、界面却显示未连接”。
   */
  const requireVerifiedActiveAccount = async (signal?: AbortSignal): Promise<void> => {
    const credentialStatus = await credentials.status()
    if (!credentialStatus.activeAccountId) {
      throw new UserFacingError(
        'CHAOXING_IDENTITY_UNVERIFIED',
        '当前没有已验证的学习通账号，已停止写库。请先保存并登录账号。'
      )
    }
    const account = credentialStatus.accounts.find(
      (item) => item.id === credentialStatus.activeAccountId
    )
    if (!account) {
      throw new UserFacingError(
        'CHAOXING_IDENTITY_UNVERIFIED',
        '当前学习通账号身份不可用，请重新登录。'
      )
    }
    if (!account.platformUid) {
      throw new UserFacingError(
        'CHAOXING_IDENTITY_UNVERIFIED',
        '当前学习通账号尚未完成身份校验，请重新登录后再同步，避免把数据写入错误账号。'
      )
    }
    if (store.accountId !== account.id) {
      throw new UserFacingError(
        'CHAOXING_WORKSPACE_MISMATCH',
        '当前数据库不属于该学习通账号，已停止写库。请重启应用以载入账号工作区。'
      )
    }
    const current = await chaoxing.check(signal)
    if (current.authState !== 'authenticated') {
      throw new UserFacingError('CHAOXING_NOT_AUTHENTICATED', current.message)
    }
    if (!current.studentId || current.studentId !== account.platformUid) {
      throw new UserFacingError(
        'CHAOXING_IDENTITY_MISMATCH',
        '当前学习通登录身份与目标账号不一致，已停止同步写库。'
      )
    }
  }

  const effectiveSyncStatus = (currentSession?: ChaoxingSessionStatus): SyncStatus => {
    const sessionStatus = currentSession ?? chaoxing.getStatus()
    const operationState =
      sessionStatus.lastRunCached === true
        ? 'cached'
        : (sessionStatus.lastOperationState ??
          (sessionStatus.lastOutcome === 'too_late'
            ? 'too_late'
            : sessionStatus.lastOutcome === 'cancelled'
              ? 'cancelled'
              : (sessionStatus.lastOutcome ??
                (sync.getStatus().state === 'syncing' ? 'busy' : null))))

    if (currentSession) {
      // 同步操作响应必须只由本次操作的持久化回执构造。Portal 恢复期间可能
      // 发生快照导入、会话清理或新的同步；这些后续状态不得污染原调用结果。
      const state: SyncStatus['state'] =
        operationState === 'success' || operationState === 'cached' || operationState === 'too_late'
          ? 'success'
          : operationState === 'partial'
            ? 'partial'
            : operationState === 'failure'
              ? 'failure'
              : operationState === 'not_configured'
                ? 'not_configured'
                : operationState === 'busy'
                  ? 'syncing'
                  : currentSession.authState === 'authenticated'
                    ? 'failure'
                    : 'not_configured'
      return {
        state,
        message: currentSession.message,
        source: 'chaoxing',
        lastAttemptAt: currentSession.lastOutcomeAt ?? currentSession.lastAttemptAt,
        lastSuccessAt:
          currentSession.lastCompleteSyncAt ??
          (currentSession.lastOutcome === 'success' && currentSession.lastRunCommitted === true
            ? currentSession.lastSyncAt
            : null),
        detail: currentSession.detail ?? currentSession.lastOutcomeDetail ?? null,
        snapshot: null,
        cached: operationState === 'cached',
        operationId: currentSession.lastOperationId ?? null,
        operationKind: currentSession.lastOperationKind ?? null,
        operationState,
        stage: currentSession.lastRunStage ?? null,
        committed: currentSession.lastRunCommitted ?? null
      }
    }

    const status = resolveEffectiveSyncStatus(sync.getStatus(), sessionStatus)
    return {
      ...status,
      operationId: sessionStatus.lastOperationId ?? null,
      operationKind: sessionStatus.lastOperationKind ?? null,
      operationState,
      stage: sessionStatus.lastRunStage ?? null,
      committed: sessionStatus.lastRunCommitted ?? null,
      ...(sessionStatus.lastRunCached === true
        ? {
            cached: true,
            message: sessionStatus.message,
            detail: sessionStatus.detail ?? status.detail
          }
        : operationState === 'cancelled' || operationState === 'too_late'
          ? {
              message: sessionStatus.message,
              detail: sessionStatus.detail ?? status.detail
            }
          : {})
    }
  }

  handle(IPC.bootstrap, () => {
    const bootstrap: BootstrapData = {
      courses: store.listCourses(),
      chapters: store.listChapters(),
      studyPoints: store.listStudyPoints(),
      tasks: store.listTasks(),
      exams: store.listExams(),
      materials: store.listMaterials(),
      settings: store.getSettings(),
      notices: (() => {
        const providerNotices = store.listNotices()
        return providerNotices.length > 0 ? providerNotices : notices
      })(),
      syncStatus: effectiveSyncStatus(),
      chaoxing: chaoxing.getStatus(),
      officialEntries: store.listOfficialEntries(),
      appInfo,
      reminderRuntime: {
        mode: systemReminder?.getStatus().supported ? 'system_task' : 'process_running',
        note: systemReminder?.getStatus().supported
          ? '应用运行时由进程内调度器提醒；完全退出后由 Windows 任务计划程序启动无界面检查。'
          : '提醒仅在 StudyNext 运行期间调度；完全退出应用后定时器停止，不会在退出后发送通知。重新启动时会检查并补发最近 10 分钟内错过的提醒。',
        systemNotificationsSupported: Notification.isSupported(),
        startupCatchUpCount: scheduler.getStartupCatchUpCount(),
        nextReminderAt: scheduler.getNextReminderAt(),
        system: systemReminder?.getStatus() ?? {
          supported: false,
          taskName: null,
          registered: false,
          executablePath: null,
          nextRunAt: null,
          lastCheckAt: null,
          lastDeliveryAt: null,
          lastError: null,
          lastDeliveryError: null,
          lastScheduleError: null,
          needsReregister: false
        }
      }
    }
    return bootstrap
  })

  handle(IPC.notificationsSystemStatus, async () => {
    if (!systemReminder) return null
    return systemReminder.refreshStatus()
  })

  handle(IPC.notificationsRepairSystemTask, async () => {
    if (!systemReminder) {
      throw new UserFacingError('SYSTEM_REMINDER_UNSUPPORTED', '当前环境不支持 Windows 系统级提醒')
    }
    const settings = store.getSettings()
    const status = await systemReminder.repair({
      enabled: settings.notificationsEnabled,
      nextRunAt: settings.notificationsEnabled
        ? earliestIso([findNextReminderAt(store.listTasks()), store.nextDeliveryRetryAt()])
        : null
    })
    scheduler.refresh()
    return status
  })

  handle(IPC.tasksCreate, (_event, input) => {
    const parsed = parseInput(taskUpsertSchema, input)
    const task = store.createTask(toTaskUpsertInput(parsed))
    scheduler.refresh()
    return task
  })

  handle(IPC.tasksUpdate, (_event, id, input) => {
    const taskId = parseInput(z.string().uuid(), id)
    const parsed = parseInput(taskUpsertSchema, input)
    const current = requireTask(store, taskId)
    if (
      current.source === 'chaoxing' &&
      parsed.status !== undefined &&
      parsed.status !== current.status
    ) {
      throw new UserFacingError(
        'TASK_PLATFORM_STATUS_LOCKED',
        '学习通任务的完成状态由平台同步，不能通过本地编辑修改。'
      )
    }
    const task = store.updateTask(taskId, toTaskUpsertInput(parsed))
    scheduler.refresh()
    return task
  })

  handle(IPC.tasksRemove, (_event, id) => {
    const taskId = parseInput(z.string().uuid(), id)
    rejectPlatformTaskMutation(requireTask(store, taskId), '删除')
    store.deleteTask(taskId)
    scheduler.refresh()
  })

  handle(IPC.tasksSetCompleted, (_event, id, completed) => {
    const taskId = parseInput(z.string().uuid(), id)
    rejectPlatformTaskMutation(requireTask(store, taskId), '完成状态')
    const task = store.setTaskCompleted(taskId, parseInput(z.boolean(), completed))
    scheduler.refresh()
    return task
  })

  handle(IPC.tasksHistory, (_event, id) => {
    return store.listTaskHistory(parseInput(z.string().uuid(), id))
  })

  handle(IPC.tasksDownloadAttachment, async (_event, taskId, attachmentIndex) => {
    await requireVerifiedActiveAccount()
    const task = requireTask(store, parseInput(z.string().uuid(), taskId))
    if (task.source !== 'chaoxing') {
      throw new UserFacingError('TASK_ATTACHMENT_LOCAL', '本地任务没有平台附件可下载。')
    }
    const index = parseInput(z.number().int().min(0), attachmentIndex)
    const attachment = task.attachments[index]
    if (!attachment) {
      throw new UserFacingError('TASK_ATTACHMENT_NOT_FOUND', '附件不存在，可能已被平台更新。')
    }
    if (!attachment.objectId) {
      throw new UserFacingError(
        'TASK_ATTACHMENT_NO_OBJECT_ID',
        '该附件没有可用的平台标识，无法下载。'
      )
    }
    await portal.downloadAttachment(
      task.id,
      index,
      attachment.objectId,
      attachment.name,
      task.sourceUrl ?? 'https://mooc1.chaoxing.com/'
    )
  })

  handle(IPC.coursesSetFavorite, (_event, id, favorite) => {
    return store.setCourseFavorite(
      parseInput(z.string().uuid(), id),
      parseInput(z.boolean(), favorite)
    )
  })

  handle(IPC.studySetPointCompleted, (_event, input) => {
    const parsed = parseInput(studyPointStatusSchema, input)
    return store.setStudyPointCompleted(parsed.id, parsed.completed)
  })

  handle(IPC.settingsUpdate, (_event, patch) => {
    const settings = store.updateSettings(toSettingsPatch(parseInput(settingsPatchSchema, patch)))
    onSettingsChanged(settings)
    scheduler.refresh()
    return settings
  })

  handle(IPC.settingsTestNotification, () => {
    onTestNotification()
  })

  handle(IPC.demoReset, () => {
    store.resetDemoData()
    scheduler.refresh()
    onDemoReset()
  })

  handle(IPC.importsCsvIcs, (_event, payload) => {
    const parsed = parseInput(importPayloadSchema, payload)
    const result = importTasksFromFile(store, parsed)
    scheduler.refresh()
    return result
  })

  handle(IPC.importsSnapshot, (_event, payload) => {
    const parsed = parseInput(importPayloadSchema, payload)
    const result = importStudySnapshot(store, parsed)
    sync.recordSnapshotImport(result)
    scheduler.refresh()
    return result
  })

  handle(IPC.syncStatus, () => effectiveSyncStatus())
  handle(IPC.syncRun, async (_event, operationId?: unknown) => {
    const opId = parseOperationId(operationId)
    const status = await chaoxing.syncWithAuthCheck(false, {
      ...(opId ? { operationId: opId } : {}),
      beforePull: (signal) => requireVerifiedActiveAccount(signal)
    })
    if (status.lastOperationState === 'cancelled') {
      return effectiveSyncStatus(status)
    }
    if (status.lastRunStage === 'auth' && status.authState !== 'authenticated') {
      sync.recordSessionResult({
        state: 'not_configured',
        message: '请先在 Portal 登录学习通，再执行同步',
        detail: status.detail ?? status.message,
        lastSuccessAt: status.lastCompleteSyncAt ?? null
      })
    }
    if (status.authState === 'authenticated') scheduler.refresh()
    return effectiveSyncStatus(status)
  })

  handle(IPC.chaoxingStatus, () => chaoxing.getStatus())
  handle(IPC.chaoxingCheck, (_event, operationId?: unknown) =>
    chaoxing.checkWithOperation(parseOperationId(operationId))
  )
  handle(IPC.chaoxingSync, async (_event, force, operationId?: unknown) => {
    const opId = parseOperationId(operationId)
    const status = await chaoxing.sync(force === true, {
      ...(opId ? { operationId: opId } : {}),
      beforePull: (signal) => requireVerifiedActiveAccount(signal)
    })
    scheduler.refresh()
    return status
  })
  handle(IPC.chaoxingRetryCourse, async (_event, courseId, operationId?: unknown) => {
    if (typeof courseId !== 'string' || courseId.length === 0 || courseId.length > 200) {
      throw new Error('课程 ID 无效')
    }
    const opId = parseOperationId(operationId)
    const status = await chaoxing.retryCourse(courseId, {
      ...(opId ? { operationId: opId } : {}),
      beforePull: (signal) => requireVerifiedActiveAccount(signal)
    })
    scheduler.refresh()
    return status
  })
  handle(IPC.chaoxingCancel, (_event, operationId?: unknown) =>
    chaoxing.cancel(parseOperationId(operationId))
  )

  handle(IPC.chaoxingCredentialsStatus, () => credentials.status())
  handle(IPC.chaoxingCredentialsSave, (_event, input) => {
    const parsed = parseInput(
      z.object({
        username: z.string().trim().min(1, '请输入学习通账号').max(120),
        password: z.string().min(1, '请输入学习通密码').max(200)
      }),
      input
    )
    return credentials.save(parsed.username, parsed.password)
  })
  handle(IPC.chaoxingCredentialsClear, async () => {
    const before = await credentials.status()
    if (before.activeAccountId) {
      const safety = portal.canSwitchAccount()
      if (!safety.ok) {
        throw new UserFacingError(
          'CHAOXING_SWITCH_BLOCKED',
          safety.reason ?? '当前页面不适宜切换账号'
        )
      }
    }
    const status = await credentials.clear()
    if (before.activeAccountId) await requestRestartToSafeWorkspace()
    return status
  })
  handle(IPC.chaoxingCredentialsFill, () => portal.fillCredentials())
  handle(
    IPC.chaoxingAutoLogin,
    async (_event, requestedAccountId, operationId?: unknown, automatic?: unknown) => {
      if (automatic === true && chaoxing.getStatus().userDisconnected) {
        return {
          ok: false,
          message: '用户已主动断开学习通连接，后台不会自动登录；请手动重新连接。',
          needsManual: true
        }
      }
      const requested =
        typeof requestedAccountId === 'string' && requestedAccountId.length > 0
          ? parseInput(z.string().max(120), requestedAccountId)
          : null
      // 首次异步等待前占用统一操作槽；账号切换、清会话和取消都通过同一 opId 失效。
      const op = chaoxing.beginOwnedOperation('auto_login', parseOperationId(operationId))
      let identityCommitted = false
      try {
        const before = await credentials.status()
        op.assertActive()
        const previousActiveId = before.activeAccountId
        const accountId = requested ?? before.activeAccountId
        if (!accountId) {
          throw new UserFacingError('CHAOXING_CREDENTIAL_MISSING', '请先保存学习通账号和密码')
        }
        const target = await credentials.getAccount(accountId)
        op.assertActive()
        if (!target)
          throw new UserFacingError('CHAOXING_CREDENTIAL_MISSING', '找不到目标学习通账号')

        const result = await portal.autoLogin(accountId, op.signal)
        op.assertActive()
        if (!result.ok) return result

        const status = await chaoxing.check(op.signal)
        op.assertActive()
        const uid = status.studentId?.trim()
        if (!uid) {
          await portal.clearSession()
          throw new UserFacingError(
            'CHAOXING_IDENTITY_UNVERIFIED',
            '登录成功但平台未返回可靠身份标识，已停止写入，请重新登录。'
          )
        }
        if (target.platformUid && target.platformUid !== uid) {
          await portal.clearSession()
          throw new UserFacingError(
            'CHAOXING_IDENTITY_MISMATCH',
            '登录身份与目标账号不一致，已停止写入，请确认账号后重新登录。'
          )
        }
        const current = await credentials.status()
        op.assertActive()
        if (current.activeAccountId !== previousActiveId) {
          await portal.clearSession()
          throw new UserFacingError(
            'CHAOXING_ACCOUNT_CHANGED',
            '登录期间账号已切换，本次结果已丢弃。'
          )
        }
        await credentials.bindIdentityAndActivate(
          accountId,
          status.displayName,
          status.school,
          uid,
          op.signal
        )
        op.commit()
        identityCommitted = true
        // 身份已经原子提交后不再用可取消断言阻断工作区激活；否则会出现
        // “凭据已绑定、工作区未激活”的半完成状态。取消只应阻止提交前的副作用。
        const verifiedAccount = await credentials.getAccount(accountId)
        if (verifiedAccount?.platformUid) {
          const workspace = workspaces.ensureWorkspaceForAccount({
            id: verifiedAccount.id,
            platformUid: verifiedAccount.platformUid,
            displayName: verifiedAccount.displayName,
            school: verifiedAccount.school
          })
          workspaces.setActive(workspace.id)
          if (store.accountId !== verifiedAccount.id || store.workspaceId !== workspace.id) {
            await requestRestartForAccount(verifiedAccount.id)
          }
        }
        return result
      } catch (error) {
        if (op.signal.aborted && !identityCommitted) {
          throw new UserFacingError('CHAOXING_AUTO_LOGIN_CANCELLED', '同步已取消')
        }
        throw error
      } finally {
        chaoxing.finishOwnedOperation(op.id)
      }
    }
  )
  handle(IPC.chaoxingCredentialsRemove, async (_event, id) => {
    const parsedId = parseInput(z.string().min(1).max(120), id)
    const before = await credentials.status()
    const wasActive = before.activeAccountId === parsedId
    if (wasActive) {
      const safety = portal.canSwitchAccount()
      if (!safety.ok) {
        throw new UserFacingError(
          'CHAOXING_SWITCH_BLOCKED',
          safety.reason ?? '当前页面不适宜切换账号'
        )
      }
    }
    const status = await credentials.remove(parsedId)
    if (wasActive) await requestRestartToSafeWorkspace()
    return status
  })
  handle(IPC.chaoxingCredentialsActivate, async (_event, id) => {
    return requestAccountSwitch(parseInput(z.string().min(1).max(120), id))
  })
  handle(IPC.chaoxingSwitchAccount, async (_event, id) => {
    return requestAccountSwitch(parseInput(z.string().min(1).max(120), id))
  })

  handle(IPC.portalOpen, (_event, entryId) => {
    return portal.open(parseInput(z.string().min(1).max(120), entryId))
  })
  handle(IPC.portalOpenUrl, (_event, url) => {
    return portal.openUrl(parseInput(z.string().min(1).max(2048), url))
  })
  handle(IPC.portalHide, () => portal.hide())
  handle(IPC.portalClose, () => portal.close())
  handle(IPC.portalState, () => portal.getState())
  handle(IPC.portalBack, () => portal.back())
  handle(IPC.portalForward, () => portal.forward())
  handle(IPC.portalReload, () => portal.reload())
  handle(IPC.portalOpenInitialInBrowser, () => portal.openInitialInBrowser())
  handle(IPC.portalClearSession, async () => {
    // 必须先于首次 await 使旧会话代次失效并中止旧操作；清理期间新操作会被拒绝。
    chaoxing.beginSessionReset()
    try {
      await portal.clearSession()
    } finally {
      chaoxing.endSessionReset()
    }
  })
  handle(IPC.portalClearNavigationLog, () => portal.clearNavigationLog())
  handle(IPC.portalSecurityState, () => portal.getSecurityState())
  handle(IPC.portalSetBounds, (_event, bounds) => {
    const parsed = parseInput(
      z
        .object({
          x: z.number().finite(),
          y: z.number().finite(),
          width: z.number().finite(),
          height: z.number().finite()
        })
        .strict(),
      bounds
    )
    portal.setBounds(parsed)
  })

  handle(IPC.portalDownloads, () => portal.listDownloads())
  handle(IPC.portalDownload, (_event, url) => {
    return portal.download(parseInput(z.string().min(1).max(2048), url))
  })
  handle(IPC.portalOpenDownload, (_event, id) => {
    return portal.openDownload(parseInput(z.string().min(1).max(120), id))
  })
  handle(IPC.portalRevealDownload, (_event, id) => {
    return portal.revealDownload(parseInput(z.string().min(1).max(120), id))
  })
  handle(IPC.portalCancelDownload, (_event, id) => {
    portal.cancelDownload(parseInput(z.string().min(1).max(120), id))
  })
  handle(IPC.portalRetryDownload, (_event, id) => {
    return portal.retryDownload(parseInput(z.string().min(1).max(120), id))
  })
  handle(IPC.portalRetryFailedDownloads, (_event, options) => {
    const parsed = parseInput(
      z
        .object({
          courseId: z.string().min(1).max(120).nullable().optional(),
          downloadIds: z.array(z.string().min(1).max(120)).max(200).optional()
        })
        .strict()
        .optional(),
      options
    )
    return portal.retryFailedDownloads({
      ...(parsed?.courseId !== undefined ? { courseId: parsed.courseId } : {}),
      ...(parsed?.downloadIds !== undefined ? { downloadIds: parsed.downloadIds } : {})
    })
  })
  handle(IPC.portalDeleteDownload, (_event, id) => {
    portal.deleteDownload(parseInput(z.string().min(1).max(120), id))
  })
  handle(IPC.portalClearDownloads, () => {
    portal.clearDownloads()
  })
  handle(IPC.portalDownloadDirectory, () => portal.getDownloadDirectoryPath())
  handle(IPC.portalChooseDownloadDirectory, () => portal.chooseDownloadDirectory())

  handle(IPC.materialsDownload, (_event, id) => {
    const materialId = parseInput(z.string().min(1).max(120), id)
    const source = resolveMaterialDownloadSource(store, materialId)
    return portal.downloadFile(source.url, source.materialName, source.referer, source.materialId)
  })
  handle(IPC.materialsLocalFiles, () => portal.listMaterialLocalFiles())
  handle(IPC.materialsOpenLocal, (_event, materialId) => {
    return portal.openMaterialLocalFile(parseInput(z.string().min(1).max(120), materialId))
  })
  handle(IPC.materialsRevealLocal, (_event, materialId) => {
    return portal.revealMaterialLocalFile(parseInput(z.string().min(1).max(120), materialId))
  })

  handle(IPC.entriesCreate, (_event, input) => {
    const parsed = parseInput(entryInputSchema, input) as OfficialEntryInput
    if (!isAllowedPortalUrl(parsed.url)) {
      throw new UserFacingError('ENTRY_URL_BLOCKED', '仅支持学习通官方 HTTPS 域名')
    }
    return store.createOfficialEntry(parsed)
  })

  handle(IPC.entriesUpdateEnabled, (_event, id, enabled) => {
    return store.setOfficialEntryEnabled(
      parseInput(z.string().min(1).max(120), id),
      parseInput(z.boolean(), enabled)
    )
  })

  handle(IPC.entriesRemove, (_event, id) => {
    store.deleteOfficialEntry(parseInput(z.string().min(1).max(120), id))
  })

  handle(IPC.windowIsMaximized, () => {
    const window = getWindow()
    return window ? window.isMaximized() : false
  })

  handle(IPC.appOpenDataDirectory, async () => {
    const message = await shell.openPath(appInfo.dataPath)
    if (message) throw new UserFacingError('OPEN_DIRECTORY_FAILED', message)
  })

  handle(IPC.appOpenExternal, async (_event, rawUrl) => {
    const url = parseInput(z.string().url(), rawUrl)
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new UserFacingError('URL_BLOCKED', '仅允许打开 HTTP(S) 链接')
    }
    await shell.openExternal(url)
  })

  ipcMain.on(IPC.appRendererReady, () => options.onRendererReady())

  ipcMain.on(IPC.windowMinimize, () => getWindow()?.minimize())
  ipcMain.on(IPC.windowToggleMaximize, () => {
    const window = getWindow()
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  ipcMain.on(IPC.windowClose, () => getWindow()?.close())
  ipcMain.on(IPC.windowQuit, () => {
    app.quit()
  })
}
