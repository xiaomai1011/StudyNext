import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  shell,
  Tray
} from 'electron'
import { APP_ID, APP_NAME } from '@shared/constants'
import { IPC } from '@shared/ipc'
import {
  buildReminderToastXml,
  parseTaskActivationArgument,
  TASK_ACTIVATION_PROTOCOL
} from '@shared/task-activation'
import type {
  AppNotice,
  AppSettings,
  ChaoxingCredentialStatus,
  NavigateTarget,
  ReminderFiredEvent,
  SyncStatus
} from '@shared/types'
import { StudyNextStore } from './storage/store'
import { WorkspaceManager } from './storage/workspaces'
import { performAccountSwitch } from './account-switch'
import {
  createNotificationScheduler,
  findNextReminderAt,
  formatReminderOffset,
  type NotificationScheduler
} from './notifications/scheduler'
import { earliestIso } from './notifications/retry-policy'
import { runHeadlessReminderCheck } from './notifications/headless'
import { readCurrentUserSid, SystemReminderService } from './notifications/system-reminder'
import { openStartupWorkspace } from './startup-workspace'
import { SyncService } from './integrations/sync'
import { ChaoxingSessionService } from './integrations/chaoxing/service'
import { ChaoxingSessionAdapter } from './integrations/chaoxing/adapter'
import { ChaoxingCredentialStore } from './integrations/chaoxing/credentials'
import { PortalService } from './portal/service'
import { registerIpc } from './ipc'
import { errorMessage } from './lib/errors'
import { ensureUserDataDirectory, userDataPathCandidates } from './lib/user-data'
import { loadWindowState, trackWindowState } from './window-state'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let store: StudyNextStore | null = null
let scheduler: NotificationScheduler | null = null
let systemReminderService: SystemReminderService | null = null
let portal: PortalService | null = null
let credentialStore: ChaoxingCredentialStore | null = null
let workspaceManager: WorkspaceManager | null = null
let chaoxingService: ChaoxingSessionService | null = null
let syncService: SyncService | null = null
let isQuitting = false
let switchingAccount = false
let stopWindowStateTracking: (() => void) | null = null
let lastAppliedUiZoom = 1
let pendingFocusTaskId: string | null = null
let rendererReady = false

const startHidden = process.argv.includes('--hidden')
const headlessReminderCheck = process.argv.includes('--check-reminders')
const installSystemReminders = process.argv.includes('--install-reminders')
const uninstallSystemReminders = process.argv.includes('--uninstall-reminders')
const startupFocusTaskId = parseTaskActivationArgument(process.argv)

app.setName(APP_NAME)
app.setAppUserModelId(APP_ID)

function registerProtocolClient(): boolean {
  if (app.isPackaged) {
    return app.setAsDefaultProtocolClient(TASK_ACTIVATION_PROTOCOL)
  }
  return app.setAsDefaultProtocolClient(TASK_ACTIVATION_PROTOCOL, process.execPath, [
    app.getAppPath()
  ])
}

function removeProtocolClient(): boolean {
  return app.removeAsDefaultProtocolClient(TASK_ACTIVATION_PROTOCOL)
}

async function runHeadlessReminderProcess(): Promise<void> {
  const dataPath = app.getPath('userData')
  const context = await openStartupWorkspace(dataPath)
  if (context.store.readOnly) {
    context.store.close()
    app.exit(0)
    return
  }
  const systemReminder = new SystemReminderService({
    dataDir: dataPath,
    executablePath: process.execPath,
    packaged: app.isPackaged,
    sid: readCurrentUserSid()
  })
  const notifications: Notification[] = []
  let exitCode = 0
  try {
    await systemReminder.initialize()
    const settings = context.store.getSettings()
    const result = await runHeadlessReminderCheck({
      store: context.store,
      notify: async (event) => {
        const notification = await showHeadlessReminderNotification(event)
        notifications.push(notification)
      }
    })
    // A successful retry clears its own store row. The service error is always
    // read back from the durable queue, not inferred from this run's errors.
    const error =
      context.store.latestDeliveryError() ??
      (result.errors.length > 0 ? result.errors.slice(0, 3).join('；') : null)
    systemReminder.recordCheck({
      at: result.checkedAt,
      delivered: result.delivered,
      error
    })
    await systemReminder.syncNextTrigger({
      enabled: settings.notificationsEnabled,
      nextRunAt: result.nextReminderAt
    })
    if (result.failed > 0) exitCode = 1
  } catch (error) {
    exitCode = 1
    systemReminder.recordCheck({ error: errorMessage(error) })
    console.error(`[headless] ${errorMessage(error)}`)
  } finally {
    context.store.close()
  }
  if (notifications.length > 0) await delay(10_000)
  app.exit(exitCode)
}

