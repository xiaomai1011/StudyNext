import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import {
  ArrowLeft,
  BellRing,
  BookOpen,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  Atom,
  LayoutDashboard,
  ListChecks,
  LogIn,
  Maximize2,
  Minimize2,
  Minus,
  Moon,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings as SettingsIcon,
  Sun,
  X,
  ZoomIn
} from 'lucide-react'
import type {
  AppNotice,
  AppSettings,
  BootstrapData,
  ChaoxingCredentialStatus,
  ChaoxingSessionStatus,
  Chapter,
  ChapterResource,
  Course,
  Material,
  MaterialLocalFile,
  NavigateTarget,
  PortalDownload,
  StudyPoint,
  SyncStatus,
  Task,
  TaskUpsertInput
} from '@shared/types'
import { UI_ZOOM_MAX, UI_ZOOM_MIN, UI_ZOOM_PRESETS, UI_ZOOM_STEP } from '@shared/constants'
import { getChapterOfficialUrl, getCourseOfficialUrl } from '@shared/course-context'
import { materialPreviewKind, materialTarget } from '@shared/materials'
import { normalizePortalTargetUrl } from '@shared/portal-url'
import {
  buildRecentOpenedTaskContext,
  resolveLastCompleteSyncAt,
  resolveTopbarSyncIndicator,
  type RecentOpenedTaskContext
} from '@shared/sync-feedback'
import {
  SyncController,
  type ManualSyncResult,
  type SyncCoordinatorSnapshot,
  type SyncRunResult
} from '@shared/sync-controller'
import { getTaskPortalAction, resolveTaskPortalOpenFeedback } from '@shared/task-state'
import { useSyncScheduler } from './hooks/useSyncScheduler'
import { Dashboard } from './pages/Dashboard'
import { CourseWorkspace, type CourseWorkspaceTab } from './pages/CourseWorkspace'
import { Tasks } from './pages/Tasks'
import { Notices } from './pages/Notices'
import { Portal } from './pages/Portal'
import { Settings } from './pages/Settings'
import { TaskEditor } from './components/TaskEditor'
import { TaskDetail } from './components/TaskDetail'
import { ConfirmDialog } from './components/ConfirmDialog'
import { LoginDialog } from './components/LoginDialog'
import { CommandPalette } from './components/CommandPalette'
import { hasOpenModal } from './components/modal-focus'
import { ToastStack, type ToastItem, type ToastKind } from './components/ToastStack'
import {
  errorMessage,
  formatDateTime,
  formatTime,
  relativeTime,
  reminderOffsetLabel
} from './lib/format'

type NavItem = { id: NavigateTarget; label: string; icon: typeof LayoutDashboard }

const PRIMARY_NAV: NavItem[] = [
  { id: 'dashboard', label: '今天', icon: LayoutDashboard },
  { id: 'courses', label: '课程', icon: BookOpen },
  { id: 'tasks', label: '作业', icon: ListChecks }
]

const ROUTE_TITLE: Record<NavigateTarget, string> = {
  dashboard: '今天',
  study: '课程',
  courses: '课程',
  tasks: '作业',
  exams: '作业',
  materials: '课程',
  records: '作业',
  notices: '通知',
  calendar: '今天',
  settings: '设置'
}

