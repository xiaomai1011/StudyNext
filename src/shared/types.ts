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
  schedule: CourseSession[]
  source: DataSource
  sourceUrl: string | null
  createdAt: string
  updatedAt: string
}

export type StudyPointKind = 'video' | 'reading' | 'quiz' | 'discussion' | 'assignment' | 'other'

export interface Chapter {
  id: string
  courseId: string
  externalId: string | null
  title: string
  sortOrder: number
  progress: number
  lastStudiedAt: string | null
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

export type QuestionSource = 'manual' | 'ai' | 'import'

export interface QuestionCard {
  id: string
  question: string
  answer: string
  explanation: string
  courseId: string | null
  tags: string[]
  source: QuestionSource
  createdAt: string
  updatedAt: string
}

export interface QuestionInput {
  question: string
  answer: string
  explanation: string
  courseId: string | null
  tags: string[]
}

export interface AiConfig {
  enabled: boolean
  baseUrl: string
  model: string
  hasApiKey: boolean
  keyStorageAvailable: boolean
}

export interface AiConfigInput {
  enabled: boolean
  baseUrl: string
  model: string
  apiKey?: string | undefined
  clearApiKey?: boolean | undefined
}

export interface AiAskInput {
  question: string
  courseId: string | null
}

export interface AiAnswer {
  answer: string
  model: string
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
}

export interface AppNotice {
  id: string
  title: string
  body: string
  category: 'course' | 'system' | 'notice'
  publishedAt: string
  isDemo: true
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
}

export interface BootstrapData {
  courses: Course[]
  chapters: Chapter[]
  studyPoints: StudyPoint[]
  questions: QuestionCard[]
  tasks: Task[]
  settings: AppSettings
  notices: AppNotice[]
  syncStatus: SyncStatus
  officialEntries: OfficialEntry[]
  appInfo: AppInfo
  reminderRuntime: {
    mode: 'process_running'
    note: string
    systemNotificationsSupported: boolean
    startupCatchUpCount: number
    nextReminderAt: string | null
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
  | 'questions'
  | 'calendar'
  | 'portal'
  | 'settings'

export interface StudyNextApi {
  bootstrap: () => Promise<BootstrapData>
  tasks: {
    create: (input: TaskUpsertInput) => Promise<Task>
    update: (id: string, input: TaskUpsertInput) => Promise<Task>
    remove: (id: string) => Promise<void>
    setCompleted: (id: string, completed: boolean) => Promise<Task>
    history: (id: string) => Promise<TaskChange[]>
  }
  courses: {
    setFavorite: (id: string, favorite: boolean) => Promise<Course>
  }
  study: {
    setPointCompleted: (id: string, completed: boolean) => Promise<ToggleStudyPointResult>
  }
  questions: {
    create: (input: QuestionInput, source?: QuestionSource) => Promise<QuestionCard>
    update: (id: string, input: QuestionInput) => Promise<QuestionCard>
    remove: (id: string) => Promise<void>
  }
  ai: {
    getConfig: () => Promise<AiConfig>
    updateConfig: (input: AiConfigInput) => Promise<AiConfig>
    ask: (input: AiAskInput) => Promise<AiAnswer>
  }
  settings: {
    update: (patch: Partial<AppSettings>) => Promise<AppSettings>
    testNotification: () => Promise<void>
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
    run: () => Promise<SyncStatus>
  }
  portal: {
    open: (entryId: string) => Promise<void>
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
    openDataDirectory: () => Promise<void>
    openExternal: (url: string) => Promise<void>
  }
}
