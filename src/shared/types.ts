export type ThemeMode = 'system' | 'light' | 'dark'
export type TaskPriority = 'high' | 'medium' | 'low'
export type TaskKind = 'homework' | 'exam' | 'reading' | 'activity' | 'other'
export type TaskStatus = 'todo' | 'done'
export type TaskCompletionSource = 'local' | 'platform'
export type TaskField =
  | 'title'
  | 'description'
  | 'courseId'
  | 'priority'
  | 'kind'
  | 'status'
  | 'dueAt'
  | 'reminders'
export type DataSource = 'demo' | 'manual' | 'import' | 'chaoxing'
export type SyncState = 'not_configured' | 'syncing' | 'success' | 'partial' | 'failure'

export type SyncOperationKind =
  | 'manual_sync'
  | 'auto_sync'
  | 'retry_course'
  | 'submit_verify'
  | 'auth_check'
  | 'auto_login'

export type SyncOperationState =
  | 'success'
  | 'partial'
  | 'cached'
  | 'not_configured'
  | 'failure'
  | 'cancelled'
  | 'too_late'
  | 'busy'

export type SyncOperationStage = 'auth' | 'pull' | 'persist' | 'done'
export type ChaoxingAuthState = 'unknown' | 'logged_out' | 'authenticated' | 'expired'
export type ChaoxingTransport = 'session_fetch' | 'net_request' | 'none'
/**
 * 平台作业状态。与本地完成状态分离：
 * - not_submitted 未提交
 * - submitted 已提交（等待批阅）
 * - pending_review 待审核
 * - reviewed 已批阅/已评分
 * - done 已完成/已通过
 * - unknown 平台未给出可识别状态
 */
export type PlatformStatusKind =
  | 'not_submitted'
  | 'submitted'
  | 'pending_review'
  | 'reviewed'
  | 'done'
  | 'unknown'

export interface ChaoxingSavedAccount {
  id: string
  username: string
  displayName: string | null
  school: string | null
  /** 可靠绑定后的学习通平台 UID；null 表示尚未完成身份校验。 */
  platformUid: string | null
  lastUsedAt: string | null
}

export interface ChaoxingCredentialStatus {
  saved: boolean
  username: string | null
  encryptionAvailable: boolean
  accounts: ChaoxingSavedAccount[]
  activeAccountId: string | null
}

export interface PortalAutoLoginResult {
  ok: boolean
  message: string
  needsManual: boolean
}

export interface ChaoxingAvatarUpdatedEvent {
  uid: string
  generation: number
  requestId: number
  avatarUrl: string
}

export interface ChaoxingSessionStatus {
  authState: ChaoxingAuthState
  connection: 'web_session'
  message: string
  displayName: string | null
  school: string | null
  studentId?: string | null
  avatarUrl?: string | null
  checkedAt: string | null
  lastSyncAt: string | null
  lastCompleteSyncAt?: string | null
  lastAttemptAt: string | null
  lastOutcome?:
    | 'success'
    | 'partial'
    | 'failure'
    | 'not_configured'
    | 'cancelled'
    | 'too_late'
    | null
  lastOutcomeMessage?: string | null
  lastOutcomeDetail?: string | null
  lastOutcomeAt?: string | null
  lastCourseRetryOutcome?: 'success' | 'partial' | 'failure' | 'cancelled' | null
  lastCourseRetryObservedTaskExternalIds?: string[] | null
  lastRunCached?: boolean | null
  lastRunStage?: 'auth' | 'pull' | 'persist' | 'done' | null
  lastOperationId?: string | null
  lastOperationKind?: SyncOperationKind | null
  lastOperationState?: SyncOperationState | null
  lastRunCommitted?: boolean | null
  /** 用户主动清除会话后为 true，直到本人重新登录；后台调度不得自动恢复连接。 */
  userDisconnected?: boolean
  syncedCourses: number
  syncedTasks: number
  syncedChapters: number
  syncedExams: number
  syncedNotices: number
  syncedMaterials: number
  transport: ChaoxingTransport
  httpStatus: number | null
  cookieDomainCount: number
  detail: string | null
}

