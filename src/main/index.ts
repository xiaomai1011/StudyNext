import { join } from 'node:path'
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
import type {
  AppNotice,
  AppSettings,
  NavigateTarget,
  ReminderFiredEvent,
  SyncStatus
} from '@shared/types'
import { StudyNextStore } from './storage/store'
import {
  createNotificationScheduler,
  formatReminderOffset,
  type NotificationScheduler
} from './notifications/scheduler'
import { SyncService } from './integrations/sync'
import { ChaoxingSessionService } from './integrations/chaoxing/service'
import { ChaoxingSessionAdapter } from './integrations/chaoxing/adapter'
import { ChaoxingCredentialStore } from './integrations/chaoxing/credentials'
import { AiService } from './integrations/ai'
import { PortalService } from './portal/service'
import { registerIpc } from './ipc'
import { errorMessage } from './lib/errors'
import { ensureUserDataDirectory, userDataPathCandidates } from './lib/user-data'
import { loadWindowState, trackWindowState } from './window-state'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let store: StudyNextStore | null = null
let scheduler: NotificationScheduler | null = null
let portal: PortalService | null = null
let isQuitting = false
let stopWindowStateTracking: (() => void) | null = null

const startHidden = process.argv.includes('--hidden')

app.setName(APP_NAME)
app.setAppUserModelId(APP_ID)

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
  app.on('second-instance', () => {
    showMainWindow()
  })
  app
    .whenReady()
    .then(initialize)
    .catch((error: unknown) => {
      console.error(`[startup] ${errorMessage(error)}`)
      dialog.showErrorBox('StudyNext 无法完成初始化', errorMessage(error))
      app.quit()
    })
}

async function initialize(): Promise<void> {
  const dataPath = app.getPath('userData')
  store = new StudyNextStore(join(dataPath, 'studynext.sqlite'))
  const credentials = new ChaoxingCredentialStore()
  portal = new PortalService(
    store,
    () => mainWindow,
    () => credentials.load()
  )

  const notices = buildDemoNotices()
  const sync = new SyncService(store)
  const chaoxing = new ChaoxingSessionService(
    store,
    new ChaoxingSessionAdapter(
      undefined,
      () => (portal ? portal.ensureCoursePageHtml() : Promise.resolve(null)),
      () => (portal ? portal.readScheduleFromPage() : Promise.resolve(null))
    ),
    (outcome) => {
      sync.recordSessionResult(outcome)
    }
  )
  const ai = new AiService(store)
  scheduler = createNotificationScheduler({
    store,
    notify: (event) => showReminderNotification(event),
    onSchedulerEvent: (event) => {
      mainWindow?.webContents.send('event:reminder', event)
    }
  })

  createMainWindow()
  createTray()

  const settings = store.getSettings()
  applySettings(settings)

  registerIpc({
    store,
    scheduler,
    sync,
    chaoxing,
    credentials,
    ai,
    portal,
    getWindow: () => mainWindow,
    appInfo: {
      version: app.getVersion(),
      platform: process.platform,
      dataPath,
      isPackaged: app.isPackaged
    },
    notices,
    onSettingsChanged: (next) => {
      applySettings(next)
    },
    onTestNotification: () => {
      showTestNotification()
    },
    onDemoReset: () => {
      scheduler?.refresh()
    }
  })

  scheduler.start()
  if (!Notification.isSupported()) {
    console.warn('[notifications] 系统通知不可用，DDL 提醒仍会在应用内触发')
  }

  app.on('activate', () => {
    if (mainWindow) showMainWindow()
    else createMainWindow()
  })
}

function createMainWindow(): void {
  if (!store) return
  const state = loadWindowState(join(app.getPath('userData'), 'window-state.json'))
  const iconPath = resourcePath('icon.png')
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
    backgroundColor: '#0c1222',
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

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  if (tray) return
  const image = nativeImage.createFromPath(resourcePath('tray.png'))
  tray = new Tray(
    image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 })
  )
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

function sendNavigate(target: NavigateTarget): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('event:navigate', target)
}

function applySettings(settings: AppSettings): void {
  nativeTheme.themeSource = settings.theme
  if (mainWindow) {
    mainWindow.setBackgroundColor(settings.theme === 'dark' ? '#0c1222' : '#f5f7fb')
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
    body: `《${event.taskTitle}》将于 ${dueLabel} 截止`,
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