async function runInstallSystemRemindersProcess(): Promise<void> {
  const dataPath = app.getPath('userData')
  const context = await openStartupWorkspace(dataPath)
  let exitCode = 0
  try {
    if (context.store.readOnly) {
      throw new Error('当前数据目录为只读历史工作区，未注册系统级提醒')
    }
    const service = new SystemReminderService({
      dataDir: dataPath,
      executablePath: process.execPath,
      packaged: app.isPackaged,
      sid: readCurrentUserSid()
    })
    await service.initialize()
    const settings = context.store.getSettings()
    const nextRunAt = settings.notificationsEnabled
      ? earliestIso([
          findNextReminderAt(context.store.listTasks()),
          context.store.nextDeliveryRetryAt()
        ])
      : null
    await service.syncNextTrigger({
      enabled: settings.notificationsEnabled,
      nextRunAt
    })
  } catch (error) {
    exitCode = 1
    console.error(`[install-reminders] ${errorMessage(error)}`)
  } finally {
    context.store.close()
  }
  app.exit(exitCode)
}

async function runUninstallSystemRemindersProcess(): Promise<void> {
  try {
    const service = new SystemReminderService({
      dataDir: app.getPath('userData'),
      executablePath: process.execPath,
      packaged: app.isPackaged,
      sid: readCurrentUserSid()
    })
    await service.initialize()
    await service.removeAllOwnedTasks()
    removeProtocolClient()
  } catch (error) {
    console.error(`[uninstall-reminders] ${errorMessage(error)}`)
    app.exit(1)
    return
  }
  app.exit(0)
}

function showHeadlessReminderNotification(event: ReminderFiredEvent): Promise<Notification> {
  if (!Notification.isSupported()) {
    return Promise.reject(new Error('当前系统不支持桌面通知'))
  }
  const due = new Date(event.dueAt)
  const dueLabel = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(due)
  const course = event.courseName ? `【${event.courseName}】` : ''
  // Protocol activation, not a click callback: the headless process exits
  // before the user can interact with the Windows Action Center.
  const notification = new Notification({
    toastXml: buildReminderToastXml({
      title: `学习提醒 · ${formatReminderOffset(event.offsetMinutes)}`,
      body: `${course}《${event.taskTitle}》将于 ${dueLabel} 截止`,
      taskId: event.taskId,
      iconPath: pathToFileURL(resourcePath('icon.png')).toString()
    })
  })
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('系统通知未在预期时间内显示'))
    }, 4_000)
    notification.once('show', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(notification)
    })
    notification.once('failed', (_event, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(error || '系统通知创建失败'))
    })
    notification.show()
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveUserDataPath(): string {
  return ensureUserDataDirectory(
    userDataPathCandidates({
      platform: process.platform,
      appData: app.getPath('appData'),
      localAppData: process.env.LOCALAPPDATA,
      override: process.env.STUDYNEXT_DATA_DIR
    })
  )
}

let startupError: Error | null = null
try {
  const userDataPath = resolveUserDataPath()
  app.setPath('userData', userDataPath)
} catch (error) {
  startupError = error instanceof Error ? error : new Error(String(error))
}

if (headlessReminderCheck || installSystemReminders || uninstallSystemReminders) {
  const mode = headlessReminderCheck
    ? 'headless'
    : installSystemReminders
      ? 'install-reminders'
      : 'uninstall-reminders'
  const run = headlessReminderCheck
    ? runHeadlessReminderProcess
    : installSystemReminders
      ? runInstallSystemRemindersProcess
      : runUninstallSystemRemindersProcess
  if (startupError) {
    console.error(`[${mode}] ${startupError.message}`)
    app.exit(1)
  } else {
    app
      .whenReady()
      .then(() => {
        if (!uninstallSystemReminders) registerProtocolClient()
        return run()
      })
      .catch((error: unknown) => {
        console.error(`[${mode}] ${errorMessage(error)}`)
        app.exit(1)
      })
  }
} else {
  const gotLock = startupError ? false : app.requestSingleInstanceLock()
  if (startupError) {
    void app.whenReady().then(() => {
      dialog.showErrorBox(
        'StudyNext 无法启动',
        `${startupError?.message ?? '本地数据目录不可用'}\n\n应用不会回退到临时目录，以免关闭后丢失课程和任务数据。`
      )
      app.quit()
    })
  } else if (!gotLock) {
    app.quit()
  } else {
    app.on('second-instance', (_event, argv) => {
      const taskId = parseTaskActivationArgument(argv)
      if (taskId) focusTaskInWindow(taskId)
      else showMainWindow()
    })
    app
      .whenReady()
      .then(() => {
        registerProtocolClient()
        return initialize()
      })
      .catch((error: unknown) => {
        console.error(`[startup] ${errorMessage(error)}`)
        dialog.showErrorBox('StudyNext 无法完成初始化', errorMessage(error))
        app.quit()
      })
  }
}