export interface CourseSession {
  id: string
  weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7
  startTime: string
  endTime: string
  location: string
  weeks: string
}

export interface Course {
  id: string
  externalId: string | null
  name: string
  code: string
  teacher: string
  semester: string
  category: string
  color: string
  favorite: boolean
  clazzId?: string | null
  className?: string | null
  schedule: CourseSession[]
  semesterStart?: string | null
  maxWeek?: number
  source: DataSource
  sourceUrl: string | null
  createdAt: string
  updatedAt: string
}

export type StudyPointKind = 'video' | 'reading' | 'quiz' | 'discussion' | 'assignment' | 'other'

export interface ChapterResource {
  name: string
  size: string | null
  type: string | null
  url: string | null
  objectId: string | null
}

export interface ChapterSection {
  number: string
  title: string
  completed: boolean
  pendingCount: number
  locked: boolean
  chapterId?: string | null
  sourceUrl?: string | null
  resources: ChapterResource[]
}

export interface Chapter {
  id: string
  courseId: string
  externalId: string | null
  title: string
  sortOrder: number
  progress: number
  lastStudiedAt: string | null
  sourceUrl: string | null
  sections: ChapterSection[]
  source: DataSource
  createdAt: string
  updatedAt: string
}

export interface StudyPoint {
  id: string
  chapterId: string
  courseId: string
  externalId: string | null
  title: string
  kind: StudyPointKind
  status: TaskStatus
  durationMinutes: number | null
  sortOrder: number
  source: DataSource
  createdAt: string
  updatedAt: string
}

export interface ReminderRule {
  id: string
  taskId: string
  offsetMinutes: number
  enabled: boolean
  createdAt: string
}

export interface TaskChange {
  id: string
  taskId: string
  changedAt: string
  origin: DataSource | 'system'
  summary: string
  changes: Array<{ field: TaskField; from: string | null; to: string | null }>
}

export interface TaskAttachment {
  name: string
  size: string | null
  objectId: string | null
}

export interface Task {
  id: string
  title: string
  description: string
  courseId: string | null
  priority: TaskPriority
  kind: TaskKind
  status: TaskStatus
  dueAt: string
  completedAt: string | null
  completionSource: TaskCompletionSource | null
  source: DataSource
  externalId: string | null
  sourceUpdatedAt: string | null
  sourceUrl: string | null
  platformStatus: string | null
  platformStatusKind: PlatformStatusKind
  submittedAt: string | null
  score: string | null
  fullScore: string | null
  teacherFeedback: string | null
  attachments: TaskAttachment[]
  manualFields: TaskField[]
  fieldSources: Partial<Record<TaskField, DataSource>>
  createdAt: string
  updatedAt: string
  reminders: ReminderRule[]
}

export interface TaskUpsertInput {
  title: string
  description: string
  courseId: string | null
  priority: TaskPriority
  kind: TaskKind
  dueAt: string
  reminderOffsets: number[]
  status?: TaskStatus
  sourceUrl?: string | null
}

export interface AppSettings {
  theme: ThemeMode
  closeToTray: boolean
  launchAtLogin: boolean
  notificationsEnabled: boolean
  defaultReminderOffsets: number[]
  calendarWeekStartsOn: 0 | 1
  catchUpMissedReminders: boolean
  trustedSsoDomains: string[]
  /** 空字符串表示使用系统下载目录下的 StudyNext 文件夹。 */
  downloadDirectory: string
  /** 自动刷新间隔（分钟）；0 表示关闭。 */
  autoRefreshMinutes: number
  /** 界面缩放比例（0.75–1.35，默认 1）。 */
  uiZoom: number
}

export interface AppNotice {
  id: string
  title: string
  body: string
  category: 'course' | 'system' | 'notice'
  publishedAt: string
  isDemo: boolean
  source?: DataSource
  sender?: string | null
  courseName?: string | null
  read?: boolean | null
  url?: string | null
}

