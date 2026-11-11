import { app, ipcMain, Notification, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { IPC } from '@shared/ipc'
import type {
  AppNotice,
  AppSettings,
  BootstrapData,
  OfficialEntryInput,
  SyncStatus,
  TaskUpsertInput
} from '@shared/types'
import {
  aiAskInputSchema,
  aiConfigInputSchema,
  entryInputSchema,
  importPayloadSchema,
  questionInputSchema,
  questionSourceSchema,
  settingsPatchSchema,
  studyPointStatusSchema,
  taskUpsertSchema,
  type ParsedTaskUpsert
} from '@shared/validation'
import type { StudyNextStore } from './storage/store'
import type { ReminderScheduler } from './notifications/scheduler'
import type { SyncService } from './integrations/sync'
import type { PortalService } from './portal/service'
import { importTasksFromFile } from './integrations/import'
import { importStudySnapshot } from './integrations/snapshot'
import type { AiService } from './integrations/ai'
import { isAllowedPortalUrl } from './portal/security'
import { errorMessage, UserFacingError } from './lib/errors'

interface RegisterIpcOptions {
  store: StudyNextStore
  scheduler: ReminderScheduler
  sync: SyncService
  ai: AiService
  portal: PortalService
  getWindow: () => BrowserWindow | null
  appInfo: BootstrapData['appInfo']
  notices: AppNotice[]
  onSettingsChanged: (settings: AppSettings) => void
  onTestNotification: () => void
  onDemoReset: () => void
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new UserFacingError('VALIDATION', first?.message ?? '输入无效')
  }
  return result.data
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
  return patch
}

export function registerIpc(options: RegisterIpcOptions): void {
  const {
    store,
    scheduler,
    sync,
    ai,
    portal,
    getWindow,
    appInfo,
    notices,
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

  handle(IPC.bootstrap, () => {
    const bootstrap: BootstrapData = {
      courses: store.listCourses(),
      chapters: store.listChapters(),
      studyPoints: store.listStudyPoints(),
      questions: store.listQuestions(),
      tasks: store.listTasks(),
      settings: store.getSettings(),
      notices,
      syncStatus: sync.getStatus(),
      officialEntries: store.listOfficialEntries(),
      appInfo,
      reminderRuntime: {
        mode: 'process_running',
        note: '提醒仅在 StudyNext 运行期间调度；完全退出应用后定时器停止，不会在退出后发送通知。重新启动时会检查并补发最近 10 分钟内错过的提醒。',
        systemNotificationsSupported: Notification.isSupported(),
        startupCatchUpCount: scheduler.getStartupCatchUpCount(),
        nextReminderAt: scheduler.getNextReminderAt()
      }
    }
    return bootstrap
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
    const task = store.updateTask(taskId, toTaskUpsertInput(parsed))
    scheduler.refresh()
    return task
  })

  handle(IPC.tasksRemove, (_event, id) => {
    store.deleteTask(parseInput(z.string().uuid(), id))
    scheduler.refresh()
  })

  handle(IPC.tasksSetCompleted, (_event, id, completed) => {
    const task = store.setTaskCompleted(
      parseInput(z.string().uuid(), id),
      parseInput(z.boolean(), completed)
    )
    scheduler.refresh()
    return task
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

  handle(IPC.questionsCreate, (_event, input, source) => {
    return store.createQuestion(
      parseInput(questionInputSchema, input),
      parseInput(questionSourceSchema, source)
    )
  })

  handle(IPC.questionsUpdate, (_event, id, input) => {
    return store.updateQuestion(
      parseInput(z.string().uuid(), id),
      parseInput(questionInputSchema, input)
    )
  })

  handle(IPC.questionsRemove, (_event, id) => {
    store.deleteQuestion(parseInput(z.string().uuid(), id))
  })

  handle(IPC.aiGetConfig, () => ai.getConfig())

  handle(IPC.aiUpdateConfig, (_event, input) => {
    return ai.updateConfig(parseInput(aiConfigInputSchema, input))
  })

  handle(IPC.aiAsk, (_event, input) => {
    const parsed = parseInput(aiAskInputSchema, input)
    return ai.ask(parsed.question, parsed.courseId)
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

  handle(IPC.syncStatus, () => sync.getStatus())
  handle(IPC.syncRun, () => sync.run())

  handle(IPC.portalOpen, (_event, entryId) => {
    return portal.open(parseInput(z.string().min(1).max(120), entryId))
  })
  handle(IPC.portalClose, () => portal.close())
  handle(IPC.portalState, () => portal.getState())
  handle(IPC.portalBack, () => portal.back())
  handle(IPC.portalForward, () => portal.forward())
  handle(IPC.portalReload, () => portal.reload())
  handle(IPC.portalOpenInitialInBrowser, () => portal.openInitialInBrowser())
  handle(IPC.portalClearSession, () => portal.clearSession())
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
