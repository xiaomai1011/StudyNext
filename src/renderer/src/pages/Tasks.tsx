import { useEffect, useMemo, useState, type JSX } from 'react'
import {
  AlertTriangle,
  Bell,
  CalendarDays,
  CheckCircle2,
  Clock3,
  ExternalLink,
  MessageSquareText,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2
} from 'lucide-react'
import type {
  ChaoxingSessionStatus,
  Course,
  Exam,
  SyncStatus,
  Task,
  TaskPriority
} from '@shared/types'
import { formatRemainingCompact } from '@shared/domain'
import { TASK_KIND_LABEL } from '@shared/constants'
import { getCourseClassLabel } from '@shared/course-identity'
import {
  isDataFreshnessStale,
  isSecurityBlockedMessage,
  resolveLastCompleteSyncAt,
  summarizeSyncIssueDetail
} from '@shared/sync-feedback'
import {
  getTaskPortalAction,
  getTaskScoreView,
  getTaskStatusView,
  isPlatformTask
} from '@shared/task-state'
import {
  buildTaskDeadlineGroups,
  filterAndSortWorkflowTasks,
  formatTaskRowDueCaption,
  isTaskActionableOverdue,
  isTaskCompleted,
  summarizeTaskWorkflow,
  type TaskDeadlineFilter,
  type TaskSortMode,
  type TaskStatusFilter
} from '@shared/task-workflow'
import { formatDateTime, formatDueAt, priorityLabel, relativeTime } from '../lib/format'
import { Records } from './Records'
import { Exams } from './Exams'
import { Badge, Button, EmptyState } from '../ui/primitives'
import { platformStatusTone } from '../ui/status'

type SortMode = TaskSortMode
type TaskFilter = TaskStatusFilter
export type TasksHubView = 'list' | 'records' | 'exams'

interface TasksProps {
  tasks: Task[]
  courses: Course[]
  exams?: Exam[]
  authenticated?: boolean
  dataUpdatedAt?: string | null
  syncStatus?: SyncStatus | null
  chaoxing?: ChaoxingSessionStatus | null
  autoSyncError?: string | null
  autoRefreshMinutes?: number
  focusCourseId?: string | null
  initialView?: TasksHubView
  onFocusHandled?: () => void
  onCreate: () => void
  onOpen: (task: Task) => void
  onOpenInPortal?: (task: Task) => void
  onOpenCourse?: (course: Course) => void
  onConnectChaoxing?: () => void
  onQuickSync?: () => void
  onOpenChaoxingHome?: () => void
  onEdit: (task: Task) => void
  onToggle: (task: Task) => void
  onDelete: (task: Task) => void
}