function SidebarAccountAvatar({
  src,
  name
}: {
  src: string | null | undefined
  name: string | null | undefined
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  if (src && !failed) {
    return (
      <img
        className="sidebar-avatar"
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    )
  }
  return <span className="sidebar-avatar fallback">{name?.trim().slice(0, 1) || '学'}</span>
}

export default function App(): JSX.Element {
  const [data, setData] = useState<BootstrapData | null>(null)
  const [loading, setLoading] = useState(true)
  const [fatal, setFatal] = useState<string | null>(null)
  const [route, setRoute] = useState<NavigateTarget>('dashboard')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [editor, setEditor] = useState<{
    task: Task | null
    defaultCourseId?: string | null
  } | null>(null)
  const [confirmTask, setConfirmTask] = useState<Task | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [autoSyncError, setAutoSyncError] = useState<string | null>(null)
  const [syncSnapshot, setSyncSnapshot] = useState<SyncCoordinatorSnapshot>({
    isSyncing: false,
    activeKind: null,
    progress: null,
    cancelling: false
  })
  const [maximized, setMaximized] = useState(false)
  const [portalLaunch, setPortalLaunch] = useState<string | null>(null)
  const [portalOverlayOpen, setPortalOverlayOpen] = useState(false)
  const [credentialStatus, setCredentialStatus] = useState<ChaoxingCredentialStatus | null>(null)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [accountBusy, setAccountBusy] = useState(false)
  const [loginDialogOpen, setLoginDialogOpen] = useState(false)
  const [loginAccountId, setLoginAccountId] = useState<string | null>(null)
  const [loginAccountLabel, setLoginAccountLabel] = useState<string | null>(null)
  const [quickUsername, setQuickUsername] = useState('')
  const [quickPassword, setQuickPassword] = useState('')
  const [showQuickPassword, setShowQuickPassword] = useState(false)
  const [quickSaving, setQuickSaving] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false)
  const [courseFocusId, setCourseFocusId] = useState<string | null>(null)
  const [courseFocusTab, setCourseFocusTab] = useState<CourseWorkspaceTab | null>(null)
  const [materialFocusCourseId, setMaterialFocusCourseId] = useState<string | null>(null)
  const [materialDownloadsOpen, setMaterialDownloadsOpen] = useState(false)
  const [downloads, setDownloads] = useState<PortalDownload[]>([])
  const [materialLocalFiles, setMaterialLocalFiles] = useState<MaterialLocalFile[]>([])
  const [taskFocusCourseId, setTaskFocusCourseId] = useState<string | null>(null)
  const [studyCourseId, setStudyCourseId] = useState<string | null>(null)
  const [studyFocusCourseId, setStudyFocusCourseId] = useState<string | null>(null)
  const [studyFocusChapterId, setStudyFocusChapterId] = useState<string | null>(null)
  const [noticeFocusCourseName, setNoticeFocusCourseName] = useState<string | null>(null)
  const [canGoBack, setCanGoBack] = useState(false)
  const routeHistoryRef = useRef<NavigateTarget[]>([])
  const mainScrollRef = useRef<HTMLDivElement | null>(null)
  const scrollPositionsRef = useRef<Partial<Record<NavigateTarget, number>>>({})
  const courseReturnFocusRef = useRef<string | null>(null)
  const accountMenuRef = useRef<HTMLDivElement | null>(null)
  const zoomMenuRef = useRef<HTMLDivElement | null>(null)
  const toastSeq = useRef(0)
  const toastTimers = useRef<number[]>([])
  const dataRef = useRef<BootstrapData | null>(null)
  const routeRef = useRef<NavigateTarget>(route)
  const loginDialogOpenRef = useRef(loginDialogOpen)
  const syncSuspendUntilRef = useRef(0)
  const accountCheckRequestedRef = useRef(false)
  const startupAutoLoginAttemptedRef = useRef(false)
  const startupAutoLoginPendingRef = useRef(false)
  const pendingMissingFocusRef = useRef<string | null>(null)
  const verificationTimers = useRef<number[]>([])
  const lastOpenedTaskRef = useRef<RecentOpenedTaskContext | null>(null)
  const api = window.studynext

  useEffect(() => {
    dataRef.current = data
  }, [data])

  useEffect(() => {
    routeRef.current = route
    setAccountMenuOpen(false)
    const frame = window.requestAnimationFrame(() => {
      if (!mainScrollRef.current) return
      mainScrollRef.current.scrollTop = scrollPositionsRef.current[route] ?? 0
    })
    return () => window.cancelAnimationFrame(frame)
  }, [route])

  useEffect(() => {
    loginDialogOpenRef.current = loginDialogOpen
  }, [loginDialogOpen])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen((open) => !open)
        return
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        const target = event.target as HTMLElement | null
        const inEditable =
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          Boolean(target?.isContentEditable)
        if (!inEditable && !hasOpenModal()) {
          if (event.key === '1') {
            event.preventDefault()
            navigate('dashboard')
            return
          }
          if (event.key === '2') {
            event.preventDefault()
            navigate('courses')
            return
          }
          if (event.key === '3') {
            event.preventDefault()
            navigate('tasks')
            return
          }
          if (event.key.toLowerCase() === 'n') {
            event.preventDefault()
            setEditor({ task: null })
            return
          }
        }
        const currentZoom = dataRef.current?.settings.uiZoom ?? 1
        if (event.key === '=' || event.key === '+') {
          event.preventDefault()
          const next = Math.min(UI_ZOOM_MAX, Math.round((currentZoom + UI_ZOOM_STEP) * 100) / 100)
          if (Math.abs(next - currentZoom) > 0.001) {
            void api.settings
              .update({ uiZoom: next })
              .then((updated) => {
                setData((current) => (current ? { ...current, settings: updated } : current))
              })
              .catch(() => undefined)
          }
        } else if (event.key === '-') {
          event.preventDefault()
          const next = Math.max(UI_ZOOM_MIN, Math.round((currentZoom - UI_ZOOM_STEP) * 100) / 100)
          if (Math.abs(next - currentZoom) > 0.001) {
            void api.settings
              .update({ uiZoom: next })
              .then((updated) => {
                setData((current) => (current ? { ...current, settings: updated } : current))
              })
              .catch(() => undefined)
          }
        } else if (event.key === '0') {
          event.preventDefault()
          if (Math.abs(currentZoom - 1) > 0.001) {
            void api.settings
              .update({ uiZoom: 1 })
              .then((updated) => {
                setData((current) => (current ? { ...current, settings: updated } : current))
              })
              .catch(() => undefined)
          }
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [api])

  const refreshCredentialStatus = useCallback(async (): Promise<void> => {
    try {
      setCredentialStatus(await api.chaoxing.credentialsStatus())
    } catch {
      // The account card is optional; a read failure must not block the app.
    }
  }, [api])

  useEffect(() => {
    void refreshCredentialStatus()
  }, [refreshCredentialStatus])

  const applyMaterialLocalFiles = useCallback((files: MaterialLocalFile[]): void => {
    setMaterialLocalFiles((previous) => {
      if (
        previous.length === files.length &&
        previous.every((item, index) => {
          const next = files[index]
          return (
            next &&
            item.materialId === next.materialId &&
            item.courseId === next.courseId &&
            item.downloadId === next.downloadId &&
            item.savePath === next.savePath &&
            item.fileSize === next.fileSize &&
            item.downloadedAt === next.downloadedAt
          )
        })
      ) {
        return previous
      }
      return files
    })
  }, [])

  const refreshMaterialLocalFiles = useCallback((): void => {
    void api.materials
      .localFiles()
      .then((files) => {
        applyMaterialLocalFiles(files)
      })
      .catch(() => {
        // 本地资料索引是辅助信息，不应阻塞主流程。
      })
  }, [api, applyMaterialLocalFiles])

  const recordTrackedDownload = useCallback((item: PortalDownload): void => {
    setDownloads((previous) => [item, ...previous.filter((entry) => entry.id !== item.id)])
  }, [])

  useEffect(() => {
    let alive = true
    void api.portal
      .downloads()
      .then((items) => {
        if (alive) setDownloads(items)
      })
      .catch(() => {
        // 下载记录是辅助信息，不应阻塞应用启动。
      })
    void api.materials
      .localFiles()
      .then((files) => {
        if (alive) applyMaterialLocalFiles(files)
      })
      .catch(() => undefined)
    const unsubscribe = api.portal.onDownload((item) => {
      if (alive) recordTrackedDownload(item)
    })
    const unsubscribeLocalFiles = api.materials.onLocalFilesChanged((files) => {
      if (alive) applyMaterialLocalFiles(files)
    })
    const handleWindowFocus = (): void => {
      if (!alive) return
      void api.materials
        .localFiles()
        .then((files) => {
          if (alive) applyMaterialLocalFiles(files)
        })
        .catch(() => undefined)
    }
    window.addEventListener('focus', handleWindowFocus)
    return () => {
      alive = false
      unsubscribe()
      unsubscribeLocalFiles()
      window.removeEventListener('focus', handleWindowFocus)
    }
  }, [api, applyMaterialLocalFiles, recordTrackedDownload])

  useEffect(() => {
    if (startupAutoLoginAttemptedRef.current) return
    if (!data || !credentialStatus?.saved) return
    if (data.chaoxing.userDisconnected) return
    if (data.chaoxing.authState !== 'logged_out' && data.chaoxing.authState !== 'expired') return
    if (loginDialogOpen || accountBusy) return
    startupAutoLoginAttemptedRef.current = true
    startupAutoLoginPendingRef.current = true
    let alive = true
    void (async () => {
      try {
        const result = await api.chaoxing.autoLogin(undefined, undefined, true)
        if (!alive || !result.ok) return
        const next = await api.chaoxing.check()
        if (alive) {
          setAutoSyncError(null)
          setData((previous) => (previous ? { ...previous, chaoxing: next } : previous))
        }
      } catch {
        // A saved account can still be used from the account menu if silent login fails.
      } finally {
        startupAutoLoginPendingRef.current = false
      }
    })()
    return () => {
      alive = false
    }
  }, [api, accountBusy, credentialStatus?.saved, data, loginDialogOpen])

  useEffect(() => {
    if (!accountMenuOpen) {
      setQuickUsername('')
      setQuickPassword('')
      setShowQuickPassword(false)
    }
  }, [accountMenuOpen])

  useEffect(() => {
    if (!accountMenuOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(event.target as Node)) {
        setAccountMenuOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || hasOpenModal() || commandOpen) return
      event.preventDefault()
      event.stopPropagation()
      setAccountMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [accountMenuOpen, commandOpen])

  useEffect(() => {
    if (!zoomMenuOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      if (zoomMenuRef.current && !zoomMenuRef.current.contains(event.target as Node)) {
        setZoomMenuOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || hasOpenModal() || commandOpen) return
      event.preventDefault()
      event.stopPropagation()
      setZoomMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [zoomMenuOpen, commandOpen])

  useEffect(() => {
    if (
      !data ||
      data.chaoxing.authState !== 'authenticated' ||
      data.chaoxing.studentId ||
      accountCheckRequestedRef.current
    ) {
      return
    }
    accountCheckRequestedRef.current = true
    let alive = true
    void api.chaoxing
      .check()
      .then((next) => {
        if (alive) setData((previous) => (previous ? { ...previous, chaoxing: next } : previous))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [api, data])

  const dismissToast = useCallback((id: number): void => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const notify = useCallback((kind: ToastKind, message: string): void => {
    const id = ++toastSeq.current
    setToasts((current) => [...current.slice(-3), { id, kind, message }])
    const timer = window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id))
    }, 5000)
    toastTimers.current.push(timer)
  }, [])

  const handleSaveQuickAccount = useCallback(async (): Promise<void> => {
    if (quickSaving) return
    if (!quickUsername.trim() || !quickPassword) {
      notify('error', '请输入学习通账号和密码')
      return
    }
    setQuickSaving(true)
    try {
      const status = await api.chaoxing.saveCredentials({
        username: quickUsername.trim(),
        password: quickPassword
      })
      setCredentialStatus(status)
      setQuickUsername('')
      setQuickPassword('')
      const saved = status.accounts.find(
        (account) => account.username.toLowerCase() === quickUsername.trim().toLowerCase()
      )
      if (saved) {
        setLoginAccountId(saved.id)
        setLoginAccountLabel(saved.displayName || saved.username)
        setAccountMenuOpen(false)
        setLoginDialogOpen(true)
      }
      notify('success', '账号已保存，正在尝试自动登录')
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setQuickSaving(false)
    }
  }, [api, notify, quickPassword, quickSaving, quickUsername])

  useEffect(() => {
    const timers = toastTimers.current
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
      for (const timer of verificationTimers.current) window.clearTimeout(timer)
    }
  }, [])

  const refreshBootstrap = useCallback(async (): Promise<BootstrapData> => {
    const next = await api.bootstrap()
    setData(next)
    return next
  }, [api])

  const handleSessionCleared = useCallback(async (): Promise<void> => {
    // 主动清会话后立即阻断自动调度，避免在 bootstrap 返回前又用旧身份拉起操作。
    syncSuspendUntilRef.current = Date.now() + 60_000
    await refreshBootstrap()
  }, [refreshBootstrap])

  const portalOverlayOpenRef = useRef(portalOverlayOpen)
  useEffect(() => {
    portalOverlayOpenRef.current = portalOverlayOpen
  }, [portalOverlayOpen])

  const syncControllerRef = useRef<SyncController | null>(null)
  if (!syncControllerRef.current) {
    syncControllerRef.current = new SyncController({
      api: {
        check: (operationId?: string) => api.chaoxing.check(operationId),
        autoLogin: (accountId?: string, operationId?: string, automatic?: boolean) =>
          api.chaoxing.autoLogin(accountId, operationId, automatic),
        sync: (force?: boolean, operationId?: string) => api.chaoxing.sync(force, operationId),
        retryCourse: (courseId: string, operationId?: string) =>
          api.chaoxing.retryCourse(courseId, operationId),
        cancel: (operationId?: string) => api.chaoxing.cancel(operationId)
      },
      getData: () => dataRef.current,
      setChaoxingStatus: (status) => {
        setData((previous) => (previous ? { ...previous, chaoxing: status } : previous))
      },
      refreshBootstrap,
      setAutoSyncError,
      notify,
      errorMessage,
      canRunAutoSync: () => {
        const snapshot = dataRef.current
        return (
          Boolean(snapshot) &&
          !startupAutoLoginPendingRef.current &&
          !snapshot?.chaoxing.userDisconnected &&
          snapshot?.chaoxing.authState === 'authenticated' &&
          !portalOverlayOpenRef.current &&
          !loginDialogOpenRef.current &&
          document.visibilityState === 'visible' &&
          Date.now() >= syncSuspendUntilRef.current
        )
      },
      getRecentOpenedTask: () => lastOpenedTaskRef.current,
      delay: (ms: number) =>
        new Promise((resolve) => {
          const timer = window.setTimeout(resolve, ms)
          verificationTimers.current.push(timer)
        }),
      onStateChange: setSyncSnapshot
    })
  }

  useEffect(() => {
    return api.chaoxing.onSyncProgress((event) => {
      syncControllerRef.current?.handleProgressEvent(event)
    })
  }, [api])

  useEffect(() => {
    return api.chaoxing.onAvatarUpdated((event) => {
      setData((previous) => {
        if (!previous || previous.chaoxing.studentId !== event.uid) return previous
        return {
          ...previous,
          chaoxing: { ...previous.chaoxing, avatarUrl: event.avatarUrl }
        }
      })
    })
  }, [api])

  const runAutoSync = useCallback(
    (reason: 'startup' | 'interval' | 'resume'): Promise<boolean> =>
      syncControllerRef.current!.runAutoSync(reason),
    []
  )

  useSyncScheduler({
    enabled: Boolean(data) && (data?.settings.autoRefreshMinutes ?? 0) > 0,
    intervalMinutes: data?.settings.autoRefreshMinutes ?? 0,
    getLastSyncAt: () => dataRef.current?.chaoxing.lastSyncAt ?? null,
    canRun: () => {
      const snapshot = dataRef.current
      return (
        Boolean(snapshot) &&
        !startupAutoLoginPendingRef.current &&
        !snapshot?.chaoxing.userDisconnected &&
        snapshot?.chaoxing.authState === 'authenticated' &&
        !portalOverlayOpen &&
        !loginDialogOpenRef.current &&
        document.visibilityState === 'visible' &&
        !(syncControllerRef.current?.isBusy() ?? false) &&
        Date.now() >= syncSuspendUntilRef.current
      )
    },
    run: runAutoSync
  })

  useEffect(() => {
    let alive = true
    void api
      .bootstrap()
      .then((next) => {
        if (!alive) return
        setData(next)
        setLoading(false)
      })
      .catch((error: unknown) => {
        if (!alive) return
        setFatal(errorMessage(error))
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [api])

  useEffect(() => {
    const unsubNavigate = api.app.onNavigate((target) => {
      setRoute(target)
      setPortalLaunch(null)
    })
    const unsubReminder = api.app.onReminder((event) => {
      notify('info', `DDL 提醒：${event.taskTitle}（${reminderOffsetLabel(event.offsetMinutes)}）`)
    })
    const unsubFocus = api.app.onFocusTask((taskId) => {
      setRoute('tasks')
      setSelectedTaskId(taskId)
      pendingMissingFocusRef.current = taskId
    })
    const unsubMaximized = api.window.onMaximized((event) => setMaximized(event.maximized))
    void api.window
      .isMaximized()
      .then(setMaximized)
      .catch(() => undefined)
    // Tell main the listeners are live. A notification can arrive before
    // React has mounted its subscriptions; main keeps the task ID pending
    // until this handshake instead of sending it into the void.
    api.app.rendererReady()
    return () => {
      unsubNavigate()
      unsubReminder()
      unsubFocus()
      unsubMaximized()
    }
  }, [api, notify])

  useEffect(() => {
    const taskId = pendingMissingFocusRef.current
    if (!taskId || !data) return
    if (data.tasks.some((task) => task.id === taskId)) {
      pendingMissingFocusRef.current = null
      return
    }
    pendingMissingFocusRef.current = null
    setSelectedTaskId(null)
    notify('info', '这条提醒对应的任务已删除或不存在')
  }, [data, selectedTaskId, notify])

  useEffect(() => {
    return api.portal.onSubmitDetected((event) => {
      void syncControllerRef.current?.handleSubmitDetected(event)
    })
  }, [api])

  const theme = data?.settings.theme
  useEffect(() => {
    if (!theme) return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme
      document.documentElement.dataset.theme = resolved
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  useEffect(() => {
    if (!selectedTaskId || !data) return
    if (!data.tasks.some((task) => task.id === selectedTaskId)) setSelectedTaskId(null)
  }, [data, selectedTaskId])

  const selectedTask = selectedTaskId
    ? (data?.tasks.find((task) => task.id === selectedTaskId) ?? null)
    : null
  const selectedCourse = selectedTask?.courseId
    ? (data?.courses.find((course) => course.id === selectedTask.courseId) ?? null)
    : null

  const openCount =
    data?.tasks.filter(
      (task) =>
        task.status === 'todo' &&
        task.platformStatusKind !== 'pending_review' &&
        task.platformStatusKind !== 'submitted' &&
        task.platformStatusKind !== 'reviewed' &&
        task.platformStatusKind !== 'done'
    ).length ?? 0

  const accountAuthenticated = data?.chaoxing.authState === 'authenticated'
  const accountName = data?.chaoxing.displayName?.trim() || '学习通账号'
  const accountSchool = data?.chaoxing.school?.trim() || '未连接学习通'
  const accountId = data?.chaoxing.studentId?.trim() || null
  const hasSavedAccounts = (credentialStatus?.accounts.length ?? 0) > 0

  const closePortal = useCallback((): void => {
    if (!portalOverlayOpenRef.current) return
    setPortalOverlayOpen(false)
    setPortalLaunch(null)
    void api.portal.hide().catch(() => undefined)
  }, [api.portal])

  const navigate = useCallback(
    (target: NavigateTarget): void => {
      closePortal()
      const current = routeRef.current
      if (current && current !== target) {
        scrollPositionsRef.current[current] = mainScrollRef.current?.scrollTop ?? 0
        routeHistoryRef.current = [...routeHistoryRef.current.slice(-19), current]
        setCanGoBack(true)
      }
      routeRef.current = target
      setRoute(target)
      setPortalLaunch(null)
      if (target === 'courses') courseReturnFocusRef.current = null
    },
    [closePortal]
  )

  const goBack = useCallback((): void => {
    if (portalOverlayOpenRef.current) {
      closePortal()
      return
    }
    const previous = routeHistoryRef.current.pop()
    if (!previous) return
    scrollPositionsRef.current[routeRef.current] = mainScrollRef.current?.scrollTop ?? 0
    routeRef.current = previous
    setRoute(previous)
    setCanGoBack(routeHistoryRef.current.length > 0)
    setPortalLaunch(null)
    if (previous === 'courses' && courseReturnFocusRef.current) {
      setCourseFocusId(courseReturnFocusRef.current)
      courseReturnFocusRef.current = null
    }
  }, [closePortal])

  const openPortal = useCallback((entryId: string): void => {
    syncSuspendUntilRef.current = Date.now() + 60_000
    void syncControllerRef.current?.cancelForPortalOpen()
    setPortalLaunch(entryId)
    setPortalOverlayOpen(true)
  }, [])

  const handleOpenChaoxingHome = useCallback(async (): Promise<void> => {
    if (accountBusy) return
    setAccountBusy(true)
    setAccountMenuOpen(false)
    try {
      openPortal('entry-home')
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setAccountBusy(false)
    }
  }, [accountBusy, notify, openPortal])

  const handleStartLogin = useCallback(
    async (forceClear = false, accountId: string | null = null): Promise<void> => {
      if (accountBusy) return
      setAccountBusy(true)
      try {
        if (forceClear) await api.portal.clearSession()
        const account = accountId
          ? (credentialStatus?.accounts.find((item) => item.id === accountId) ?? null)
          : null
        setLoginAccountId(account?.id ?? null)
        setLoginAccountLabel(account ? account.displayName || account.username : null)
        setAccountMenuOpen(false)
        setLoginDialogOpen(true)
      } catch (error) {
        notify('error', errorMessage(error))
      } finally {
        setAccountBusy(false)
      }
    },
    [accountBusy, api, credentialStatus, notify]
  )

  const handleSwitchAccount = useCallback(
    async (accountId: string): Promise<void> => {
      if (accountBusy) return
      setAccountBusy(true)
      try {
        const status = await api.chaoxing.switchAccount(accountId)
        setCredentialStatus(status)
        const account = status.accounts.find((item) => item.id === accountId) ?? null
        setLoginAccountId(accountId)
        setLoginAccountLabel(account ? account.displayName || account.username : null)
        setAccountMenuOpen(false)
        await refreshBootstrap()
        setLoginDialogOpen(true)
        notify('info', '已切换学习通账号，请完成登录。')
      } catch (error) {
        notify('error', errorMessage(error))
      } finally {
        setAccountBusy(false)
      }
    },
    [accountBusy, api, notify, refreshBootstrap]
  )

  const handleLoginAuthenticated = useCallback(async (): Promise<void> => {
    setLoginDialogOpen(false)
    setLoginAccountId(null)
    setLoginAccountLabel(null)
    setAutoSyncError(null)
    try {
      const status = await api.chaoxing.check()
      setData((current) => (current ? { ...current, chaoxing: status } : current))
      await refreshBootstrap()
      notify('success', '学习通登录成功，账号信息已刷新。')
    } catch (error) {
      notify('error', errorMessage(error))
    }
  }, [api, notify, refreshBootstrap])

  const handleLaunchHandled = useCallback((): void => {
    setPortalLaunch(null)
  }, [])

  const handleToggleTask = async (task: Task): Promise<void> => {
    if (task.source === 'chaoxing') {
      notify('info', '学习通任务的完成状态由平台同步，本地不能直接勾选。')
      return
    }
    try {
      const updated = await api.tasks.setCompleted(task.id, task.status !== 'done')
      setData((current) =>
        current
          ? {
              ...current,
              tasks: current.tasks.map((item) => (item.id === updated.id ? updated : item))
            }
          : current
      )
      notify('success', updated.status === 'done' ? '任务已标记为完成' : '任务已恢复为待完成')
      void refreshBootstrap().catch(() => undefined)
    } catch (error) {
      notify('error', errorMessage(error))
    }
  }

  const handleSaveTask = async (input: TaskUpsertInput): Promise<void> => {
    if (!editor) return
    try {
      const saved = editor.task
        ? await api.tasks.update(editor.task.id, input)
        : await api.tasks.create(input)
      setData((current) =>
        current
          ? {
              ...current,
              tasks: editor.task
                ? current.tasks.map((task) => (task.id === saved.id ? saved : task))
                : [...current.tasks, saved]
            }
          : current
      )
      setEditor(null)
      notify('success', editor.task ? '任务修改已保存，提醒已重新调度' : '任务已创建')
      void refreshBootstrap().catch(() => undefined)
    } catch (error) {
      notify('error', errorMessage(error))
      throw error
    }
  }

  const requestDelete = (task: Task): void => {
    if (task.source === 'chaoxing') {
      notify('info', '平台任务不能本地删除；请在平台处理，或保留记录等待平台更新。')
      return
    }
    setSelectedTaskId(null)
    setConfirmTask(task)
  }

  const confirmDelete = async (): Promise<void> => {
    if (!confirmTask) return
    if (confirmTask.source === 'chaoxing') {
      setConfirmTask(null)
      notify('info', '平台任务不能本地删除。')
      return
    }
    setDeleting(true)
    try {
      await api.tasks.remove(confirmTask.id)
      setData((current) =>
        current
          ? { ...current, tasks: current.tasks.filter((task) => task.id !== confirmTask.id) }
          : current
      )
      notify('success', '任务已删除')
      setConfirmTask(null)
      void refreshBootstrap().catch(() => undefined)
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setDeleting(false)
    }
  }

  const handleToggleFavorite = async (courseId: string, current: boolean): Promise<void> => {
    try {
      const updated = await api.courses.setFavorite(courseId, !current)
      setData((state) =>
        state
          ? {
              ...state,
              courses: state.courses.map((course) => (course.id === updated.id ? updated : course))
            }
          : state
      )
      notify('success', updated.favorite ? '已收藏课程' : '已取消收藏')
    } catch (error) {
      notify('error', errorMessage(error))
    }
  }

  const handleTogglePoint = async (point: StudyPoint, completed: boolean): Promise<void> => {
    const result = await api.study.setPointCompleted(point.id, completed)
    setData((current) =>
      current
        ? {
            ...current,
            studyPoints: current.studyPoints.map((item) =>
              item.id === result.point.id ? result.point : item
            ),
            chapters: current.chapters.map((chapter) =>
              chapter.id === result.chapter.id ? result.chapter : chapter
            )
          }
        : current
    )
  }

  const handleSettingsUpdate = async (patch: Partial<AppSettings>): Promise<void> => {
    const next = await api.settings.update(patch)
    setData((current) => (current ? { ...current, settings: next } : current))
  }

  const handleResetDemo = async (): Promise<void> => {
    await api.demo.reset()
    await refreshBootstrap()
    setRoute('dashboard')
    setSelectedTaskId(null)
    setEditor(null)
  }

  const handleSyncRun = async (options?: { silent?: boolean }): Promise<SyncRunResult> => {
    return syncControllerRef.current!.runSyncRun(
      (operationId) => api.sync.run(operationId),
      options
    )
  }

  const handleChaoxingCheck = async (): Promise<ChaoxingSessionStatus> => {
    const next = await api.chaoxing.check()
    setData((current) => (current ? { ...current, chaoxing: next } : current))
    return next
  }

  const handleCancelSync = useCallback(async (): Promise<boolean> => {
    return (await syncControllerRef.current?.requestCancel()) ?? false
  }, [])

  const handleChaoxingSync = async (
    force = true,
    options?: { silent?: boolean }
  ): Promise<ManualSyncResult> => {
    return syncControllerRef.current!.runManualSync(force, options)
  }

  const handleChaoxingRetryCourse = async (course: Course): Promise<void> => {
    await syncControllerRef.current!.runCourseRetry(course)
  }

  const handleMaterialDownload = (material: Material): void => {
    notify('info', `正在发起下载 ${material.name}`)
    // 下载完成前 IPC 不会返回；保留在当前课程资料视图中并用行内进度与左侧下载角标反馈。
    void api.materials.download(material.id).catch((error: unknown) => {
      notify('error', errorMessage(error))
    })
  }

  const handleDownloadAction = async (
    label: string,
    action: () => Promise<void>
  ): Promise<void> => {
    try {
      await action()
      notify('success', label)
    } catch (error) {
      notify('error', errorMessage(error))
    }
  }

  const openPortalUrlWithFeedback = async (
    rawUrl: string,
    successMessage: string,
    loginMessage = '学习通登录状态已失效，已跳转至登录页；请先完成登录'
  ): Promise<void> => {
    const safeUrl = normalizePortalTargetUrl(rawUrl)
    if (!safeUrl) {
      notify('error', '该链接不属于学习通官方域名，无法在应用内打开')
      return
    }
    try {
      syncSuspendUntilRef.current = Date.now() + 60_000
      await syncControllerRef.current?.cancelForPortalOpen()
      setPortalLaunch(null)
      setPortalOverlayOpen(true)
      await new Promise((resolve) => setTimeout(resolve, 300))
      await api.portal.openUrl(safeUrl)
      const state = await api.portal.state()
      const feedback = resolveTaskPortalOpenFeedback('course', state)
      if (feedback.status === 'error') {
        throw new Error(feedback.message)
      }
      notify('info', feedback.status === 'login_required' ? loginMessage : successMessage)
    } catch (error) {
      setPortalOverlayOpen(false)
      void api.portal.hide().catch(() => undefined)
      notify('error', errorMessage(error))
    }
  }

  const handlePreviewMaterial = async (material: Material): Promise<void> => {
    const target = materialTarget(material)
    if (!target) {
      notify('info', '该资料没有可预览的地址，请从官方页面打开。')
      return
    }
    const previewKind = materialPreviewKind(material)
    if (previewKind === 'external' && !normalizePortalTargetUrl(target)) {
      try {
        await api.app.openExternal(target)
        notify('info', '已在系统浏览器中打开该链接')
      } catch (error) {
        notify('error', errorMessage(error))
      }
      return
    }
    await openPortalUrlWithFeedback(
      target,
      previewKind === 'external'
        ? '已在学习通官方页面打开该文件。'
        : '已打开资料预览；若浏览器不支持该文件类型，请下载后打开。',
      '学习通登录状态已失效，已跳转至登录页；请先登录后再查看资料'
    )
  }

  const handleOpenTaskInPortal = async (task: Task, course?: Course | null): Promise<void> => {
    const effectiveCourse =
      course ??
      (task.courseId ? (data?.courses.find((item) => item.id === task.courseId) ?? null) : null)
    const action = getTaskPortalAction(task, effectiveCourse)
    if (!action.target || action.kind === 'unavailable') {
      notify('info', action.title)
      return
    }
    lastOpenedTaskRef.current = buildRecentOpenedTaskContext(task, effectiveCourse)
    try {
      setSelectedTaskId(null)
      syncSuspendUntilRef.current = Date.now() + 60_000
      await syncControllerRef.current?.cancelForPortalOpen()
      setPortalLaunch(null)
      setPortalOverlayOpen(true)
      await new Promise((resolve) => setTimeout(resolve, 300))
      await api.portal.openUrl(action.target.url)
      const state = await api.portal.state()
      const feedback = resolveTaskPortalOpenFeedback(action.kind, state)
      if (feedback.status === 'error') {
        throw new Error(feedback.message)
      }
      notify('info', feedback.message)
    } catch (error) {
      setPortalOverlayOpen(false)
      void api.portal.hide().catch(() => undefined)
      notify('error', errorMessage(error))
    }
  }

  const handleOpenChapterInPortal = async (course: Course, chapter: Chapter): Promise<void> => {
    const target = getChapterOfficialUrl(course, chapter)
    if (!target) {
      notify('error', '该章节没有可用的学习通页面地址，请先同步课程')
      return
    }
    await openPortalUrlWithFeedback(
      target,
      '已在学习通打开章节页面',
      '学习通登录状态已失效，已跳转至登录页；请先登录后再继续学习'
    )
  }

  const handleOpenResourceInPortal = async (resource: ChapterResource): Promise<void> => {
    const extension = resource.type?.startsWith('.')
      ? resource.type
      : resource.type
        ? `.${resource.type}`
        : (resource.name.match(/\.[^.]+$/)?.[0] ?? '')
    const target =
      resource.url ??
      (resource.objectId && extension
        ? `https://p.ananas.chaoxing.com/star3/origin/${resource.objectId}${extension}`
        : null)
    if (!target) {
      notify('info', '平台只返回了文件信息，没有可打开的下载地址')
      return
    }
    if (!normalizePortalTargetUrl(target)) {
      try {
        await api.app.openExternal(target)
        notify('info', `已在系统浏览器中打开 ${resource.name}`)
      } catch (error) {
        notify('error', errorMessage(error))
      }
      return
    }
    await openPortalUrlWithFeedback(
      target,
      `已在应用内打开 ${resource.name}`,
      '学习通登录状态已失效，已跳转至登录页；请先登录后再查看章节附件'
    )
  }

  const handlePaletteCourse = (course: Course): void => {
    setStudyCourseId(course.id)
    setCourseFocusId(course.id)
    setCourseFocusTab('chapters')
    navigate('courses')
  }

  const handlePaletteMaterial = (material: Material): void => {
    setStudyCourseId(material.courseId)
    setCourseFocusId(material.courseId)
    setCourseFocusTab('materials')
    navigate('courses')
  }

  const handlePaletteNotice = (notice: AppNotice): void => {
    if (notice.url) {
      void window.studynext.app.openExternal(notice.url)
      return
    }
    navigate('notices')
  }

  const handlePaletteTheme = (): void => {
    const current = dataRef.current?.settings.theme ?? 'system'
    const next = current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system'
    void handleSettingsUpdate({ theme: next })
  }

  const handleSetUiZoom = (nextZoom: number): void => {
    const clamped = Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, Math.round(nextZoom * 100) / 100))
    const current = dataRef.current?.settings.uiZoom ?? 1
    if (Math.abs(clamped - current) < 0.001) return
    void handleSettingsUpdate({ uiZoom: clamped })
  }

  if (fatal) {
    return (
      <div className="fatal-screen">
        <div className="card fatal-card">
          <div className="empty-icon" style={{ margin: '0 auto 12px' }}>
            <X />
          </div>
          <h1>应用初始化失败</h1>
          <p>{fatal}</p>
          <button type="button" className="btn primary" onClick={() => window.location.reload()}>
            重新加载界面
          </button>
        </div>
      </div>
    )
  }

  if (loading || !data) {
    return (
      <div className="loading-screen">
        <div className="loading-card">
          <div className="spinner" />
          <div>正在载入本地课程与任务…</div>
        </div>
      </div>
    )
  }

  const chaoxingConnected = data.chaoxing.authState === 'authenticated'
  const syncProgress = syncSnapshot.progress
  const cancellingSync = syncSnapshot.cancelling
  const isSyncingNow = syncSnapshot.isSyncing || data.syncStatus.state === 'syncing'
  const effectiveSyncStatus: SyncStatus = isSyncingNow
    ? {
        ...data.syncStatus,
        state: 'syncing',
        message: syncProgress?.message ?? '正在同步学习通数据…'
      }
    : data.syncStatus
  const lastCompleteSyncAt = resolveLastCompleteSyncAt(effectiveSyncStatus, data.chaoxing)
  const topbarSyncIndicator = resolveTopbarSyncIndicator({
    syncStatus: effectiveSyncStatus,
    chaoxing: data.chaoxing,
    autoSyncError,
    isSyncing: isSyncingNow,
    syncProgress,
    lastCompleteLabel: lastCompleteSyncAt ? relativeTime(lastCompleteSyncAt) : null
  })

  const isCourseRoute = route === 'courses' || route === 'study' || route === 'materials'
  const isTasksRoute = route === 'tasks' || route === 'records' || route === 'exams'
  const activePrimaryNav: NavigateTarget | null =
    route === 'dashboard' || route === 'calendar'
      ? 'dashboard'
      : isCourseRoute
        ? 'courses'
        : isTasksRoute
          ? 'tasks'
          : null
  const unreadNoticeCount = data.notices.filter((notice) => notice.read === false).length

  const handleTopSync = (): void => {
    if (chaoxingConnected) {
      void handleChaoxingSync(true).catch(() => undefined)
    } else {
      void handleStartLogin(true)
    }
  }

  const page: JSX.Element =
    route === 'dashboard' || route === 'calendar' ? (
      <Dashboard
        courses={data.courses}
        tasks={data.tasks}
        exams={data.exams}
        notices={data.notices}
        syncStatus={effectiveSyncStatus}
        chaoxing={data.chaoxing}
        autoSyncError={autoSyncError}
        autoRefreshMinutes={data.settings.autoRefreshMinutes}
        weekStartsOn={data.settings.calendarWeekStartsOn}
        onOpenTask={(task) => setSelectedTaskId(task.id)}
        onOpenTaskInPortal={(task) => void handleOpenTaskInPortal(task)}
        onOpenCourse={handlePaletteCourse}
        onToggleTask={(task) => void handleToggleTask(task)}
        onCreateTask={() => setEditor({ task: null })}
        onQuickSync={handleTopSync}
        onConnectChaoxing={() => void handleStartLogin(true)}
        onOpenChaoxingHome={() => void handleOpenChaoxingHome()}
        onNavigate={navigate}
      />
    ) : isCourseRoute ? (
      <CourseWorkspace
        courses={data.courses}
        chapters={data.chapters}
        points={data.studyPoints}
        tasks={data.tasks}
        materials={data.materials}
        exams={data.exams}
        notices={data.notices}
        downloads={downloads}
        localFiles={materialLocalFiles}
        onOpenLocalMaterial={(materialId) =>
          void handleDownloadAction('已打开文件', () => api.materials.openLocal(materialId))
        }
        onRevealLocalMaterial={(materialId) =>
          void handleDownloadAction('已在文件夹中定位', () => api.materials.revealLocal(materialId))
        }
        onRefreshLocalFiles={refreshMaterialLocalFiles}
        onRecordDownload={recordTrackedDownload}
        selectedCourseId={studyCourseId}
        onSelectCourse={setStudyCourseId}
        focusCourseId={courseFocusId ?? studyFocusCourseId ?? materialFocusCourseId}
        focusChapterId={studyFocusChapterId}
        focusTab={courseFocusTab ?? (route === 'materials' ? 'materials' : null)}
        onFocusHandled={() => {
          setCourseFocusId(null)
          setStudyFocusCourseId(null)
          setMaterialFocusCourseId(null)
        }}
        onFocusChapterHandled={() => setStudyFocusChapterId(null)}
        onFocusTabHandled={() => setCourseFocusTab(null)}
        downloadPanelOpen={materialDownloadsOpen}
        onDownloadPanelHandled={() => setMaterialDownloadsOpen(false)}
        onToggleFavorite={(course) => handleToggleFavorite(course.id, course.favorite)}
        onOpenOfficial={(course) => {
          const url = getCourseOfficialUrl(course)
          if (!url) {
            notify('error', '该课程暂无可靠的学习通官方入口')
            return
          }
          void openPortalUrlWithFeedback(
            url,
            `已在学习通打开「${course.name}」课程页`,
            '学习通登录状态已失效，已跳转至登录页；请先登录后再进入课程页'
          )
        }}
        onOpenPortalUrl={(url, message) => {
          void openPortalUrlWithFeedback(url, message ?? '已在学习通官方页面打开')
        }}
        onRetryCourse={handleChaoxingRetryCourse}
        onTogglePoint={handleTogglePoint}
        onOpenChapter={handleOpenChapterInPortal}
        onOpenResource={handleOpenResourceInPortal}
        onOpenTask={(task) => setSelectedTaskId(task.id)}
        onOpenTaskInPortal={(task) => void handleOpenTaskInPortal(task)}
        onToggleTask={(task) => void handleToggleTask(task)}
        onDownloadMaterial={handleMaterialDownload}
        onPreviewMaterial={(material) => void handlePreviewMaterial(material)}
        onOpenDownload={(download) =>
          void handleDownloadAction('已打开文件', () => api.portal.openDownload(download.id))
        }
        onRevealDownload={(download) =>
          void handleDownloadAction('已在文件夹中定位', () =>
            api.portal.revealDownload(download.id)
          )
        }
        onCancelDownload={(download) =>
          void handleDownloadAction('已取消下载', async () =>
            api.portal.cancelDownload(download.id)
          )
        }
        onRetryDownload={(download) => {
          notify('info', '正在重新发起下载')
          void api.portal.retryDownload(download.id).catch((error: unknown) => {
            notify('error', errorMessage(error))
          })
        }}
        onDeleteDownload={(download) =>
          void handleDownloadAction('已删除下载记录', async () => {
            await api.portal.deleteDownload(download.id)
            setDownloads((previous) => previous.filter((item) => item.id !== download.id))
          })
        }
        onClearDownloads={() =>
          void handleDownloadAction('已清除未进行中的下载记录', async () => {
            await api.portal.clearDownloads()
            setDownloads((previous) => previous.filter((item) => item.state === 'progressing'))
          })
        }
        onCreateTaskForCourse={(courseId) => setEditor({ task: null, defaultCourseId: courseId })}
        onViewAllExams={() => navigate('exams')}
        onViewAllNotices={() => navigate('notices')}
        notify={notify}
      />
    ) : isTasksRoute ? (
      <Tasks
        tasks={data.tasks}
        courses={data.courses}
        exams={data.exams}
        authenticated={chaoxingConnected}
        dataUpdatedAt={lastCompleteSyncAt}
        syncStatus={effectiveSyncStatus}
        chaoxing={data.chaoxing}
        autoSyncError={autoSyncError}
        autoRefreshMinutes={data.settings.autoRefreshMinutes}
        focusCourseId={taskFocusCourseId}
        initialView={route === 'records' ? 'records' : route === 'exams' ? 'exams' : 'list'}
        onFocusHandled={() => setTaskFocusCourseId(null)}
        onCreate={() => setEditor({ task: null })}
        onOpen={(task) => setSelectedTaskId(task.id)}
        onOpenInPortal={(task) => void handleOpenTaskInPortal(task)}
        onOpenCourse={handlePaletteCourse}
        onConnectChaoxing={() => void handleStartLogin(true)}
        onQuickSync={handleTopSync}
        onOpenChaoxingHome={() => void handleOpenChaoxingHome()}
        onEdit={(task) => setEditor({ task })}
        onToggle={(task) => void handleToggleTask(task)}
        onDelete={requestDelete}
      />
    ) : route === 'notices' ? (
      <Notices
        notices={data.notices}
        courses={data.courses}
        focusCourseName={noticeFocusCourseName}
        onFocusHandled={() => setNoticeFocusCourseName(null)}
        onOpenCourse={handlePaletteCourse}
      />
    ) : (
      <Settings
        settings={data.settings}
        syncStatus={effectiveSyncStatus}
        chaoxing={data.chaoxing}
        appInfo={data.appInfo}
        reminderRuntime={data.reminderRuntime}
        onUpdateSettings={handleSettingsUpdate}
        onResetDemo={handleResetDemo}
        onSyncRun={() => handleSyncRun({ silent: true })}
        onChaoxingCheck={handleChaoxingCheck}
        onChaoxingSync={(force) => handleChaoxingSync(force, { silent: true })}
        onCancelSync={handleCancelSync}
        onSessionCleared={handleSessionCleared}
        onImported={async () => {
          await refreshBootstrap()
        }}
        notify={notify}
      />
    )

  return (
    <div className="app-shell c3-shell studio-shell" data-route={route}>
      <header
        className="titlebar studio-topbar"
        onDoubleClick={(event) => {
          if (event.target === event.currentTarget) api.window.toggleMaximize()
        }}
      >
        <div className="studio-topbar-left">
          <button
            type="button"
            className="titlebar-brand studio-brand"
            onClick={() => navigate('dashboard')}
            title="回到今天"
          >
            <span className="studio-brand-mark">
              <Atom size={13} />
            </span>
            <span>StudyNext</span>
          </button>
          {canGoBack || portalOverlayOpen ? (
            <button
              type="button"
              className="titlebar-back studio-back-btn"
              onClick={goBack}
              aria-label={portalOverlayOpen ? '返回应用' : '返回上一页'}
              title={portalOverlayOpen ? '关闭内嵌页面并返回' : '返回上一页'}
            >
              <ArrowLeft size={14} />
            </button>
          ) : null}
        </div>

        <nav className="studio-pill-nav" aria-label="主导航">
          {PRIMARY_NAV.map((item) => {
            const Icon = item.icon
            const active = activePrimaryNav === item.id
            return (
              <button
                key={item.id}
                type="button"
                className={
                  active ? 'nav-item studio-pill-item active' : 'nav-item studio-pill-item'
                }
                onClick={() => navigate(item.id)}
                aria-current={active ? 'page' : undefined}
              >
                <Icon size={13} />
                <span>{item.label}</span>
                {item.id === 'tasks' && openCount > 0 ? (
                  <span className="studio-pill-badge">{openCount}</span>
                ) : null}
              </button>
            )
          })}
        </nav>

        <div className="studio-topbar-right">
          <button
            type="button"
            className="sidebar-search-trigger studio-search-btn"
            onClick={() => setCommandOpen(true)}
            aria-label="全局搜索与命令"
            title="全局搜索与命令（Ctrl K）"
          >
            <Search size={13} />
            <span>搜索</span>
            <kbd>Ctrl K</kbd>
          </button>

          <button
            type="button"
            className={route === 'notices' ? 'studio-icon-btn active' : 'studio-icon-btn'}
            onClick={() => navigate('notices')}
            aria-label="通知收件箱"
            title={
              unreadNoticeCount > 0 ? `通知收件箱（${unreadNoticeCount} 条未读）` : '通知收件箱'
            }
          >
            <BellRing size={14} />
            {unreadNoticeCount > 0 ? <span className="studio-status-dot unread" /> : null}
          </button>

          <button
            type="button"
            className="studio-icon-btn titlebar-status"
            onClick={handleTopSync}
            disabled={isSyncingNow}
            aria-label={topbarSyncIndicator.label}
            title={topbarSyncIndicator.tooltip}
          >
            <RefreshCw size={13} className={isSyncingNow ? 'spin' : undefined} />
            <span className={`studio-status-dot ${topbarSyncIndicator.tone}`} />
          </button>

          <div className="titlebar-zoom-wrap" ref={zoomMenuRef}>
            <button
              type="button"
              className={
                zoomMenuOpen || Math.abs(data.settings.uiZoom - 1) > 0.005
                  ? 'titlebar-zoom-trigger active'
                  : 'titlebar-zoom-trigger'
              }
              onClick={() => setZoomMenuOpen((open) => !open)}
              aria-label={`界面缩放比例 ${Math.round(data.settings.uiZoom * 100)}%`}
              aria-expanded={zoomMenuOpen}
              title="调整界面缩放比例（Ctrl + / Ctrl - / Ctrl 0）"
            >
              <ZoomIn size={11} />
              <span>{Math.round(data.settings.uiZoom * 100)}%</span>
            </button>
            {zoomMenuOpen ? (
              <div className="titlebar-zoom-popover" role="dialog" aria-label="调整界面缩放比例">
                <div className="titlebar-zoom-head">
                  <span>界面缩放</span>
                  <button
                    type="button"
                    className="titlebar-zoom-reset"
                    disabled={Math.abs(data.settings.uiZoom - 1) < 0.005}
                    onClick={() => handleSetUiZoom(1)}
                  >
                    <RotateCcw size={11} /> 100%
                  </button>
                </div>
                <div className="titlebar-zoom-stepper">
                  <button
                    type="button"
                    className="zoom-step-btn"
                    aria-label="缩小界面"
                    disabled={data.settings.uiZoom <= UI_ZOOM_MIN + 0.001}
                    onClick={() => handleSetUiZoom(data.settings.uiZoom - UI_ZOOM_STEP)}
                  >
                    <Minus size={12} />
                  </button>
                  <strong className="titlebar-zoom-value">
                    {Math.round(data.settings.uiZoom * 100)}%
                  </strong>
                  <button
                    type="button"
                    className="zoom-step-btn"
                    aria-label="放大界面"
                    disabled={data.settings.uiZoom >= UI_ZOOM_MAX - 0.001}
                    onClick={() => handleSetUiZoom(data.settings.uiZoom + UI_ZOOM_STEP)}
                  >
                    <Plus size={12} />
                  </button>
                </div>
                <div className="titlebar-zoom-presets">
                  {UI_ZOOM_PRESETS.map((preset) => {
                    const active = Math.abs(data.settings.uiZoom - preset) < 0.005
                    return (
                      <button
                        key={preset}
                        type="button"
                        className={active ? 'zoom-preset-btn active' : 'zoom-preset-btn'}
                        aria-pressed={active}
                        onClick={() => handleSetUiZoom(preset)}
                      >
                        {Math.round(preset * 100)}%
                      </button>
                    )
                  })}
                </div>
                <div className="titlebar-zoom-hint">快捷键 Ctrl - / Ctrl + / Ctrl 0</div>
              </div>
            ) : null}
          </div>

          <div className="studio-account-wrap" ref={accountMenuRef}>
            <button
              type="button"
              className="studio-account-btn"
              onClick={() => {
                setAccountMenuOpen((open) => !open)
                void refreshCredentialStatus()
              }}
              aria-label={accountAuthenticated ? `学习通账号 ${accountName}` : '登录或管理账号'}
              aria-expanded={accountMenuOpen}
            >
              <SidebarAccountAvatar
                src={data.chaoxing.avatarUrl}
                name={data.chaoxing.displayName}
              />
              <span className="studio-account-label">
                {accountAuthenticated ? accountName : '未登录'}
              </span>
            </button>

            {accountMenuOpen ? (
              <div className="studio-account-popover">
                <div className="studio-account-profile">
                  <SidebarAccountAvatar
                    src={data.chaoxing.avatarUrl}
                    name={data.chaoxing.displayName}
                  />
                  <div className="studio-account-profile-copy">
                    <strong>{accountAuthenticated ? accountName : '未登录学习通'}</strong>
                    <span>
                      {accountAuthenticated
                        ? `${accountSchool}${accountId ? ` · ${accountId}` : ''}`
                        : '登录后自动同步课程、作业与课件'}
                    </span>
                  </div>
                </div>

                <div className="studio-popover-actions">
                  {credentialStatus && credentialStatus.accounts.length > 0
                    ? credentialStatus.accounts.map((account) => (
                        <button
                          key={account.id}
                          type="button"
                          className="studio-popover-item"
                          onClick={() => void handleSwitchAccount(account.id)}
                          disabled={accountBusy}
                        >
                          <LogIn size={12} />
                          <span>{account.displayName || account.username}</span>
                          {account.id === credentialStatus.activeAccountId ? <em>当前</em> : null}
                        </button>
                      ))
                    : null}
                </div>

                <form
                  className="sidebar-account-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void handleSaveQuickAccount()
                  }}
                >
                  <input
                    value={quickUsername}
                    onChange={(event) => setQuickUsername(event.target.value)}
                    placeholder="学习通手机号或邮箱"
                    autoComplete="username"
                    disabled={quickSaving}
                  />
                  <div className="password-field">
                    <input
                      type={showQuickPassword ? 'text' : 'password'}
                      value={quickPassword}
                      onChange={(event) => setQuickPassword(event.target.value)}
                      placeholder="密码"
                      autoComplete="current-password"
                      disabled={quickSaving}
                    />
                    <button
                      type="button"
                      className="password-toggle"
                      onClick={() => setShowQuickPassword((visible) => !visible)}
                      aria-label={showQuickPassword ? '隐藏密码' : '显示密码'}
                    >
                      {showQuickPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                  </div>
                  <button type="submit" className="btn small" disabled={quickSaving}>
                    {quickSaving ? '保存中…' : '保存账号'}
                  </button>
                </form>

                <div className="studio-popover-divider" />

                <div className="studio-popover-actions">
                  <button
                    type="button"
                    className="studio-popover-item"
                    onClick={() => void handleStartLogin(true)}
                    disabled={accountBusy}
                  >
                    <LogIn size={13} />
                    <span>{accountAuthenticated ? '登录其他学习通账号' : '立即登录学习通'}</span>
                  </button>
                  <button
                    type="button"
                    className="studio-popover-item"
                    onClick={() => {
                      setAccountMenuOpen(false)
                      setMaterialDownloadsOpen(true)
                      navigate('courses')
                    }}
                  >
                    <Download size={13} />
                    <span>下载管理</span>
                  </button>
                  <button
                    type="button"
                    className="studio-popover-item"
                    onClick={() => {
                      handlePaletteTheme()
                    }}
                  >
                    {data.settings.theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
                    <span>
                      切换主题（当前：
                      {data.settings.theme === 'system'
                        ? '跟随系统'
                        : data.settings.theme === 'dark'
                          ? '深色'
                          : '浅色'}
                      ）
                    </span>
                  </button>
                  <button
                    type="button"
                    className="studio-popover-item"
                    onClick={() => {
                      setAccountMenuOpen(false)
                      void window.studynext.app.openExternal('https://i.chaoxing.com/base')
                    }}
                  >
                    <ExternalLink size={13} />
                    <span>在浏览器打开学习通</span>
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <button
            type="button"
            className={route === 'settings' ? 'studio-icon-btn active' : 'studio-icon-btn'}
            onClick={() => navigate('settings')}
            aria-label="设置"
            title="设置"
          >
            <SettingsIcon size={14} />
          </button>

          <span className="studio-topbar-sep" aria-hidden="true" />

          <div className="window-controls">
            <button
              type="button"
              className="window-control"
              aria-label="最小化"
              onClick={() => api.window.minimize()}
            >
              <Minus size={14} />
            </button>
            <button
              type="button"
              className="window-control"
              aria-label={maximized ? '还原窗口' : '最大化'}
              onClick={() => api.window.toggleMaximize()}
            >
              {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
            <button
              type="button"
              className="window-control close"
              aria-label="关闭"
              onClick={() => api.window.close()}
            >
              <X size={15} />
            </button>
          </div>
        </div>
      </header>

      {isSyncingNow ? (
        <div className="studio-sync-progress-bar" role="status" aria-live="polite">
          <span className="studio-sync-progress-main">
            <RefreshCw size={12} className="spin" aria-hidden="true" />
            <span>{syncProgress?.message || '正在后台同步学习通数据，你可继续浏览页面…'}</span>
            {syncProgress && syncProgress.total > 0 ? (
              <span className="studio-sync-progress-step">
                {syncProgress.current}/{syncProgress.total}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            className="studio-sync-progress-cancel"
            onClick={() => void handleCancelSync()}
            disabled={cancellingSync}
          >
            {cancellingSync ? '正在取消…' : '取消同步'}
          </button>
        </div>
      ) : null}

      <main className="main-scroll studio-main" ref={mainScrollRef} aria-label={ROUTE_TITLE[route]}>
        {page}
      </main>

      <CommandPalette
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        courses={data.courses}
        tasks={data.tasks}
        exams={data.exams}
        materials={data.materials}
        notices={data.notices}
        chapters={data.chapters}
        onNavigate={navigate}
        onOpenTask={(task) => setSelectedTaskId(task.id)}
        onOpenCourse={handlePaletteCourse}
        onOpenChapter={(courseId, chapterId) => {
          setStudyCourseId(courseId)
          setCourseFocusId(courseId)
          setStudyFocusChapterId(chapterId)
          setCourseFocusTab('chapters')
          navigate('courses')
        }}
        onOpenMaterial={handlePaletteMaterial}
        onOpenNotice={handlePaletteNotice}
        onCreateTask={() => setEditor({ task: null })}
        onOpenDownloads={() => {
          setMaterialDownloadsOpen(true)
          navigate('courses')
        }}
        onRefresh={() => void handleChaoxingSync(true).catch(() => undefined)}
        onToggleTheme={handlePaletteTheme}
        onZoomIn={() => handleSetUiZoom((dataRef.current?.settings.uiZoom ?? 1) + UI_ZOOM_STEP)}
        onZoomOut={() => handleSetUiZoom((dataRef.current?.settings.uiZoom ?? 1) - UI_ZOOM_STEP)}
        onZoomReset={() => handleSetUiZoom(1)}
      />

      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      {portalOverlayOpen ? (
        <div className="portal-overlay studio-portal-overlay">
          <Portal
            entries={data.officialEntries}
            launchEntryId={portalLaunch}
            uiZoom={data.settings.uiZoom}
            onLaunchHandled={handleLaunchHandled}
            onClose={() => {
              setPortalOverlayOpen(false)
              setPortalLaunch(null)
              void api.portal.hide()
            }}
            onSessionCleared={handleSessionCleared}
            notify={notify}
          />
        </div>
      ) : null}

      {loginDialogOpen ? (
        <LoginDialog
          entries={data.officialEntries}
          onClose={() => {
            setLoginDialogOpen(false)
            setLoginAccountId(null)
            setLoginAccountLabel(null)
          }}
          onAuthenticated={() => void handleLoginAuthenticated()}
          notify={notify}
          autoAccountId={loginAccountId}
          autoAccountLabel={loginAccountLabel}
        />
      ) : null}

      {editor ? (
        <TaskEditor
          key={editor.task?.id ?? `new-task-${editor.defaultCourseId ?? 'none'}`}
          task={editor.task}
          defaultCourseId={editor.defaultCourseId ?? null}
          courses={data.courses}
          defaultReminderOffsets={data.settings.defaultReminderOffsets}
          onClose={() => setEditor(null)}
          onSubmit={handleSaveTask}
        />
      ) : null}

      {selectedTask ? (
        <TaskDetail
          task={selectedTask}
          course={selectedCourse}
          onClose={() => setSelectedTaskId(null)}
          onOpenInPortal={() => void handleOpenTaskInPortal(selectedTask)}
          onOpenCourse={
            selectedCourse
              ? () => {
                  setSelectedTaskId(null)
                  setCourseFocusId(selectedCourse.id)
                  navigate('courses')
                }
              : undefined
          }
          onEdit={() => {
            setEditor({ task: selectedTask })
            setSelectedTaskId(null)
          }}
          onDelete={() => requestDelete(selectedTask)}
          onToggle={() => handleToggleTask(selectedTask)}
        />
      ) : null}

      {confirmTask ? (
        <ConfirmDialog
          title="删除任务？"
          message={`“${confirmTask.title}”及其提醒规则将被永久删除，此操作无法撤销。`}
          warning={`截止时间：${formatDateTime(confirmTask.dueAt)}（${formatTime(confirmTask.dueAt)}）`}
          confirmLabel="删除任务"
          danger
          busy={deleting}
          onCancel={() => setConfirmTask(null)}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </div>
  )
}