async function initialize(): Promise<void> {
  const dataPath = app.getPath('userData')
  const credentials = new ChaoxingCredentialStore()
  const workspaces = new WorkspaceManager(dataPath)
  credentialStore = credentials
  workspaceManager = workspaces
  const credentialStatus = await credentials.status()
  const activeAccount = credentialStatus.activeAccountId
    ? credentialStatus.accounts.find((item) => item.id === credentialStatus.activeAccountId)
    : null
  const verifiedAccount = activeAccount?.platformUid
    ? {
        id: activeAccount.id,
        platformUid: activeAccount.platformUid,
        displayName: activeAccount.displayName,
        school: activeAccount.school
      }
    : null
  const startupWorkspace = workspaces.resolveStartupWorkspace(verifiedAccount, {
    legacyPath: join(dataPath, 'studynext.sqlite')
  })
  if (
    verifiedAccount &&
    startupWorkspace.status !== 'readonly' &&
    (startupWorkspace.accountId !== verifiedAccount.id ||
      startupWorkspace.platformUid !== verifiedAccount.platformUid)
  ) {
    throw new Error('当前账号身份与启动数据库不一致，已阻止加载可写数据库')
  }
  workspaces.clearPendingSwitch()
  store = new StudyNextStore(startupWorkspace.filePath, {
    workspaceId: startupWorkspace.id,
    accountId: startupWorkspace.accountId,
    readOnly: startupWorkspace.status === 'readonly'
  })
  portal = new PortalService(
    store,
    () => mainWindow,
    (accountId) => (accountId ? credentials.loadAccount(accountId) : credentials.load())
  )

  const notices = buildDemoNotices()
  const sync = new SyncService(store)
  syncService = sync
  const chaoxing = new ChaoxingSessionService(
    store,
    new ChaoxingSessionAdapter(
      undefined,
      (signal) => (portal ? portal.ensureCoursePageHtml(signal) : Promise.resolve(null)),
      (signal) => (portal ? portal.readScheduleFromPage(signal) : Promise.resolve(null)),
      (signal) => (portal ? portal.readExamListFromPage(signal) : Promise.resolve(null)),
      (courseUrl, signal) =>
        portal ? portal.readChapterHtml(courseUrl, signal) : Promise.resolve(null),
      (signal) => (portal ? portal.readNoticeListFromPage(signal) : Promise.resolve(null)),
      (courseUrl, signal) =>
        portal ? portal.readMaterialHtml(courseUrl, signal) : Promise.resolve(null)
    ),
    (outcome) => {
      sync.recordSessionResult(outcome)
    },
    (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.chaoxingSyncProgress, event)
      }
    },
    portal.createSyncNavigationGuard(),
    (uid) => (portal ? portal.readAvatarDataUrl(uid) : Promise.resolve(null)),
    (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.chaoxingAvatarUpdated, event)
      }
    }
  )
  chaoxingService = chaoxing
  if (!store.readOnly) {
    systemReminderService = new SystemReminderService({
      dataDir: dataPath,
      executablePath: process.execPath,
      packaged: app.isPackaged,
      sid: readCurrentUserSid()
    })
    await systemReminderService.initialize()
  }
  const processScheduler = createNotificationScheduler({
    store,
    notify: (event) => showReminderNotification(event),
    onSchedulerEvent: (event) => {
      mainWindow?.webContents.send('event:reminder', event)
    },
    onSchedulerSettled: () => {
      // A delivery attempt can create a retry row or consume the current
      // one-shot trigger. Reposition the Windows task immediately so an app
      // quit right after the attempt cannot strand the retry.
      syncSystemReminderTrigger()
    }
  })
  const notificationScheduler: NotificationScheduler = {
    start: () => {
      const count = processScheduler.start()
      syncSystemReminderTrigger()
      return count
    },
    stop: () => processScheduler.stop(),
    refresh: () => {
      processScheduler.refresh()
      syncSystemReminderTrigger()
    },
    getStartupCatchUpCount: () => processScheduler.getStartupCatchUpCount(),
    getNextReminderAt: () => processScheduler.getNextReminderAt()
  }
  scheduler = notificationScheduler

  createMainWindow()
  createTray()

  const settings = store.getSettings()
  applySettings(settings)

  registerIpc({
    store,
    scheduler: notificationScheduler,
    systemReminder: systemReminderService,
    sync,
    chaoxing,
    credentials,
    workspaces: workspaceManager ?? workspaces,
    portal,
    getWindow: () => mainWindow,
    appInfo: {
      version: app.getVersion(),
      platform: process.platform,
      dataPath,
      isPackaged: app.isPackaged,
      workspace: {
        id: startupWorkspace.id,
        mode:
          startupWorkspace.status === 'readonly'
            ? 'readonly'
            : startupWorkspace.accountId === 'local'
              ? 'local'
              : 'account',
        accountId: startupWorkspace.accountId === 'local' ? null : startupWorkspace.accountId
      }
    },
    notices,
    isSwitchingAccount: () => switchingAccount,
    requestAccountSwitch: (accountId) => requestAccountSwitch(accountId),
    requestRestartToSafeWorkspace: () => requestRestartToSafeWorkspace(),
    requestRestartForAccount: (accountId) => requestRestartForAccount(accountId),
    onSettingsChanged: (next) => {
      applySettings(next)
      syncSystemReminderTrigger()
    },
    onTestNotification: () => {
      showTestNotification()
    },
    onRendererReady: () => {
      rendererReady = true
      flushPendingFocusTask()
    },
    onDemoReset: () => {
      scheduler?.refresh()
    }
  })

  if (!store.readOnly) notificationScheduler.start()
  if (!Notification.isSupported()) {
    console.warn('[notifications] 系统通知不可用，DDL 提醒仍会在应用内触发')
  }

  app.on('activate', () => {
    if (mainWindow) showMainWindow()
    else createMainWindow()
  })
}

