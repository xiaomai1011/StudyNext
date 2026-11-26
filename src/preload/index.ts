import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AppSettings,
  BatchRetryResult,
  BootstrapData,
  ChaoxingCredentialStatus,
  ChaoxingSessionStatus,
  ChaoxingAvatarUpdatedEvent,
  Course,
  ImportResult,
  MaterialLocalFile,
  OfficialEntry,
  OfficialEntryInput,
  PortalAutoLoginResult,
  PortalDownload,
  PortalSecurityState,
  PortalState,
  PortalSubmitEvent,
  PortalUploadEvent,
  ReminderFiredEvent,
  SnapshotImportResult,
  StudyNextApi,
  SyncProgressEvent,
  SyncStatus,
  SystemReminderStatus,
  Task,
  TaskChange,
  TaskUpsertInput,
  ToggleStudyPointResult,
  WindowStateEvent
} from '@shared/types'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: StudyNextApi = {
  bootstrap: () => ipcRenderer.invoke(IPC.bootstrap) as Promise<BootstrapData>,
  tasks: {
    create: (input: TaskUpsertInput) => ipcRenderer.invoke(IPC.tasksCreate, input) as Promise<Task>,
    update: (id: string, input: TaskUpsertInput) =>
      ipcRenderer.invoke(IPC.tasksUpdate, id, input) as Promise<Task>,
    remove: (id: string) => ipcRenderer.invoke(IPC.tasksRemove, id) as Promise<void>,
    setCompleted: (id: string, completed: boolean) =>
      ipcRenderer.invoke(IPC.tasksSetCompleted, id, completed) as Promise<Task>,
    history: (id: string) => ipcRenderer.invoke(IPC.tasksHistory, id) as Promise<TaskChange[]>,
    downloadAttachment: (taskId: string, attachmentIndex: number) =>
      ipcRenderer.invoke(IPC.tasksDownloadAttachment, taskId, attachmentIndex) as Promise<void>
  },
  courses: {
    setFavorite: (id: string, favorite: boolean) =>
      ipcRenderer.invoke(IPC.coursesSetFavorite, id, favorite) as Promise<Course>
  },
  materials: {
    download: (id: string) =>
      ipcRenderer.invoke(IPC.materialsDownload, id) as Promise<PortalDownload>,
    localFiles: () => ipcRenderer.invoke(IPC.materialsLocalFiles) as Promise<MaterialLocalFile[]>,
    openLocal: (materialId: string) =>
      ipcRenderer.invoke(IPC.materialsOpenLocal, materialId) as Promise<void>,
    revealLocal: (materialId: string) =>
      ipcRenderer.invoke(IPC.materialsRevealLocal, materialId) as Promise<void>,
    onLocalFilesChanged: (callback: (files: MaterialLocalFile[]) => void) =>
      subscribe<MaterialLocalFile[]>(IPC.materialsLocalFilesEvent, callback)
  },
  study: {
    setPointCompleted: (id: string, completed: boolean) =>
      ipcRenderer.invoke(IPC.studySetPointCompleted, {
        id,
        completed
      }) as Promise<ToggleStudyPointResult>
  },
  settings: {
    update: (patch: Partial<AppSettings>) =>
      ipcRenderer.invoke(IPC.settingsUpdate, patch) as Promise<AppSettings>,
    testNotification: () => ipcRenderer.invoke(IPC.settingsTestNotification) as Promise<void>
  },
  notifications: {
    systemStatus: () =>
      ipcRenderer.invoke(IPC.notificationsSystemStatus) as Promise<SystemReminderStatus>,
    repairSystemTask: () =>
      ipcRenderer.invoke(IPC.notificationsRepairSystemTask) as Promise<SystemReminderStatus>
  },
  demo: {
    reset: () => ipcRenderer.invoke(IPC.demoReset) as Promise<void>
  },
  imports: {
    csvIcs: (payload: { fileName: string; content: string }) =>
      ipcRenderer.invoke(IPC.importsCsvIcs, payload) as Promise<ImportResult>,
    snapshot: (payload: { fileName: string; content: string }) =>
      ipcRenderer.invoke(IPC.importsSnapshot, payload) as Promise<SnapshotImportResult>
  },
  sync: {
    status: () => ipcRenderer.invoke(IPC.syncStatus) as Promise<SyncStatus>,
    run: (operationId?: string) =>
      ipcRenderer.invoke(IPC.syncRun, operationId) as Promise<SyncStatus>
  },
  chaoxing: {
    status: () => ipcRenderer.invoke(IPC.chaoxingStatus) as Promise<ChaoxingSessionStatus>,
    check: (operationId?: string) =>
      ipcRenderer.invoke(IPC.chaoxingCheck, operationId) as Promise<ChaoxingSessionStatus>,
    sync: (force?: boolean, operationId?: string) =>
      ipcRenderer.invoke(
        IPC.chaoxingSync,
        force === true,
        operationId
      ) as Promise<ChaoxingSessionStatus>,
    retryCourse: (courseId: string, operationId?: string) =>
      ipcRenderer.invoke(
        IPC.chaoxingRetryCourse,
        courseId,
        operationId
      ) as Promise<ChaoxingSessionStatus>,
    cancel: (operationId?: string) =>
      ipcRenderer.invoke(IPC.chaoxingCancel, operationId) as Promise<ChaoxingSessionStatus>,
    onSyncProgress: (callback: (event: SyncProgressEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: SyncProgressEvent): void => {
        callback(payload)
      }
      ipcRenderer.on(IPC.chaoxingSyncProgress, listener)
      return () => {
        ipcRenderer.removeListener(IPC.chaoxingSyncProgress, listener)
      }
    },
    onAvatarUpdated: (callback: (event: ChaoxingAvatarUpdatedEvent) => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: ChaoxingAvatarUpdatedEvent
      ): void => {
        callback(payload)
      }
      ipcRenderer.on(IPC.chaoxingAvatarUpdated, listener)
      return () => {
        ipcRenderer.removeListener(IPC.chaoxingAvatarUpdated, listener)
      }
    },
    credentialsStatus: () =>
      ipcRenderer.invoke(IPC.chaoxingCredentialsStatus) as Promise<ChaoxingCredentialStatus>,
    saveCredentials: (input) =>
      ipcRenderer.invoke(IPC.chaoxingCredentialsSave, input) as Promise<ChaoxingCredentialStatus>,
    clearCredentials: () =>
      ipcRenderer.invoke(IPC.chaoxingCredentialsClear) as Promise<ChaoxingCredentialStatus>,
    fillCredentials: () => ipcRenderer.invoke(IPC.chaoxingCredentialsFill) as Promise<boolean>,
    autoLogin: (accountId?: string, operationId?: string, automatic?: boolean) =>
      ipcRenderer.invoke(
        IPC.chaoxingAutoLogin,
        accountId,
        operationId,
        automatic === true
      ) as Promise<PortalAutoLoginResult>,
    removeAccount: (id: string) =>
      ipcRenderer.invoke(IPC.chaoxingCredentialsRemove, id) as Promise<ChaoxingCredentialStatus>,
    activateAccount: (id: string) =>
      ipcRenderer.invoke(IPC.chaoxingCredentialsActivate, id) as Promise<ChaoxingCredentialStatus>,
    switchAccount: (id: string) =>
      ipcRenderer.invoke(IPC.chaoxingSwitchAccount, id) as Promise<ChaoxingCredentialStatus>
  },
  portal: {
    open: (entryId: string) => ipcRenderer.invoke(IPC.portalOpen, entryId) as Promise<void>,
    openUrl: (url: string) => ipcRenderer.invoke(IPC.portalOpenUrl, url) as Promise<void>,
    hide: () => ipcRenderer.invoke(IPC.portalHide) as Promise<void>,
    close: () => ipcRenderer.invoke(IPC.portalClose) as Promise<void>,
    state: () => ipcRenderer.invoke(IPC.portalState) as Promise<PortalState>,
    back: () => ipcRenderer.invoke(IPC.portalBack) as Promise<void>,
    forward: () => ipcRenderer.invoke(IPC.portalForward) as Promise<void>,
    reload: () => ipcRenderer.invoke(IPC.portalReload) as Promise<void>,
    openInitialInBrowser: () => ipcRenderer.invoke(IPC.portalOpenInitialInBrowser) as Promise<void>,
    clearSession: () => ipcRenderer.invoke(IPC.portalClearSession) as Promise<void>,
    clearNavigationLog: () => ipcRenderer.invoke(IPC.portalClearNavigationLog) as Promise<void>,
    securityState: () =>
      ipcRenderer.invoke(IPC.portalSecurityState) as Promise<PortalSecurityState>,
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke(IPC.portalSetBounds, bounds) as Promise<void>,
    downloads: () => ipcRenderer.invoke(IPC.portalDownloads) as Promise<PortalDownload[]>,
    download: (url: string) => ipcRenderer.invoke(IPC.portalDownload, url) as Promise<void>,
    openDownload: (id: string) => ipcRenderer.invoke(IPC.portalOpenDownload, id) as Promise<void>,
    revealDownload: (id: string) =>
      ipcRenderer.invoke(IPC.portalRevealDownload, id) as Promise<void>,
    cancelDownload: (id: string) =>
      ipcRenderer.invoke(IPC.portalCancelDownload, id) as Promise<void>,
    retryDownload: (id: string) =>
      ipcRenderer.invoke(IPC.portalRetryDownload, id) as Promise<PortalDownload | null>,
    retryFailedDownloads: (options?: { courseId?: string | null; downloadIds?: string[] }) =>
      ipcRenderer.invoke(IPC.portalRetryFailedDownloads, options) as Promise<BatchRetryResult>,
    deleteDownload: (id: string) =>
      ipcRenderer.invoke(IPC.portalDeleteDownload, id) as Promise<void>,
    clearDownloads: () => ipcRenderer.invoke(IPC.portalClearDownloads) as Promise<void>,
    downloadDirectory: () => ipcRenderer.invoke(IPC.portalDownloadDirectory) as Promise<string>,
    chooseDownloadDirectory: () =>
      ipcRenderer.invoke(IPC.portalChooseDownloadDirectory) as Promise<string | null>,
    onDownload: (callback: (item: PortalDownload) => void) =>
      subscribe<PortalDownload>(IPC.portalDownloadEvent, callback),
    onUpload: (callback: (event: PortalUploadEvent) => void) =>
      subscribe<PortalUploadEvent>(IPC.portalUploadEvent, callback),
    onSubmitDetected: (callback: (event: PortalSubmitEvent) => void) =>
      subscribe<PortalSubmitEvent>(IPC.portalSubmitDetected, callback),
    onState: (callback: (state: PortalState) => void) =>
      subscribe<PortalState>(IPC.eventPortalState, callback)
  },
  entries: {
    create: (input: OfficialEntryInput) =>
      ipcRenderer.invoke(IPC.entriesCreate, input) as Promise<OfficialEntry>,
    updateEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke(IPC.entriesUpdateEnabled, id, enabled) as Promise<OfficialEntry>,
    remove: (id: string) => ipcRenderer.invoke(IPC.entriesRemove, id) as Promise<void>
  },
  window: {
    minimize: () => ipcRenderer.send(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.send(IPC.windowToggleMaximize),
    close: () => ipcRenderer.send(IPC.windowClose),
    quit: () => ipcRenderer.send(IPC.windowQuit),
    isMaximized: () => ipcRenderer.invoke(IPC.windowIsMaximized) as Promise<boolean>,
    onMaximized: (callback: (event: WindowStateEvent) => void) =>
      subscribe<WindowStateEvent>(IPC.eventWindowMaximized, callback)
  },
  app: {
    onNavigate: (callback) => subscribe(IPC.eventNavigate, callback),
    onReminder: (callback: (event: ReminderFiredEvent) => void) =>
      subscribe<ReminderFiredEvent>(IPC.eventReminder, callback),
    onFocusTask: (callback: (taskId: string) => void) =>
      subscribe<string>(IPC.eventFocusTask, callback),
    rendererReady: () => ipcRenderer.send(IPC.appRendererReady),
    openDataDirectory: () => ipcRenderer.invoke(IPC.appOpenDataDirectory) as Promise<void>,
    openExternal: (url: string) => ipcRenderer.invoke(IPC.appOpenExternal, url) as Promise<void>
  }
}

contextBridge.exposeInMainWorld('studynext', api)