export function Tasks({
  tasks,
  courses,
  exams = [],
  authenticated = false,
  dataUpdatedAt,
  syncStatus = null,
  chaoxing = null,
  autoSyncError = null,
  autoRefreshMinutes = 5,
  focusCourseId,
  initialView = 'list',
  onFocusHandled,
  onCreate,
  onOpen,
  onOpenInPortal,
  onOpenCourse,
  onConnectChaoxing,
  onQuickSync,
  onOpenChaoxingHome,
  onEdit,
  onToggle,
  onDelete
}: TasksProps) {
  const [hubView, setHubView] = useState<TasksHubView>(initialView)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<TaskFilter>('all')
  const [deadlineFilter, setDeadlineFilter] = useState<TaskDeadlineFilter>('all')
  const [courseId, setCourseId] = useState('all')
  const [priority, setPriority] = useState<TaskPriority | 'all'>('all')
  const [sortMode, setSortMode] = useState<SortMode>('due')
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    setHubView(initialView)
  }, [initialView])

  useEffect(() => {
    if (!focusCourseId) return
    setCourseId(focusCourseId)
    setQuery('')
    setStatus('all')
    setDeadlineFilter('all')
    onFocusHandled?.()
  }, [focusCourseId, onFocusHandled])

  const courseById = useMemo(() => new Map(courses.map((course) => [course.id, course])), [courses])
  const duplicateCourseNames = useMemo(() => {
    const seen = new Map<string, number>()
    for (const course of courses) {
      seen.set(course.name, (seen.get(course.name) ?? 0) + 1)
    }
    return new Set([...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name))
  }, [courses])
  const courseDisplayLabel = (course: Course): string =>
    duplicateCourseNames.has(course.name)
      ? `${course.name}（${course.className?.trim() || getCourseClassLabel(course)}）`
      : course.name

  const workflowSummary = useMemo(() => summarizeTaskWorkflow(tasks, now), [tasks, now])
  const counts = useMemo(
    () => ({
      all: workflowSummary.total,
      todo: workflowSummary.actionableTotal,
      done: workflowSummary.completed,
      review: workflowSummary.pendingReview,
      submitted: workflowSummary.submitted,
      reviewed: workflowSummary.reviewed
    }),
    [workflowSummary]
  )
  const overdueCount = workflowSummary.overdueActionable

  const selectStatusFilter = (next: TaskFilter): void => {
    setStatus(next)
    setDeadlineFilter('all')
  }

  const toggleDeadlineFilter = (next: TaskDeadlineFilter): void => {
    if (deadlineFilter === next) {
      setDeadlineFilter('all')
      return
    }
    if (status !== 'all' && status !== 'todo') {
      setStatus('todo')
    }
    setDeadlineFilter(next)
  }

  const hasActiveFilters =
    query.trim() !== '' ||
    status !== 'all' ||
    deadlineFilter !== 'all' ||
    courseId !== 'all' ||
    priority !== 'all'

  const resetAllFilters = (): void => {
    setQuery('')
    setStatus('all')
    setDeadlineFilter('all')
    setCourseId('all')
    setPriority('all')
  }

  const filtered = useMemo(
    () =>
      filterAndSortWorkflowTasks(
        tasks,
        {
          query,
          status,
          deadline: deadlineFilter,
          courseId,
          priority,
          sortMode
        },
        now
      ),
    [tasks, query, status, deadlineFilter, courseId, priority, sortMode, now]
  )

  const groups = useMemo(() => {
    if (sortMode !== 'due') return null
    return buildTaskDeadlineGroups(filtered, now, {
      prioritizeOverdue: status === 'todo' || deadlineFilter === 'overdue'
    })
  }, [filtered, sortMode, now, status, deadlineFilter])

  const renderRow = (task: Task): JSX.Element => {
    const course = task.courseId ? courseById.get(task.courseId) : null
    const statusView = getTaskStatusView(task, now)
    const { platformLabel, platformClass, localLabel, showLocalPill } = statusView
    const actionableOverdue = isTaskActionableOverdue(task, now)
    const dueLabel = formatDueAt(task.dueAt)
    const completed = isTaskCompleted(task)
    const dueCaption = formatTaskRowDueCaption(task, statusView, now)
    const pendingReview = task.platformStatusKind === 'pending_review'
    const showTaskCheck = statusView.canToggleLocal
    const platform = isPlatformTask(task)
    const hasStatusBadges = Boolean(platformLabel || (showLocalPill && platform))
    const scoreView = getTaskScoreView(task)
    const feedbackPreview = task.teacherFeedback?.trim() ?? ''
    return (
      <div
        className={[
          'task-row',
          'b2-task-row',
          completed ? 'done' : '',
          pendingReview ? 'is-pending-review' : '',
          actionableOverdue ? 'is-overdue' : '',
          hasStatusBadges ? 'has-status' : 'no-status'
        ]
          .filter(Boolean)
          .join(' ')}
        key={task.id}
      >
        {showTaskCheck ? (
          <button
            type="button"
            className={task.status === 'done' ? 'task-check checked' : 'task-check'}
            aria-label={task.status === 'done' ? '标记为待完成' : '标记为完成'}
            aria-pressed={task.status === 'done'}
            onClick={() => onToggle(task)}
          >
            <CheckCircle2 />
          </button>
        ) : (
          <span
            className={[
              'task-status-slot',
              pendingReview ? 'review' : '',
              actionableOverdue ? 'overdue' : '',
              task.status === 'todo' ? 'open' : ''
            ]
              .filter(Boolean)
              .join(' ')}
            aria-hidden="true"
          >
            {pendingReview || actionableOverdue || task.status === 'todo' ? (
              <span className="task-status-dot" />
            ) : null}
          </span>
        )}
        <button type="button" className="task-row-main b2-task-main" onClick={() => onOpen(task)}>
          <span className="task-row-title b2-task-title">{task.title}</span>
          <span className="task-row-meta b2-task-meta">
            {task.priority !== 'medium' ? (
              <span className={`priority-badge ${task.priority}`}>
                {priorityLabel(task.priority)}
              </span>
            ) : null}
            {course ? (
              <span
                className="course-chip"
                style={{ ['--chip-color' as string]: course.color }}
                title={courseDisplayLabel(course)}
              >
                {courseDisplayLabel(course)}
              </span>
            ) : (
              <span>未关联课程</span>
            )}
            <span className="dot-separator" />
            <span>{TASK_KIND_LABEL[task.kind]}</span>
            {scoreView.state === 'graded' ? (
              <span
                className="n7-row-score"
                data-score-state={scoreView.state}
                title={`平台成绩：${scoreView.text}`}
              >
                {scoreView.text}
              </span>
            ) : null}
            {feedbackPreview ? (
              <span className="n7-row-feedback" title={feedbackPreview}>
                <MessageSquareText size={11} aria-hidden="true" />
                <span>{feedbackPreview}</span>
              </span>
            ) : null}
            {task.attachments.length > 0 ? (
              <span className="b2-attachment-count" title={`${task.attachments.length} 个附件`}>
                <Paperclip size={11} aria-hidden="true" /> {task.attachments.length}
              </span>
            ) : null}
            {task.reminders.filter((rule) => rule.enabled).length > 0 ? (
              <span className="reminder-count">
                <Bell /> {task.reminders.filter((rule) => rule.enabled).length}
              </span>
            ) : null}
          </span>
        </button>
        <span className="b2-task-due">
          {dueLabel ? (
            <>
              <span className={actionableOverdue ? 'b2-due-value overdue' : 'b2-due-value'}>
                {dueLabel}
              </span>
              {dueCaption ? <span className="b2-due-caption">{dueCaption}</span> : null}
            </>
          ) : (
            <span className="b2-due-caption">无截止时间</span>
          )}
        </span>
        <span className="b2-task-status">
          {platformLabel ? (
            <Badge
              tone={platformStatusTone(platformClass ?? 'unknown')}
              className={`platform-tag ${platformClass ?? 'unknown'}`}
            >
              {pendingReview ? <Clock3 size={11} /> : null}
              {platformLabel}
            </Badge>
          ) : null}
          {showLocalPill && platform ? (
            <Badge tone={task.status === 'done' ? 'success' : 'danger'} className="b2-local-badge">
              {localLabel}
            </Badge>
          ) : null}
        </span>
        <div className="task-row-actions">
          {(() => {
            const portalAction = getTaskPortalAction(task, course)
            if (!onOpenInPortal || (!isPlatformTask(task) && !portalAction.target)) return null
            return (
              <button
                type="button"
                className={
                  portalAction.kind === 'answer'
                    ? 'today-go-btn'
                    : portalAction.disabled
                      ? 'today-go-btn subtle is-disabled'
                      : 'today-go-btn subtle'
                }
                onClick={() => onOpenInPortal(task)}
                disabled={portalAction.disabled}
                aria-disabled={portalAction.disabled}
                title={portalAction.title}
              >
                {portalAction.label} <ExternalLink size={11} />
              </button>
            )
          })()}
          <button
            type="button"
            className="task-row-action"
            onClick={() => onEdit(task)}
            aria-label="编辑任务"
          >
            <Pencil />
          </button>
          <button
            type="button"
            className="task-row-action danger"
            onClick={() => onDelete(task)}
            disabled={task.source === 'chaoxing'}
            title={
              task.source === 'chaoxing'
                ? '平台任务不能本地删除，请在平台处理或保留记录'
                : '删除任务'
            }
            aria-label={task.source === 'chaoxing' ? '平台任务不能本地删除' : '删除任务'}
          >
            <Trash2 />
          </button>
        </div>
      </div>
    )
  }

  const tabs: Array<{ value: TaskFilter; label: string; count: number }> = [
    { value: 'all', label: '全部', count: counts.all },
    { value: 'todo', label: '待完成', count: counts.todo },
    { value: 'review', label: '待审核', count: counts.review },
    { value: 'submitted', label: '已提交', count: counts.submitted },
    { value: 'reviewed', label: '已批阅', count: counts.reviewed },
    { value: 'done', label: '已完成', count: counts.done }
  ]

  const lastCompleteSyncAt =
    syncStatus && chaoxing
      ? resolveLastCompleteSyncAt(syncStatus, chaoxing)
      : (dataUpdatedAt ?? null)
  const syncIssueDetail = summarizeSyncIssueDetail(
    autoSyncError ?? syncStatus?.detail ?? chaoxing?.lastOutcomeDetail ?? chaoxing?.detail,
    100
  )
  const syncState = syncStatus?.state ?? null
  const isSyncing = syncState === 'syncing'
  const syncFailed = !isSyncing && (syncState === 'failure' || Boolean(autoSyncError))
  const syncPartial = !isSyncing && !syncFailed && syncState === 'partial'
  const syncExpired = !isSyncing && !syncFailed && chaoxing?.authState === 'expired'
  const syncStale =
    !isSyncing &&
    !syncFailed &&
    !syncPartial &&
    !syncExpired &&
    authenticated &&
    isDataFreshnessStale(lastCompleteSyncAt, autoRefreshMinutes)
  const securityBlocked = isSecurityBlockedMessage(
    autoSyncError ?? syncStatus?.message ?? chaoxing?.message,
    syncIssueDetail
  )

  return (
    <div
      className={
        hubView === 'records' || hubView === 'exams'
          ? 'studio-page studio-records-wrap'
          : 'studio-page tasks-page b2-tasks-page'
      }
    >
      <header className="studio-page-head">
        <div className="studio-tasks-title-group">
          <h1 className="page-title">作业</h1>
          <div className="segmented" role="tablist" aria-label="作业视图切换">
            <button
              type="button"
              role="tab"
              aria-selected={hubView === 'list'}
              className={hubView === 'list' ? 'active' : ''}
              onClick={() => setHubView('list')}
            >
              作业清单
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={hubView === 'records'}
              className={hubView === 'records' ? 'active' : ''}
              onClick={() => setHubView('records')}
            >
              成绩与批语
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={hubView === 'exams'}
              className={hubView === 'exams' ? 'active' : ''}
              onClick={() => setHubView('exams')}
            >
              考试安排{exams.length > 0 ? ` (${exams.length})` : ''}
            </button>
          </div>
          {hubView === 'list' && overdueCount > 0 ? (
            <button
              type="button"
              className="studio-overdue-hint"
              aria-pressed={deadlineFilter === 'overdue'}
              onClick={() => toggleDeadlineFilter('overdue')}
              title="点击直接筛选已逾期的未提交任务"
            >
              已逾期 {overdueCount}
            </button>
          ) : null}
          {hubView === 'list' &&
          lastCompleteSyncAt &&
          !syncFailed &&
          !syncPartial &&
          !syncExpired ? (
            <span
              className={syncStale ? 'studio-freshness-pill warn' : 'studio-freshness-pill'}
              title={`上次完整同步：${formatDateTime(lastCompleteSyncAt)}`}
            >
              <Clock3 size={11} aria-hidden="true" />
              {syncStale
                ? `已过 ${relativeTime(lastCompleteSyncAt).replace(/前$/, '')}未更新`
                : `更新于 ${relativeTime(lastCompleteSyncAt)}`}
            </span>
          ) : null}
        </div>
        {hubView === 'list' ? (
          <div className="header-actions">
            {onQuickSync && authenticated ? (
              <Button variant="secondary" size="sm" onClick={onQuickSync} disabled={isSyncing}>
                <RefreshCw size={13} className={isSyncing ? 'spin' : undefined} />
                {isSyncing ? '同步中…' : '刷新作业'}
              </Button>
            ) : null}
            <Button variant="primary" size="sm" onClick={onCreate}>
              <Plus size={14} /> 新建任务
            </Button>
          </div>
        ) : null}
      </header>

      {hubView === 'list' && (syncFailed || syncPartial || syncExpired || syncStale) ? (
        <div
          className={`today-sync-strip tone-${syncFailed ? 'danger' : 'warning'}`}
          role={syncFailed ? 'alert' : 'status'}
        >
          <div className="today-sync-strip-main">
            <span className="today-sync-strip-icon" aria-hidden="true">
              {syncStale ? <Clock3 size={14} /> : <AlertTriangle size={14} />}
            </span>
            <strong className="today-sync-strip-label">
              {syncFailed
                ? '最近同步失败，作业列表可能不是最新'
                : syncPartial
                  ? '部分平台数据未更新'
                  : syncExpired
                    ? '学习通登录已过期'
                    : '作业列表已较久未同步'}
            </strong>
            <span className="today-sync-strip-detail">
              {syncFailed
                ? `${syncIssueDetail ? `${syncIssueDetail} · ` : ''}${lastCompleteSyncAt ? `保留上次完整同步（${formatDateTime(lastCompleteSyncAt)}）` : '尚未完成过完整同步'}`
                : syncPartial
                  ? `${syncIssueDetail ? `${syncIssueDetail} · ` : ''}${lastCompleteSyncAt ? `上次完整同步：${formatDateTime(lastCompleteSyncAt)}` : '请以学习通官方页面为准'}`
                  : syncExpired
                    ? '本地已有作业仍可查看，重新登录后可恢复实时同步'
                    : lastCompleteSyncAt
                      ? `上次完整同步于 ${formatDateTime(lastCompleteSyncAt)}，可能已有新作业或截止调整`
                      : ''}
            </span>
          </div>
          <div className="today-sync-strip-actions">
            {securityBlocked && onOpenChaoxingHome ? (
              <button type="button" className="studio-strip-cta" onClick={onOpenChaoxingHome}>
                去学习通处理验证
              </button>
            ) : syncExpired && onConnectChaoxing ? (
              <button type="button" className="studio-strip-cta" onClick={onConnectChaoxing}>
                重新登录
              </button>
            ) : onQuickSync ? (
              <button
                type="button"
                className="text-link"
                onClick={onQuickSync}
                disabled={isSyncing}
              >
                {syncFailed ? '重试同步' : '立即同步'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {hubView === 'records' ? (
        <Records
          tasks={tasks}
          courses={courses}
          dataUpdatedAt={lastCompleteSyncAt}
          onOpenTask={onOpen}
          onOpenInPortal={onOpenInPortal ?? onOpen}
          embedded
        />
      ) : hubView === 'exams' ? (
        <Exams
          exams={exams}
          courses={courses}
          authenticated={authenticated}
          {...(onConnectChaoxing ? { onConnectChaoxing } : {})}
          embedded
          onOpenCourse={(course) => onOpenCourse?.(course)}
        />
      ) : (
        <>
          {tasks.length > 0 ? (
            <section className="n7-ddl-strip" aria-label="截止时间规划">
              <div className="n7-ddl-top">
                <div className="n7-ddl-pills" role="group" aria-label="按截止时间筛选">
                  <button
                    type="button"
                    className={[
                      'n7-ddl-pill',
                      'tone-danger',
                      deadlineFilter === 'overdue' ? 'active' : '',
                      workflowSummary.overdueActionable === 0 && deadlineFilter !== 'overdue'
                        ? 'is-zero'
                        : ''
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    aria-pressed={deadlineFilter === 'overdue'}
                    onClick={() => toggleDeadlineFilter('overdue')}
                  >
                    <span>已逾期</span>
                    <strong>{workflowSummary.overdueActionable}</strong>
                  </button>
                  <button
                    type="button"
                    className={[
                      'n7-ddl-pill',
                      'tone-warning',
                      deadlineFilter === 'today' ? 'active' : '',
                      workflowSummary.dueTodayActionable === 0 && deadlineFilter !== 'today'
                        ? 'is-zero'
                        : ''
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    aria-pressed={deadlineFilter === 'today'}
                    onClick={() => toggleDeadlineFilter('today')}
                  >
                    <span>今天截止</span>
                    <strong>{workflowSummary.dueTodayActionable}</strong>
                  </button>
                  <button
                    type="button"
                    className={[
                      'n7-ddl-pill',
                      'tone-accent',
                      deadlineFilter === 'three_days' ? 'active' : '',
                      workflowSummary.dueThreeDaysActionable === 0 &&
                      deadlineFilter !== 'three_days'
                        ? 'is-zero'
                        : ''
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    aria-pressed={deadlineFilter === 'three_days'}
                    onClick={() => toggleDeadlineFilter('three_days')}
                  >
                    <span>3 天内</span>
                    <strong>{workflowSummary.dueThreeDaysActionable}</strong>
                  </button>
                  <button
                    type="button"
                    className={[
                      'n7-ddl-pill',
                      deadlineFilter === 'week' ? 'active' : '',
                      workflowSummary.dueWeekActionable === 0 && deadlineFilter !== 'week'
                        ? 'is-zero'
                        : ''
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    aria-pressed={deadlineFilter === 'week'}
                    onClick={() => toggleDeadlineFilter('week')}
                  >
                    <span>7 天内</span>
                    <strong>{workflowSummary.dueWeekActionable}</strong>
                  </button>
                  {workflowSummary.noDueActionable > 0 ? (
                    <button
                      type="button"
                      className={deadlineFilter === 'no_due' ? 'n7-ddl-pill active' : 'n7-ddl-pill'}
                      aria-pressed={deadlineFilter === 'no_due'}
                      onClick={() => toggleDeadlineFilter('no_due')}
                    >
                      <span>无截止</span>
                      <strong>{workflowSummary.noDueActionable}</strong>
                    </button>
                  ) : null}
                </div>
                {workflowSummary.gradedCount > 0 || workflowSummary.withFeedbackCount > 0 ? (
                  <button
                    type="button"
                    className="n7-ddl-shortcut"
                    onClick={() => setHubView('records')}
                  >
                    查看成绩与批语（{workflowSummary.gradedCount} 已出分
                    {workflowSummary.withFeedbackCount > 0
                      ? ` · ${workflowSummary.withFeedbackCount} 批语`
                      : ''}
                    ）
                  </button>
                ) : null}
              </div>

              {workflowSummary.nextUrgentTask
                ? (() => {
                    const nextTask = workflowSummary.nextUrgentTask
                    const nextCourse = nextTask.courseId ? courseById.get(nextTask.courseId) : null
                    const nextOverdue = isTaskActionableOverdue(nextTask, now)
                    const nextDueLabel = formatDueAt(nextTask.dueAt)
                    const nextRemaining = nextDueLabel
                      ? formatRemainingCompact(nextTask.dueAt, now)
                      : '无截止时间'
                    const nextPortal = getTaskPortalAction(nextTask, nextCourse)
                    return (
                      <div className="n7-ddl-next">
                        <div className="n7-ddl-next-main">
                          <span
                            className={
                              nextOverdue ? 'n7-ddl-next-tag is-overdue' : 'n7-ddl-next-tag'
                            }
                          >
                            {nextOverdue ? '优先补交' : '下一步优先'}
                          </span>
                          {nextCourse ? (
                            <span
                              className="today-course-dot"
                              style={{ backgroundColor: nextCourse.color }}
                              aria-hidden="true"
                            />
                          ) : null}
                          <button
                            type="button"
                            className="n7-ddl-next-title"
                            onClick={() => onOpen(nextTask)}
                            title={nextTask.title}
                          >
                            {nextTask.title}
                          </button>
                          <span
                            className={
                              nextOverdue ? 'n7-ddl-next-meta is-overdue' : 'n7-ddl-next-meta'
                            }
                          >
                            {nextCourse ? `${courseDisplayLabel(nextCourse)} · ` : ''}
                            {nextRemaining}
                          </span>
                        </div>
                        <div className="n7-ddl-next-actions">
                          <Button variant="secondary" size="sm" onClick={() => onOpen(nextTask)}>
                            详情
                          </Button>
                          {onOpenInPortal && (isPlatformTask(nextTask) || nextPortal.target) ? (
                            <button
                              type="button"
                              className={
                                nextPortal.kind === 'answer'
                                  ? 'today-go-btn'
                                  : nextPortal.disabled
                                    ? 'today-go-btn subtle is-disabled'
                                    : 'today-go-btn subtle'
                              }
                              onClick={() => onOpenInPortal(nextTask)}
                              disabled={nextPortal.disabled}
                              aria-disabled={nextPortal.disabled}
                              title={nextPortal.title}
                            >
                              {nextPortal.label} <ExternalLink size={11} />
                            </button>
                          ) : null}
                        </div>
                      </div>
                    )
                  })()
                : null}
            </section>
          ) : null}

          <section className="card b2-task-toolbar" aria-label="任务筛选">
            <div className="b2-status-tabs" role="group" aria-label="按状态筛选">
              {tabs.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  className={[
                    status === tab.value ? 'active' : '',
                    tab.count === 0 && status !== tab.value ? 'is-zero' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-pressed={status === tab.value}
                  onClick={() => selectStatusFilter(tab.value)}
                >
                  <span>{tab.label}</span>
                  <span className="b2-tab-count">{tab.count}</span>
                </button>
              ))}
            </div>
            <div className="b2-task-filters">
              <label className="search-box">
                <Search />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索任务标题或备注"
                  aria-label="搜索任务"
                />
              </label>
              <select
                className="select"
                value={courseId}
                onChange={(event) => setCourseId(event.target.value)}
                aria-label="按课程筛选"
              >
                <option value="all">全部课程</option>
                {courses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {courseDisplayLabel(course)}
                  </option>
                ))}
              </select>
              <select
                className="select"
                value={priority}
                onChange={(event) => setPriority(event.target.value as TaskPriority | 'all')}
                aria-label="按优先级筛选"
              >
                <option value="all">全部优先级</option>
                <option value="high">高优先级</option>
                <option value="medium">普通</option>
                <option value="low">低优先级</option>
              </select>
              <select
                className="select"
                value={sortMode}
                onChange={(event) => setSortMode(event.target.value as SortMode)}
                aria-label="排序方式"
              >
                <option value="due">按 DDL 排序</option>
                <option value="priority">按优先级排序</option>
                <option value="created">按创建时间排序</option>
              </select>
              {hasActiveFilters ? (
                <button type="button" className="n7-reset-filters" onClick={resetAllFilters}>
                  <RotateCcw size={12} /> 重置筛选
                </button>
              ) : null}
            </div>
          </section>

          <div className="card task-page-list b2-task-list">
            {filtered.length === 0 ? (
              <EmptyState
                icon={<CalendarDays size={18} />}
                title="没有符合条件的任务"
                description="试试清除搜索或筛选条件，也可以新建一个任务来开始。"
                action={
                  <Button variant="secondary" size="sm" onClick={resetAllFilters}>
                    清除筛选
                  </Button>
                }
              />
            ) : groups ? (
              groups.map((group) => (
                <div
                  key={group.bucket}
                  className={[
                    'task-group',
                    'b2-task-group',
                    group.bucket === 'review' ? 'review-group' : '',
                    group.bucket === 'overdue' ? 'overdue-group' : '',
                    group.bucket === 'done' ? 'done-group' : '',
                    ['today', 'soon', 'upcoming'].includes(group.bucket) ? 'open-group' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <div className="group-title b2-group-title">
                    <span>{group.label}</span>
                    <span className="b2-group-count">{group.items.length}</span>
                  </div>
                  {group.items.map(renderRow)}
                </div>
              ))
            ) : (
              filtered.map(renderRow)
            )}
          </div>
        </>
      )}
    </div>
  )
}