async function requestAccountSwitch(accountId: string): Promise<ChaoxingCredentialStatus> {
  const credentials = credentialStore
  const workspaces = workspaceManager
  const currentPortal = portal
  if (!credentials || !workspaces || !currentPortal || !chaoxingService) {
    throw new Error('应用尚未完成初始化')
  }
  if (switchingAccount) throw new Error('账号切换正在进行，请稍候')
  switchingAccount = true
  try {
    return await performAccountSwitch(
      {
        credentials,
        workspaces,
        portal: currentPortal,
        chaoxing: chaoxingService,
        stopScheduler: () => scheduler?.stop(),
        requestRelaunch: scheduleRelaunch
      },
      accountId
    )
  } catch (error) {
    switchingAccount = false
    throw error
  }
}

async function requestRestartForAccount(accountId: string): Promise<ChaoxingCredentialStatus> {
  const credentials = credentialStore
  const workspaces = workspaceManager
  if (!credentials || !workspaces) throw new Error('应用尚未完成初始化')
  if (switchingAccount) throw new Error('账号切换正在进行，请稍候')
  const before = await credentials.status()
  const account = before.accounts.find((item) => item.id === accountId)
  if (!account?.platformUid) throw new Error('账号尚未完成平台身份校验，无法加载工作区')
  switchingAccount = true
  try {
    chaoxingService?.resetForAccountSwitch()
    scheduler?.stop()
    portal?.suspendWritesForAccountSwitch()
    const workspace = workspaces.beginAccountSwitch({
      id: account.id,
      platformUid: account.platformUid,
      displayName: account.displayName,
      school: account.school
    })
    workspaces.setActive(workspace.id)
    await credentials.setActive(account.id)
    scheduleRelaunch()
    return credentials.status()
  } catch (error) {
    switchingAccount = false
    throw error
  }
}

async function requestRestartToSafeWorkspace(): Promise<ChaoxingCredentialStatus> {
  const credentials = credentialStore
  const workspaces = workspaceManager
  if (!credentials || !workspaces) throw new Error('应用尚未完成初始化')
  if (switchingAccount) throw new Error('账号切换正在进行，请稍候')
  switchingAccount = true
  try {
    chaoxingService?.resetForAccountSwitch()
    scheduler?.stop()
    portal?.suspendWritesForAccountSwitch()
    await portal?.clearSession()
    const safe = workspaces.resolveStartupWorkspace(null, {
      legacyPath: join(app.getPath('userData'), 'studynext.sqlite')
    })
    workspaces.setActive(safe.id)
    scheduleRelaunch()
    return credentials.status()
  } catch (error) {
    switchingAccount = false
    throw error
  }
}

