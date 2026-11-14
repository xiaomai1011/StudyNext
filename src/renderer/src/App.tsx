import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import {
  BellRing,
  BookMarked,
  BookOpen,
  BrainCircuit,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  FileText,
  FolderOpen,
  Globe2,
  GraduationCap,
  LayoutDashboard,
  ListChecks,
  Maximize2,
  MessageSquareText,
  Minimize2,
  Minus,
  Settings as SettingsIcon,
  ShieldCheck,
  Target,
  X
} from 'lucide-react'
import type {
  AppSettings,
  BootstrapData,
  ChaoxingSessionStatus,
  Course,
  Material,
  NavigateTarget,
  OfficialEntry,
  OfficialEntryInput,
  QuestionCard,
  QuestionInput,
  QuestionSource,
  StudyPoint,
  SyncStatus,
  Task,
  TaskUpsertInput
} from '@shared/types'
import { dueBucket, formatRemainingCompact, isDueAtUnknown, sortTasksByDue } from '@shared/domain'
import { Dashboard } from './pages/Dashboard'
import { Courses } from './pages/Courses'
import { Tasks } from './pages/Tasks'
import { Exams } from './pages/Exams'
import { Materials } from './pages/Materials'
import { Records } from './pages/Records'
import { Calendar } from './pages/Calendar'
import { Portal } from './pages/Portal'
import { Settings } from './pages/Settings'
import { Study } from './pages/Study'
import { Questions } from './pages/Questions'
import { TaskEditor } from './components/TaskEditor'
import { TaskDetail } from './components/TaskDetail'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ToastStack, type ToastItem, type ToastKind } from './components/ToastStack'
import { errorMessage, formatDateTime, formatTime, reminderOffsetLabel } from './lib/format'

const NAV_ITEMS: Array<{ id: NavigateTarget; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'dashboard', label: '总览', icon: LayoutDashboard },
  { id: 'study', label: '学习中心', icon: BookMarked },
  { id: 'courses', label: '课程中心', icon: BookOpen },
  { id: 'tasks', label: '任务中心', icon: ListChecks },
  { id: 'exams', label: '考试中心', icon: ClipboardList },
  { id: 'materials', label: '资料中心', icon: FolderOpen },
  { id: 'records', label: '作业记录', icon: FileText },
  { id: 'calendar', label: '日历', icon: CalendarDays },
  { id: 'questions', label: '题目助手', icon: MessageSquareText },
  { id: 'portal', label: '官方页面', icon: Globe2 },
  { id: 'settings', label: '设置', icon: SettingsIcon }
]

const ROUTE_TITLE: Record<NavigateTarget, string> = {
  dashboard: '总览',
  study: '学习中心',
  courses: '课程中心',
  tasks: '任务中心',
  exams: '考试中心',
  materials: '资料中心',
  records: '作业记录',
  calendar: '日历',
  questions: '题目助手',
  portal: '官方页面',
  settings: '设置'
}