export interface Exam {
  id: string
  externalId: string
  title: string
  courseName: string | null
  startAt: string | null
  endAt: string | null
  durationMinutes: number | null
  examStatus: string
  answerStatus: string
  score: string | null
  mode: string | null
  sourceUrl: string | null
  source: DataSource
  updatedAt: string
}

export interface SyncProgressEvent {
  opId?: string
  phase:
    | 'start'
    | 'courses'
    | 'homework'
    | 'schedule'
    | 'exams'
    | 'chapters'
    | 'notices'
    | 'materials'
    | 'done'
    | 'failed'
  message: string
  current: number
  total: number
}

export interface Material {
  id: string
  courseId: string
  externalId: string
  name: string
  kind: 'folder' | 'file' | 'link'
  fileType: string | null
  size: string | null
  url: string | null
  sourceUrl: string | null
  source: DataSource
  updatedAt: string
}

export interface SnapshotInfo {
  importedAt: string
  fileName: string
  courses: number
  chapters: number
  points: number
  tasks: number
}

export interface SyncStatus {
  state: SyncState
  message: string
  source: DataSource | null
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  detail: string | null
  snapshot: SnapshotInfo | null
  cached?: boolean
  operationId?: string | null
  operationKind?: SyncOperationKind | null
  operationState?: SyncOperationState | null
  stage?: SyncOperationStage | null
  committed?: boolean | null
}

/**
 * Structured result returned by every sync operation entry point. The legacy
 * status fields remain available for compatibility, but renderers must use this
 * operation envelope for ownership, progress and final-state decisions.
 */
export interface SyncOperationResult {
  operationId: string
  kind: SyncOperationKind
  state: SyncOperationState
  stage: SyncOperationStage
  committed: boolean
  cached: boolean
  message: string
  detail: string | null
  startedAt: string
  finishedAt: string | null
  status: SyncStatus | null
  session: ChaoxingSessionStatus | null
}

export interface OfficialEntry {
  id: string
  label: string
  description: string
  url: string
  kind: 'home' | 'course' | 'task' | 'exam' | 'notice' | 'calendar' | 'custom'
  enabled: boolean
  sortOrder: number
  isBuiltin: boolean
}

export interface OfficialEntryInput {
  label: string
  description: string
  url: string
  kind: OfficialEntry['kind']
}

export interface AppInfo {
  version: string
  platform: string
  dataPath: string
  isPackaged: boolean
  workspace: {
    id: string
    mode: 'account' | 'local' | 'readonly'
    accountId: string | null
  }
}

export interface SystemReminderStatus {
  supported: boolean
  taskName: string | null
  registered: boolean
  executablePath: string | null
  nextRunAt: string | null
  lastCheckAt: string | null
  lastDeliveryAt: string | null
  lastDeliveryError: string | null
  lastScheduleError: string | null
  lastError: string | null
  needsReregister: boolean
}

export interface BootstrapData {
  courses: Course[]
  chapters: Chapter[]
  studyPoints: StudyPoint[]
  tasks: Task[]
  exams: Exam[]
  materials: Material[]
  settings: AppSettings
  notices: AppNotice[]
  syncStatus: SyncStatus
  chaoxing: ChaoxingSessionStatus
  officialEntries: OfficialEntry[]
  appInfo: AppInfo
  reminderRuntime: {
    mode: 'process_running' | 'system_task'
    note: string
    systemNotificationsSupported: boolean
    startupCatchUpCount: number
    nextReminderAt: string | null
    system: SystemReminderStatus
  }
}

export interface ImportResult {
  state: 'success' | 'partial' | 'failure'
  importedCourses: number
  importedTasks: number
  skipped: number
  warnings: string[]
  message: string
}

export interface SnapshotImportResult {
  state: 'success' | 'partial' | 'failure'
  importedCourses: number
  updatedCourses: number
  importedChapters: number
  importedPoints: number
  importedTasks: number
  updatedTasks: number
  deadlineChanges: number
  conflicts: number
  skipped: number
  warnings: string[]
  message: string
  snapshot: SnapshotInfo | null
}

export interface ToggleStudyPointResult {
  point: StudyPoint
  chapter: Chapter
}