function scheduleRelaunch(): void {
  if (process.env.STUDYNEXT_TEST_NO_RELAUNCH === '1') return
  setTimeout(() => {
    isQuitting = true
    app.relaunch()
    app.exit(0)
  }, 700)
}

function createMainWindow(): void {
  if (!store) return
  if (startupFocusTaskId) pendingFocusTaskId = startupFocusTaskId
  const state = loadWindowState(join(app.getPath('userData'), 'window-state.json'))
  const iconPath = resourcePath('icon.png')
  const initialSettings = store.getSettings()
  const initialDark =
    initialSettings.theme === 'dark' ||
    (initialSettings.theme === 'system' && nativeTheme.shouldUseDarkColors)
  const initialZoom = initialSettings.uiZoom
  lastAppliedUiZoom = initialZoom
  mainWindow = new BrowserWindow({
    ...(state.x !== undefined ? { x: state.x } : {}),
    ...(state.y !== undefined ? { y: state.y } : {}),
    width: state.width,
    height: state.height,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    frame: false,
    title: APP_NAME,
    backgroundColor: initialDark ? '#0b0d11' : '#f1f0ec',
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: false
    }
  })
  mainWindow.setMenuBarVisibility(false)
  stopWindowStateTracking = trackWindowState(
    mainWindow,
    join(app.getPath('userData'), 'window-state.json')
  )

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return
    if (initialZoom !== 1) {
      mainWindow.webContents.setZoomFactor(initialZoom)
    }
    if (state.maximized) mainWindow.maximize()
    if (!startHidden) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('event:window-maximized', { maximized: true })
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('event:window-maximized', { maximized: false })
  })

  mainWindow.on('close', (event) => {
    if (!isQuitting && store?.getSettings().closeToTray) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    portal?.destroy()
    stopWindowStateTracking?.()
    stopWindowStateTracking = null
    mainWindow = null
    if (!isQuitting) app.quit()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  rendererReady = false
  mainWindow.webContents.on('did-start-loading', () => {
    rendererReady = false
  })
  mainWindow.webContents.on('did-finish-load', () => {
    // The renderer still needs to mount its React listeners; it calls
    // app:renderer-ready when that handshake is complete.
    if (rendererReady) flushPendingFocusTask()
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  if (tray) return
  const image = nativeImage.createFromPath(resourcePath('tray.png'))
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
  tray.setToolTip(`${APP_NAME} · 学习安排一目了然`)
  tray.on('click', () => {
    if (mainWindow?.isVisible()) mainWindow.hide()
    else showMainWindow()
  })
  refreshTrayMenu()
}

function refreshTrayMenu(): void {
  if (!tray || !store) return
  const settings = store.getSettings()
  const menu = Menu.buildFromTemplate([
    {
      label: '打开 StudyNext',
      click: () => showMainWindow()
    },
    { type: 'separator' },
    {
      label: '今日待办',
      click: () => {
        showMainWindow()
        sendNavigate('dashboard')
      }
    },
    {
      label: '任务中心',
      click: () => {
        showMainWindow()
        sendNavigate('tasks')
      }
    },
    {
      label: '课程中心',
      click: () => {
        showMainWindow()
        sendNavigate('courses')
      }
    },
    { type: 'separator' },
    {
      label: '启用 DDL 提醒',
      type: 'checkbox',
      checked: settings.notificationsEnabled,
      click: (item) => {
        if (!store) return
        const next = store.updateSettings({ notificationsEnabled: item.checked })
        applySettings(next)
        scheduler?.refresh()
        refreshTrayMenu()
      }
    },
    {
      label: '打开数据目录',
      click: () => {
        void shell.openPath(app.getPath('userData'))
      }
    },
    { type: 'separator' },
    {
      label: '退出 StudyNext',
      click: () => app.quit()
    }
  ])
  tray.setContextMenu(menu)
}

function showMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function focusTaskInWindow(taskId: string): void {
  if (!mainWindow) {
    pendingFocusTaskId = taskId
    createMainWindow()
    return
  }
  pendingFocusTaskId = taskId
  showMainWindow()
  flushPendingFocusTask()
}

function flushPendingFocusTask(): void {
  const taskId = pendingFocusTaskId
  if (!taskId || !mainWindow || mainWindow.isDestroyed()) return
  if (!rendererReady || mainWindow.webContents.isLoadingMainFrame()) return
  pendingFocusTaskId = null
  showMainWindow()
  sendNavigate('tasks')
  mainWindow.webContents.send('event:focus-task', taskId)
}

function sendNavigate(target: NavigateTarget): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('event:navigate', target)
}

function syncSystemReminderTrigger(): void {
  if (!store || !systemReminderService) return
  const settings = store.getSettings()
  void systemReminderService
    .syncNextTrigger({
      enabled: settings.notificationsEnabled,
      nextRunAt: earliestIso([findNextReminderAt(store.listTasks()), store.nextDeliveryRetryAt()])
    })
    .catch((error: unknown) => {
      console.warn(`[notifications] 系统级提醒注册失败：${errorMessage(error)}`)
    })
}

function applySettings(settings: AppSettings): void {
  nativeTheme.themeSource = settings.theme
  if (mainWindow && !mainWindow.isDestroyed()) {
    const isDark =
      settings.theme === 'dark' || (settings.theme === 'system' && nativeTheme.shouldUseDarkColors)
    mainWindow.setBackgroundColor(isDark ? '#0b0d11' : '#f1f0ec')
    if (settings.uiZoom !== lastAppliedUiZoom) {
      lastAppliedUiZoom = settings.uiZoom
      mainWindow.webContents.setZoomFactor(settings.uiZoom)
    }
  }
  if (app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: settings.launchAtLogin,
      args: ['--hidden']
    })
  }
  refreshTrayMenu()
}

