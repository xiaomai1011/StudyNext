import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AiAnswer,
  AiAskInput,
  AiConfig,
  AiConfigInput,
  AppSettings,
  BootstrapData,
  ChaoxingCredentialStatus,
  ChaoxingSessionStatus,
  Course,
  ImportResult,
  OfficialEntry,
  OfficialEntryInput,
  PortalSecurityState,
  PortalState,
  QuestionCard,
  QuestionInput,
  QuestionSource,
  ReminderFiredEvent,
  SnapshotImportResult,
  StudyNextApi,
  SyncStatus,
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
    history: (id: string) => ipcRenderer.invoke(IPC.tasksHistory, id) as Promise<TaskChange[]>
  },
  courses: {
    setFavorite: (id: string, favorite: boolean) =>
      ipcRenderer.invoke(IPC.coursesSetFavorite, id, favorite) as Promise<Course>
  },
  study: {
    setPointCompleted: (id: string, completed: boolean) =>
      ipcRenderer.invoke(IPC.studySetPointCompleted, {
        id,
        completed
      }) as Promise<ToggleStudyPointResult>
  },
  questions: {
    create: (input: QuestionInput, source?: QuestionSource) =>
      ipcRenderer.invoke(IPC.questionsCreate, input, source) as Promise<QuestionCard>,
    update: (id: string, input: QuestionInput) =>
      ipcRenderer.invoke(IPC.questionsUpdate, id, input) as Promise<QuestionCard>,
    remove: (id: string) => ipcRenderer.invoke(IPC.questionsRemove, id) as Promise<void>
  },
  ai: {
    getConfig: () => ipcRenderer.invoke(IPC.aiGetConfig) as Promise<AiConfig>,
    updateConfig: (input: AiConfigInput) =>
      ipcRenderer.invoke(IPC.aiUpdateConfig, input) as Promise<AiConfig>,
    ask: (input: AiAskInput) => ipcRenderer.invoke(IPC.aiAsk, input) as Promise<AiAnswer>
  },
  settings: {
    update: (patch: Partial<AppSettings>) =>
      ipcRenderer.invoke(IPC.settingsUpdate, patch) as Promise<AppSettings>,
    testNotification: () => ipcRenderer.invoke(IPC.settingsTestNotification) as Promise<void>
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
    run: () => ipcRenderer.invoke(IPC.syncRun) as Promise<SyncStatus>
  },
  chaoxing: {
    status: () => ipcRenderer.invoke(IPC.chaoxingStatus) as Promise<ChaoxingSessionStatus>,
    check: () => ipcRenderer.invoke(IPC.chaoxingCheck) as Promise<ChaoxingSessionStatus>,
    sync: () => ipcRenderer.invoke(IPC.chaoxingSync) as Promise<ChaoxingSessionStatus>,
    credentialsStatus: () =>
      ipcRenderer.invoke(IPC.chaoxingCredentialsStatus) as Promise<ChaoxingCredentialStatus>,
    saveCredentials: (input) =>
      ipcRenderer.invoke(
        IPC.chaoxingCredentialsSave,
        input
      ) as Promise<ChaoxingCredentialStatus>,
    clearCredentials: () =>
      ipcRenderer.invoke(IPC.chaoxingCredentialsClear) as Promise<ChaoxingCredentialStatus>,
    fillCredentials: () => ipcRenderer.invoke(IPC.chaoxingCredentialsFill) as Promise<boolean>
  },
  portal: {
    open: (entryId: string) => ipcRenderer.invoke(IPC.portalOpen, entryId) as Promise<void>,
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
    openDataDirectory: () => ipcRenderer.invoke(IPC.appOpenDataDirectory) as Promise<void>,
    openExternal: (url: string) => ipcRenderer.invoke(IPC.appOpenExternal, url) as Promise<void>
  }
}

contextBridge.exposeInMainWorld('studynext', api)