export interface ReminderFiredEvent {
  taskId: string
  taskTitle: string
  courseName?: string | null
  dueAt: string
  offsetMinutes: number
  firedAt: string
}

export type PortalLoadState = 'idle' | 'loading' | 'ready' | 'blocked' | 'error'
export type PortalLoginState = 'unknown' | 'logged_out' | 'logged_in'

export interface PortalNavigationEvent {
  id: string
  at: string
  action: 'navigate' | 'redirect' | 'blocked' | 'open'
  url: string
  displayUrl: string
  allowed: boolean
  reason: string | null
}

export interface PortalState {
  entryId: string | null
  url: string
  displayUrl: string
  title: string
  state: PortalLoadState
  canGoBack: boolean
  canGoForward: boolean
  loggedIn: boolean | null
  loginState: PortalLoginState
  navigationLog: PortalNavigationEvent[]
  error: string | null
}

export interface PortalDownload {
  id: string
  filename: string
  url: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  receivedBytes: number
  totalBytes: number
  startedAt: string
  completedAt: string | null
  savePath?: string
  materialId?: string | null
  attachmentTaskId?: string | null
  attachmentObjectId?: string | null
  attachmentFileName?: string | null
  attachmentIndex?: number | null
}

export interface MaterialLocalFile {
  materialId: string
  courseId: string
  downloadId: string | null
  filename: string
  savePath: string
  fileSize: number
  downloadedAt: string
}

export type BatchRetrySkipReason =
  | 'already_local'
  | 'in_progress'
  | 'duplicate_source'
  | 'out_of_scope'
  | 'already_recovered'

export interface BatchRetryResult {
  startedDownloadIds: string[]
  startedMaterialIds: string[]
  startedItems: Array<{
    downloadId: string
    materialId: string | null
    filename: string
  }>
  skipped: Array<{ id: string; reason: BatchRetrySkipReason }>
  failed: Array<{ id: string; filename: string; materialId: string | null; error: string }>
}

export interface PortalSubmitEvent {
  url: string
  platformCourseId: string | null
  platformClazzId?: string | null
  platformWorkId?: string | null
  detectedAt: string
}

export interface PortalUploadEvent {
  state: 'started' | 'completed' | 'failed'
  url: string
  statusCode: number | null
  message: string
  detectedAt: string
}

export interface PortalSecurityState {
  sandbox: boolean
  contextIsolation: boolean
  nodeIntegration: boolean
  hasPreload: boolean
  partition: string
}

export interface PortalOpenRequest {
  entryId: string
}

export interface WindowStateEvent {
  maximized: boolean
}

export type NavigateTarget =
  | 'dashboard'
  | 'study'
  | 'courses'
  | 'tasks'
  | 'exams'
  | 'materials'
  | 'records'
  | 'notices'
  | 'calendar'
  | 'settings'