function showReminderNotification(event: ReminderFiredEvent): void {
  if (!Notification.isSupported()) {
    // The scheduler still emits the in-app reminder event; only the OS-level
    // notification is unavailable on this platform/session.
    return
  }
  const due = new Date(event.dueAt)
  const dueLabel = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(due)
  const notification = new Notification({
    title: `学习提醒 · ${formatReminderOffset(event.offsetMinutes)}`,
    body: `${event.courseName ? `【${event.courseName}】` : ''}《${event.taskTitle}》将于 ${dueLabel} 截止`,
    icon: resourcePath('icon.png')
  })
  notification.on('click', () => {
    showMainWindow()
    sendNavigate('tasks')
    mainWindow?.webContents.send('event:focus-task', event.taskId)
  })
  notification.show()
}

function showTestNotification(): void {
  if (!Notification.isSupported()) {
    throw new Error('当前系统不支持桌面通知')
  }
  const notification = new Notification({
    title: 'StudyNext 通知测试',
    body: '通知可用。DDL 提醒仅在应用运行期间调度，完全退出后不会触发。',
    icon: resourcePath('icon.png')
  })
  notification.show()
}

function buildDemoNotices(): AppNotice[] {
  const now = Date.now()
  const items: Array<{
    id: string
    title: string
    body: string
    category: AppNotice['category']
    hoursAgo: number
  }> = [
    {
      id: 'demo-notice-1',
      title: '数据结构：实验三已发布',
      body: '实验三「图的最短路径」已发布，截止时间以任务中心为准。',
      category: 'course',
      hoursAgo: 2
    },
    {
      id: 'demo-notice-2',
      title: '计算机网络：第二章小测提醒',
      body: '小测将在课程页面开放，请提前检查网络与设备。',
      category: 'course',
      hoursAgo: 7
    },
    {
      id: 'demo-notice-3',
      title: '数字媒体设计：海报提案要求更新',
      body: '老师补充了色彩规范与提交格式，请查看任务详情。',
      category: 'notice',
      hoursAgo: 26
    },
    {
      id: 'demo-notice-4',
      title: '概率论：期中考试考场安排',
      body: '考场为理学楼 205，可携带一张 A4 手写公式纸。',
      category: 'notice',
      hoursAgo: 50
    },
    {
      id: 'demo-notice-5',
      title: 'StudyNext 演示数据',
      body: '当前课程、任务与通知均为本地演示数据，不代表学习通真实数据。',
      category: 'system',
      hoursAgo: 72
    }
  ]
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    body: item.body,
    category: item.category,
    publishedAt: new Date(now - item.hoursAgo * 60 * 60 * 1000).toISOString(),
    isDemo: true
  }))
}

function resourcePath(fileName: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, fileName)
    : join(app.getAppPath(), 'resources', fileName)
}

app.on('before-quit', () => {
  isQuitting = true
  scheduler?.stop()
  portal?.destroy()
  tray?.destroy()
  tray = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  store?.close()
  store = null
})

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
})