export default function App(): JSX.Element {
  const [data, setData] = useState<BootstrapData | null>(null)
  const [loading, setLoading] = useState(true)
  const [fatal, setFatal] = useState<string | null>(null)
  const [route, setRoute] = useState<NavigateTarget>('dashboard')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ task: Task | null } | null>(null)
  const [confirmTask, setConfirmTask] = useState<Task | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [maximized, setMaximized] = useState(false)
  const [portalLaunch, setPortalLaunch] = useState<string | null>(null)
  const toastSeq = useRef(0)
  const toastTimers = useRef<number[]>([])
  const api = window.studynext

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

  useEffect(() => {
    const timers = toastTimers.current
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [])

  const refreshBootstrap = useCallback(async (): Promise<void> => {
    const next = await api.bootstrap()
    setData(next)
  }, [api])

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
      if (target !== 'portal') setPortalLaunch(null)
    })
    const unsubReminder = api.app.onReminder((event) => {
      notify('info', `DDL 提醒：${event.taskTitle}（${reminderOffsetLabel(event.offsetMinutes)}）`)
    })
    const unsubFocus = api.app.onFocusTask((taskId) => {
      setRoute('tasks')
      setSelectedTaskId(taskId)
    })
    const unsubMaximized = api.window.onMaximized((event) => setMaximized(event.maximized))
    void api.window
      .isMaximized()
      .then(setMaximized)
      .catch(() => undefined)
    return () => {
      unsubNavigate()
      unsubReminder()
      unsubFocus()
      unsubMaximized()
    }
  }, [api, notify])

  useEffect(() => {
    return api.portal.onSubmitDetected((event) => {
      notify('info', '已检测到作业提交结果，正在重新核验平台状态…')
      void (async () => {
        try {
          if (event.platformCourseId) {
            const course = data?.courses.find(
              (item) =>
                item.source === 'chaoxing' &&
                (item.externalId ?? '').split(':')[0] === event.platformCourseId
            )
            if (course) await api.chaoxing.retryCourse(course.id)
          }
          await refreshBootstrap()
          notify('success', '平台状态已重新同步')
        } catch (error: unknown) {
          notify('error', `提交后核验失败：${errorMessage(error)}`)
        }
      })()
    })
  }, [api, data?.courses, refreshBootstrap, notify])

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

  const focusTask = useMemo(() => {
    if (!data) return null
    const now = new Date()
    return (
      sortTasksByDue(
        data.tasks.filter(
          (task) =>
            task.status === 'todo' &&
            !isDueAtUnknown(task.dueAt) &&
            new Date(task.dueAt).getTime() >= now.getTime()
        )
      )[0] ?? null
    )
  }, [data])

  const openCount =
    data?.tasks.filter(
      (task) => task.status === 'todo' && dueBucket(task, new Date()) !== 'overdue'
    ).length ?? 0

  const navigate = useCallback((target: NavigateTarget): void => {
    setRoute(target)
    if (target !== 'portal') setPortalLaunch(null)
  }, [])

  const openPortal = useCallback((entryId: string): void => {
    setPortalLaunch(entryId)
    setRoute('portal')
  }, [])

  const handleLaunchHandled = useCallback((): void => {
    setPortalLaunch(null)
  }, [])

  const handleToggleTask = async (task: Task): Promise<void> => {
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
    setSelectedTaskId(null)
    setConfirmTask(task)
  }

  const confirmDelete = async (): Promise<void> => {
    if (!confirmTask) return
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

  const handleCreateQuestion = async (
    input: QuestionInput,
    source: QuestionSource
  ): Promise<QuestionCard> => {
    const card = await api.questions.create(input, source)
    setData((current) =>
      current ? { ...current, questions: [card, ...current.questions] } : current
    )
    return card
  }

  const handleUpdateQuestion = async (id: string, input: QuestionInput): Promise<QuestionCard> => {
    const card = await api.questions.update(id, input)
    setData((current) =>
      current
        ? {
            ...current,
            questions: current.questions.map((item) => (item.id === card.id ? card : item))
          }
        : current
    )
    return card
  }

  const handleRemoveQuestion = async (id: string): Promise<void> => {
    await api.questions.remove(id)
    setData((current) =>
      current
        ? { ...current, questions: current.questions.filter((item) => item.id !== id) }
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

  const handleSyncRun = async (): Promise<SyncStatus> => {
    const next = await api.sync.run()
    setData((current) => (current ? { ...current, syncStatus: next } : current))
    return next
  }

  const handleChaoxingCheck = async (): Promise<ChaoxingSessionStatus> => {
    const next = await api.chaoxing.check()
    setData((current) => (current ? { ...current, chaoxing: next } : current))
    return next
  }

  const handleChaoxingSync = async (force = true): Promise<ChaoxingSessionStatus> => {
    const next = await api.chaoxing.sync(force)
    await refreshBootstrap()
    return next
  }

  const handleChaoxingRetryCourse = async (course: Course): Promise<void> => {
    try {
      const next = await api.chaoxing.retryCourse(course.id)
      await refreshBootstrap()
      notify(next.authState === 'authenticated' ? 'success' : 'error', next.message)
    } catch (error) {
      notify('error', errorMessage(error))
    }
  }

  const handleMaterialDownload = async (material: Material): Promise<void> => {
    try {
      await api.materials.download(material.id)
      notify('info', `已开始下载 ${material.name}，可在“官方页面 → 下载管理器”查看进度`)
    } catch (error) {
      notify('error', errorMessage(error))
    }
  }

  const handleOpenTaskInPortal = async (task: Task): Promise<void> => {
    if (!task.sourceUrl) return
    try {
      await api.portal.openUrl(task.sourceUrl)
      setSelectedTaskId(null)
      navigate('portal')
      notify('info', '已在官方页面打开作业，可直接编辑、上传附件并提交')
    } catch (error) {
      notify('error', errorMessage(error))
    }
  }

  const handleCreateEntry = async (input: OfficialEntryInput): Promise<void> => {
    const entry = await api.entries.create(input)
    setData((current) =>
      current
        ? {
            ...current,
            officialEntries: [...current.officialEntries, entry].sort(
              (a, b) => a.sortOrder - b.sortOrder
            )
          }
        : current
    )
  }

  const handleToggleEntry = async (entry: OfficialEntry, enabled: boolean): Promise<void> => {
    const updated = await api.entries.updateEnabled(entry.id, enabled)
    setData((current) =>
      current
        ? {
            ...current,
            officialEntries: current.officialEntries.map((item) =>
              item.id === updated.id ? updated : item
            )
          }
        : current
    )
    notify('success', enabled ? '官方入口已启用' : '官方入口已禁用')
  }

  const handleRemoveEntry = async (entry: OfficialEntry): Promise<void> => {
    await api.entries.remove(entry.id)
    setData((current) =>
      current
        ? {
            ...current,
            officialEntries: current.officialEntries.filter((item) => item.id !== entry.id)
          }
        : current
    )
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

  const snapshotImported = data.syncStatus.source === 'import'
  const chaoxingConnected = data.chaoxing.authState === 'authenticated'
  const syncLabel =
    data.syncStatus.state === 'failure'
      ? snapshotImported
        ? '快照导入失败 · 本地数据可用'
        : '同步失败 · 本地数据可用'
      : data.syncStatus.state === 'partial'
        ? snapshotImported
          ? '快照部分导入 · 检查详情'
          : '部分同步 · 检查详情'
        : data.syncStatus.state === 'syncing'
          ? '正在同步…'
          : chaoxingConnected
            ? '已连接学习通 · Web Session'
            : snapshotImported
              ? '本地快照 · 未连接学习通'
              : '本地模式 · 未连接学习通'

  const page: JSX.Element =
    route === 'dashboard' ? (
      <Dashboard
        courses={data.courses}
        tasks={data.tasks}
        notices={data.notices}
        syncStatus={data.syncStatus}
        onOpenTask={(task) => setSelectedTaskId(task.id)}
        onToggleTask={(task) => void handleToggleTask(task)}
        onNavigate={navigate}
      />
    ) : route === 'study' ? (
      <Study
        courses={data.courses}
        chapters={data.chapters}
        points={data.studyPoints}
        onTogglePoint={handleTogglePoint}
        onImport={() => navigate('settings')}
        notify={notify}
      />
    ) : route === 'courses' ? (
      <Courses
        courses={data.courses}
        onToggleFavorite={(course) => handleToggleFavorite(course.id, course.favorite)}
        onOpenOfficial={() => openPortal('entry-courses')}
        onRetryCourse={handleChaoxingRetryCourse}
      />
    ) : route === 'tasks' ? (
      <Tasks
        tasks={data.tasks}
        courses={data.courses}
        onCreate={() => setEditor({ task: null })}
        onOpen={(task) => setSelectedTaskId(task.id)}
        onEdit={(task) => setEditor({ task })}
        onToggle={(task) => void handleToggleTask(task)}
        onDelete={requestDelete}
      />
    ) : route === 'exams' ? (
      <Exams exams={data.exams} />
    ) : route === 'materials' ? (
      <Materials courses={data.courses} materials={data.materials} onDownload={handleMaterialDownload} />
    ) : route === 'records' ? (
      <Records
        tasks={data.tasks}
        courses={data.courses}
        onOpenTask={(task) => setSelectedTaskId(task.id)}
        onOpenInPortal={(task) => void handleOpenTaskInPortal(task)}
      />
    ) : route === 'calendar' ? (
      <Calendar
        tasks={data.tasks}
        courses={data.courses}
        weekStartsOn={data.settings.calendarWeekStartsOn}
        onOpenTask={(task) => setSelectedTaskId(task.id)}
      />
    ) : route === 'questions' ? (
      <Questions
        questions={data.questions}
        courses={data.courses}
        onCreate={handleCreateQuestion}
        onUpdate={handleUpdateQuestion}
        onRemove={handleRemoveQuestion}
        onOpenSettings={() => navigate('settings')}
        notify={notify}
      />
    ) : route === 'portal' ? (
      <Portal
        entries={data.officialEntries}
        launchEntryId={portalLaunch}
        onLaunchHandled={handleLaunchHandled}
        notify={notify}
      />
    ) : (
      <Settings
        settings={data.settings}
        syncStatus={data.syncStatus}
        chaoxing={data.chaoxing}
        entries={data.officialEntries}
        appInfo={data.appInfo}
        reminderRuntime={data.reminderRuntime}
        onUpdateSettings={handleSettingsUpdate}
        onResetDemo={handleResetDemo}
        onCreateEntry={handleCreateEntry}
        onToggleEntry={handleToggleEntry}
        onRemoveEntry={handleRemoveEntry}
        onSyncRun={handleSyncRun}
        onChaoxingCheck={handleChaoxingCheck}
        onChaoxingSync={handleChaoxingSync}
        onImported={refreshBootstrap}
        notify={notify}
      />
    )

  return (
    <div className="app-shell">
      <header
        className="titlebar"
        onDoubleClick={(event) => {
          if (event.target === event.currentTarget) api.window.toggleMaximize()
        }}
      >
        <div className="titlebar-brand">
          <span className="brand-mark">
            <GraduationCap size={14} />
          </span>
          StudyNext
        </div>
        <div className="titlebar-status">
          <span
            className="dot"
            style={{
              background:
                data.syncStatus.state === 'not_configured' ? 'var(--warning)' : 'var(--success)'
            }}
          />
          {syncLabel}
        </div>
        <div className="titlebar-spacer" />
        <div className="window-controls">
          <button
            type="button"
            className="window-control"
            aria-label="最小化"
            onClick={() => api.window.minimize()}
          >
            <Minus size={15} />
          </button>
          <button
            type="button"
            className="window-control"
            aria-label={maximized ? '还原窗口' : '最大化'}
            onClick={() => api.window.toggleMaximize()}
          >
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            type="button"
            className="window-control close"
            aria-label="关闭"
            onClick={() => api.window.close()}
          >
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="app-body">
        <aside className="sidebar">
          <div className="sidebar-label">工作台</div>
          <nav className="nav-list" aria-label="主导航">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  type="button"
                  className={route === item.id ? 'nav-item active' : 'nav-item'}
                  onClick={() => navigate(item.id)}
                  title={item.label}
                >
                  <Icon />
                  <span>{item.label}</span>
                  {item.id === 'tasks' && openCount > 0 ? (
                    <span className="nav-badge">{openCount}</span>
                  ) : null}
                </button>
              )
            })}
          </nav>

          <div className="sidebar-label">下一步</div>
          <div className="sidebar-focus">
            <div className="sidebar-focus-title">
              <Target size={13} /> 近期焦点
            </div>
            {focusTask ? (
              <>
                <p style={{ color: 'var(--text)', fontWeight: 600 }}>{focusTask.title}</p>
                <p>
                  {formatRemainingCompact(focusTask.dueAt)} ·{' '}
                  {isDueAtUnknown(focusTask.dueAt) ? '待确认' : formatDateTime(focusTask.dueAt)}
                </p>
                <button
                  type="button"
                  className="text-link"
                  style={{ marginTop: 2 }}
                  onClick={() => setSelectedTaskId(focusTask.id)}
                >
                  查看任务详情
                </button>
              </>
            ) : (
              <p>没有待完成的任务。可以在任务中心规划下一项学习安排。</p>
            )}
          </div>

          <div className="sidebar-footer">
            <ShieldCheck size={14} style={{ color: 'var(--teal)', flexShrink: 0 }} />
            <span>
              本地优先 · 数据不上传
              <br />v{data.appInfo.version}
            </span>
          </div>
        </aside>

        <main className="main-scroll" aria-label={ROUTE_TITLE[route]}>
          {page}
        </main>
      </div>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      {editor ? (
        <TaskEditor
          key={editor.task?.id ?? 'new-task'}
          task={editor.task}
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