export interface StudyNextApi {
  bootstrap: () => Promise<BootstrapData>
  tasks: {
    create: (input: TaskUpsertInput) => Promise<Task>
    update: (id: string, input: TaskUpsertInput) => Promise<Task>
    remove: (id: string) => Promise<void>
    setCompleted: (id: string, completed: boolean) => Promise<Task>
    history: (id: string) => Promise<TaskChange[]>
    downloadAttachment: (taskId: string, attachmentIndex: number) => Promise<void>
  }
  courses: {
    setFavorite: (id: string, favorite: boolean) => Promise<Course>
  }
  materials: {
    download: (id: string) => Promise<PortalDownload>
    localFiles: () => Promise<MaterialLocalFile[]>
    openLocal: (materialId: string) => Promise<void>
    revealLocal: (materialId: string) => Promise<void>
    onLocalFilesChanged: (callback: (files: MaterialLocalFile[]) => void) => () => void
  }
  study: {
    setPointCompleted: (id: string, completed: boolean) => Promise<ToggleStudyPointResult>
  }
  settings: {
    update: (patch: Partial<AppSettings>) => Promise<AppSettings>
    testNotification: () => Promise<void>
  }
  notifications: {
    systemStatus: () => Promise<SystemReminderStatus>
    repairSystemTask: () => Promise<SystemReminderStatus>
  }
  demo: {
    reset: () => Promise<void>
  }
  imports: {
    csvIcs: (payload: { fileName: string; content: string }) => Promise<ImportResult>
    snapshot: (payload: { fileName: string; content: string }) => Promise<SnapshotImportResult>
  }
  sync: {
    status: () => Promise<SyncStatus>
    run: (operationId?: string) => Promise<SyncStatus>
  }
  chaoxing: {
    status: () => Promise<ChaoxingSessionStatus>
    check: (operationId?: string) => Promise<ChaoxingSessionStatus>
    sync: (force?: boolean, operationId?: string) => Promise<ChaoxingSessionStatus>
    retryCourse: (courseId: string, operationId?: string) => Promise<ChaoxingSessionStatus>
    cancel: (operationId?: string) => Promise<ChaoxingSessionStatus>
    onSyncProgress: (callback: (event: SyncProgressEvent) => void) => () => void
    onAvatarUpdated: (callback: (event: ChaoxingAvatarUpdatedEvent) => void) => () => void
    credentialsStatus: () => Promise<ChaoxingCredentialStatus>
    saveCredentials: (input: {
      username: string
      password: string
    }) => Promise<ChaoxingCredentialStatus>
    clearCredentials: () => Promise<ChaoxingCredentialStatus>
    fillCredentials: () => Promise<boolean>
    autoLogin: (
      accountId?: string,
      operationId?: string,
      automatic?: boolean
    ) => Promise<PortalAutoLoginResult>
    removeAccount: (id: string) => Promise<ChaoxingCredentialStatus>
    activateAccount: (id: string) => Promise<ChaoxingCredentialStatus>
    switchAccount: (id: string) => Promise<ChaoxingCredentialStatus>
  }
  portal: {
    open: (entryId: string) => Promise<void>
    openUrl: (url: string) => Promise<void>
    hide: () => Promise<void>
    close: () => Promise<void>
    state: () => Promise<PortalState>
    back: () => Promise<void>
    forward: () => Promise<void>
    reload: () => Promise<void>
    openInitialInBrowser: () => Promise<void>
    clearSession: () => Promise<void>
    clearNavigationLog: () => Promise<void>
    securityState: () => Promise<PortalSecurityState>
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>
    downloads: () => Promise<PortalDownload[]>
    download: (url: string) => Promise<void>
    openDownload: (id: string) => Promise<void>
    revealDownload: (id: string) => Promise<void>
    cancelDownload: (id: string) => Promise<void>
    retryDownload: (id: string) => Promise<PortalDownload | null>
    retryFailedDownloads: (options?: {
      courseId?: string | null
      downloadIds?: string[]
    }) => Promise<BatchRetryResult>
    deleteDownload: (id: string) => Promise<void>
    clearDownloads: () => Promise<void>
    downloadDirectory: () => Promise<string>
    chooseDownloadDirectory: () => Promise<string | null>
    onDownload: (callback: (item: PortalDownload) => void) => () => void
    onUpload: (callback: (event: PortalUploadEvent) => void) => () => void
    onSubmitDetected: (callback: (event: PortalSubmitEvent) => void) => () => void
    onState: (callback: (state: PortalState) => void) => () => void
  }
  entries: {
    create: (input: OfficialEntryInput) => Promise<OfficialEntry>
    updateEnabled: (id: string, enabled: boolean) => Promise<OfficialEntry>
    remove: (id: string) => Promise<void>
  }
  window: {
    minimize: () => void
    toggleMaximize: () => void
    close: () => void
    quit: () => void
    isMaximized: () => Promise<boolean>
    onMaximized: (callback: (event: WindowStateEvent) => void) => () => void
  }
  app: {
    onNavigate: (callback: (target: NavigateTarget) => void) => () => void
    onReminder: (callback: (event: ReminderFiredEvent) => void) => () => void
    onFocusTask: (callback: (taskId: string) => void) => () => void
    rendererReady: () => void
    openDataDirectory: () => Promise<void>
    openExternal: (url: string) => Promise<void>
  }
}
