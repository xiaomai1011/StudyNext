import { useEffect, useMemo, useState, type CSSProperties, type JSX } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  BellRing,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  Circle,
  Clock3,
  CloudOff,
  ExternalLink,
  LogIn,
  MapPin,
  Megaphone,
  Plus,
  RefreshCw
} from 'lucide-react'
import type {
  AppNotice,
  ChaoxingSessionStatus,
  Course,
  Exam,
  NavigateTarget,
  SyncStatus,
  Task
} from '@shared/types'
import { dueBucket, formatRemainingCompact } from '@shared/domain'
import { TASK_KIND_LABEL } from '@shared/constants'
import { getTaskPortalAction, getTaskStatusView, isPlatformTask } from '@shared/task-state'
import { getSemesterWindow } from '@shared/semesters'
import {
  dashboardOpenCandidates,
  dashboardOverdueCount,
  dashboardPendingReviewCount,
  dashboardPreviewTasks,
  dashboardReviewTasks
} from '@shared/dashboard-tasks'
import { getDashboardEmptyCopy, type DashboardDataCondition } from '@shared/dashboard-empty'
import {
  isDataFreshnessStale,
  isSecurityBlockedMessage,
  resolveLastCompleteSyncAt,
  summarizeSyncIssueDetail
} from '@shared/sync-feedback'
import {
  buildCourseDisplayMap,
  buildDaySessions,
  findNextUpcomingClass,
  getUpcomingDashboardExams,
  prioritizeDashboardNotices,
  selectCoursesActiveAt
} from '@shared/today-schedule'
import { formatDateTime, relativeTime } from '../lib/format'
import type { BadgeTone } from '../ui/primitives'
import { Badge, Button, EmptyState } from '../ui/primitives'
import { Calendar } from './Calendar'

interface DashboardProps {
  courses: Course[]
  tasks: Task[]
  exams?: Exam[]
  notices: AppNotice[]
  syncStatus: SyncStatus
  chaoxing: ChaoxingSessionStatus
  autoSyncError: string | null
  autoRefreshMinutes?: number
  weekStartsOn: 0 | 1
  onOpenTask: (task: Task) => void
  onOpenTaskInPortal: (task: Task) => void
  onOpenCourse: (course: Course) => void
  onToggleTask: (task: Task) => void
  onCreateTask: () => void
  onQuickSync: () => void
  onConnectChaoxing?: () => void
  onOpenChaoxingHome: () => void
  onNavigate: (target: NavigateTarget) => void
}

const WEEKDAY_SHORT = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

function platformTone(kind: Task['platformStatusKind']): BadgeTone {
  switch (kind) {
    case 'pending_review':
      return 'warning'
    case 'submitted':
      return 'info'
    case 'reviewed':
    case 'done':
      return 'success'
    default:
      return 'neutral'
  }
}

function syncBannerTone(
  condition: DashboardDataCondition
): 'danger' | 'warning' | 'neutral' | 'info' {
  switch (condition) {
    case 'failure':
      return 'danger'
    case 'partial':
    case 'expired':
      return 'warning'
    case 'syncing':
      return 'info'
    default:
      return 'neutral'
  }
}

export function Dashboard({
  courses,
  tasks,
  exams = [],
  notices,
  syncStatus,
  chaoxing,
  autoSyncError,
  autoRefreshMinutes = 5,
  weekStartsOn,
  onOpenTask,
  onOpenTaskInPortal,
  onOpenCourse,
  onToggleTask,
  onCreateTask,
  onQuickSync,
  onConnectChaoxing,
  onOpenChaoxingHome,
  onNavigate
}: DashboardProps): JSX.Element {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const courseById = useMemo(() => new Map(courses.map((course) => [course.id, course])), [courses])

  const courseDisplayMap = useMemo(() => buildCourseDisplayMap(courses), [courses])

  const courseDisplay = (course: Course) =>
    courseDisplayMap.get(course.id) ?? {
      title: course.name,
      classTag: null,
      fullLabel: course.name
    }

  const courseLabel = (course: Course): string => courseDisplay(course).fullLabel

  const todayActiveCourses = useMemo(() => selectCoursesActiveAt(courses, now), [courses, now])

  const todayWeekday = now.getDay() === 0 ? 7 : now.getDay()
  const currentWeek = getSemesterWindow(todayActiveCourses, now).currentWeek

  const todaySessions = useMemo(
    () => buildDaySessions(todayActiveCourses, tasks, now, now),
    [todayActiveCourses, tasks, now]
  )

  const nextClass = useMemo(() => findNextUpcomingClass(courses, now, 7), [courses, now])

  const upcomingExams = useMemo(
    () => getUpcomingDashboardExams(exams, courses, now, { windowDays: 14, limit: 3 }),
    [exams, courses, now]
  )

  const openCandidates = useMemo(() => dashboardOpenCandidates(tasks, now), [tasks, now])
  const openTasks = useMemo(() => dashboardPreviewTasks(tasks, now, 6), [tasks, now])
  const openCount = openCandidates.length
  const overdueCount = useMemo(() => dashboardOverdueCount(tasks, now), [tasks, now])

  const reviewTasks = useMemo(() => dashboardReviewTasks(tasks), [tasks])
  const pendingReviewCount = useMemo(() => dashboardPendingReviewCount(tasks), [tasks])
  const visibleReviewTasks = reviewTasks.slice(0, 4)

  const prioritizedNotices = useMemo(() => prioritizeDashboardNotices(notices, 4), [notices])
  const recentNotices = prioritizedNotices.items
  const dateHeading = `${now.getMonth() + 1}月${now.getDate()}日 · ${WEEKDAY_SHORT[todayWeekday]}`
  const isSyncing = syncStatus.state === 'syncing'
  const authenticated = chaoxing.authState === 'authenticated'

  const emptyContext = useMemo(
    () => ({ syncStatus, chaoxing, autoSyncError }),
    [syncStatus, chaoxing, autoSyncError]
  )
  const todoEmpty = useMemo(() => getDashboardEmptyCopy('todo', emptyContext), [emptyContext])
  const reviewEmpty = useMemo(() => getDashboardEmptyCopy('review', emptyContext), [emptyContext])
  const noticesEmpty = useMemo(() => getDashboardEmptyCopy('notices', emptyContext), [emptyContext])
  const dataCondition = todoEmpty.condition
  const lastCompleteSyncAt = resolveLastCompleteSyncAt(syncStatus, chaoxing)
  const syncIssueDetail = summarizeSyncIssueDetail(
    syncStatus.detail ?? chaoxing.lastOutcomeDetail ?? chaoxing.detail,
    110
  )
  const securityBlocked = isSecurityBlockedMessage(
    autoSyncError ?? syncStatus.message ?? chaoxing.message,
    syncIssueDetail
  )
  const isStaleSuccess =
    dataCondition === 'success' &&
    isDataFreshnessStale(lastCompleteSyncAt, autoRefreshMinutes, now.getTime())

  const showSyncStatusStrip =
    dataCondition === 'failure' ||
    dataCondition === 'partial' ||
    dataCondition === 'expired' ||
    dataCondition === 'not_connected' ||
    dataCondition === 'import' ||
    dataCondition === 'not_synced' ||
    dataCondition === 'unknown' ||
    isStaleSuccess

  const syncStripDetail = (() => {
    if (dataCondition === 'failure') {
      const reason = autoSyncError || syncIssueDetail || syncStatus.message
      const staleHint = lastCompleteSyncAt
        ? `保留上次完整同步数据（${formatDateTime(lastCompleteSyncAt)}），但可能不是最新`
        : '当前没有可确认的完整平台同步结果'
      return reason ? `${reason} · ${staleHint}` : staleHint
    }
    if (dataCondition === 'partial') {
      const baseHint = lastCompleteSyncAt
        ? `部分平台数据未更新（上次完整同步：${formatDateTime(lastCompleteSyncAt)}），旧数据仍可查看`
        : '部分平台数据未更新（尚未完成过完整同步），请以学习通为准'
      return syncIssueDetail ? `${syncIssueDetail} · ${baseHint}` : baseHint
    }
    if (dataCondition === 'expired') {
      return '学习通会话已失效；本地已有课程与任务仍可用，重新登录后恢复同步'
    }
    if (dataCondition === 'not_connected') {
      return '当前仅展示本地数据；登录学习通后可自动同步课程、作业、考试与通知'
    }
    if (dataCondition === 'import') {
      return '当前数据来自本地快照导入，不含实时平台状态'
    }
    if (dataCondition === 'not_synced') {
      return '学习通已连接，点击「立即同步」拉取最新课程、作业与通知'
    }
    if (isStaleSuccess && lastCompleteSyncAt) {
      return `上次完整同步于 ${formatDateTime(lastCompleteSyncAt)}（${relativeTime(lastCompleteSyncAt)}），可能已有新作业或截止变更`
    }
    return '当前仅展示本地已有记录，无法确认平台是否有新任务或状态变更'
  })()

  const liveClassBadge = nextClass ? (
    <button
      type="button"
      className={
        nextClass.kind === 'live'
          ? 'today-next-class-pill live'
          : nextClass.kind === 'upcoming_day'
            ? 'today-next-class-pill upcoming'
            : 'today-next-class-pill'
      }
      onClick={() => onOpenCourse(nextClass.course)}
    >
      <span className="today-next-class-dot" />
      {nextClass.kind === 'live'
        ? `上课中 ${nextClass.session.startTime}`
        : nextClass.kind === 'next_today'
          ? `下一节 ${nextClass.session.startTime}`
          : `下节 · ${nextClass.timeHint}`}{' '}
      · {courseLabel(nextClass.course)}
      {nextClass.session.location ? ` · ${nextClass.session.location}` : ''}
      {nextClass.kind !== 'upcoming_day' ? ` · ${nextClass.timeHint}` : ''}
    </button>
  ) : null

  const todoEmptyAction = (() => {
    if (
      dataCondition === 'failure' ||
      dataCondition === 'partial' ||
      dataCondition === 'not_synced'
    ) {
      return (
        <Button variant="secondary" size="sm" onClick={onQuickSync} disabled={isSyncing}>
          <RefreshCw size={13} className={isSyncing ? 'spin' : undefined} />
          {dataCondition === 'failure' ? '重试同步' : '立即同步'}
        </Button>
      )
    }
    if (dataCondition === 'not_connected' || dataCondition === 'expired') {
      return (
        <Button variant="secondary" size="sm" onClick={() => onNavigate('settings')}>
          连接学习通
        </Button>
      )
    }
    return (
      <Button variant="secondary" size="sm" onClick={() => onNavigate('courses')}>
        <BookOpen size={13} /> 进入课程空间
      </Button>
    )
  })()

  const todoEmptyIcon =
    dataCondition === 'failure' ? (
      <AlertTriangle size={18} />
    ) : dataCondition === 'not_connected' || dataCondition === 'expired' ? (
      <CloudOff size={18} />
    ) : dataCondition === 'partial' ||
      dataCondition === 'not_synced' ||
      dataCondition === 'unknown' ? (
      <Clock3 size={18} />
    ) : (
      <CheckCircle2 size={18} />
    )

  return (
    <div className="studio-page studio-today">
      <header className="today-hero">
        <div className="today-hero-copy">
          <div className="today-date-line">
            <h1 className="page-title today-title">{dateHeading}</h1>
            {currentWeek ? <span className="today-week-pill">第 {currentWeek} 周</span> : null}
          </div>
          <p className="today-summary">
            <span>
              {todaySessions.length > 0 ? `今日 ${todaySessions.length} 节课` : '今日无排课'}
            </span>
            <span className="today-summary-dot" aria-hidden="true">
              ·
            </span>
            <span className={openCount > 0 ? 'today-summary-strong' : undefined}>
              {openCount > 0 ? `${openCount} 项待交作业` : todoEmpty.summary}
            </span>
            {reviewTasks.length > 0 ? (
              <>
                <span className="today-summary-dot" aria-hidden="true">
                  ·
                </span>
                <span className="today-summary-review">
                  {pendingReviewCount > 0
                    ? `${pendingReviewCount} 项待审核`
                    : `${reviewTasks.length} 项已提交`}
                </span>
              </>
            ) : null}
            {upcomingExams.withinSevenDaysCount > 0 ? (
              <>
                <span className="today-summary-dot" aria-hidden="true">
                  ·
                </span>
                <span className="today-summary-exam">
                  {upcomingExams.ongoingCount > 0
                    ? `${upcomingExams.ongoingCount} 场考试进行中`
                    : `${upcomingExams.withinSevenDaysCount} 场近期考试`}
                </span>
              </>
            ) : null}
            {dataCondition === 'success' && lastCompleteSyncAt ? (
              <>
                <span className="today-summary-dot" aria-hidden="true">
                  ·
                </span>
                <span className="today-summary-muted">
                  已同步 {relativeTime(lastCompleteSyncAt)}
                </span>
              </>
            ) : null}
          </p>
        </div>

        <div className="today-hero-actions">
          {authenticated ? (
            <>
              <Button variant="secondary" size="sm" onClick={onQuickSync} disabled={isSyncing}>
                <RefreshCw size={13} className={isSyncing ? 'spin' : undefined} />
                {isSyncing ? '同步中…' : '立即同步'}
              </Button>
              <Button variant="secondary" size="sm" onClick={onOpenChaoxingHome}>
                <ExternalLink size={13} /> 学习通
              </Button>
            </>
          ) : null}
          <Button variant="primary" size="sm" onClick={onCreateTask}>
            <Plus size={13} /> 新建任务
          </Button>
        </div>
      </header>

      {showSyncStatusStrip ? (
        <div
          className={`today-sync-strip tone-${isStaleSuccess ? 'warning' : syncBannerTone(dataCondition)}`}
          role={dataCondition === 'failure' ? 'alert' : 'status'}
        >
          <div className="today-sync-strip-main">
            <span className="today-sync-strip-icon" aria-hidden="true">
              {dataCondition === 'failure' ||
              dataCondition === 'partial' ||
              dataCondition === 'expired' ? (
                <AlertTriangle size={14} />
              ) : isStaleSuccess ? (
                <Clock3 size={14} />
              ) : (
                <CloudOff size={14} />
              )}
            </span>
            <strong className="today-sync-strip-label">
              {isStaleSuccess ? '本地数据已较久未更新' : todoEmpty.summary}
            </strong>
            <span className="today-sync-strip-detail">{syncStripDetail}</span>
          </div>
          <div className="today-sync-strip-actions">
            {securityBlocked ? (
              <button type="button" className="studio-strip-cta" onClick={onOpenChaoxingHome}>
                <ExternalLink size={12} /> 去学习通处理验证
              </button>
            ) : dataCondition === 'not_connected' ||
              dataCondition === 'expired' ||
              (!authenticated && dataCondition === 'unknown') ? (
              <button
                type="button"
                className="studio-strip-cta"
                onClick={() => (onConnectChaoxing ? onConnectChaoxing() : onNavigate('settings'))}
              >
                <LogIn size={12} /> 登录学习通
              </button>
            ) : (
              <>
                {dataCondition === 'failure' || dataCondition === 'partial' ? (
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => onNavigate('settings')}
                  >
                    查看详情
                  </button>
                ) : null}
                <button
                  type="button"
                  className="text-link"
                  onClick={onQuickSync}
                  disabled={isSyncing}
                >
                  {dataCondition === 'failure' ? '重试同步' : '立即同步'} <ArrowRight size={12} />
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}

      {todaySessions.length > 0 ? (
        <section className="today-classes-ribbon" aria-label="今日排课">
          <div className="today-ribbon-label">
            <span className="today-ribbon-kicker">今日课程</span>
            <span className="today-ribbon-count">{todaySessions.length} 节</span>
          </div>
          <div className="today-ribbon-cards">
            {todaySessions.map(({ course, session, state, timeHint, pendingTaskCount }) => {
              const identity = courseDisplay(course)
              return (
                <button
                  key={session.id}
                  type="button"
                  className={`today-ribbon-card is-${state}`}
                  style={{ '--course-color': course.color } as CSSProperties}
                  onClick={() => onOpenCourse(course)}
                  title={identity.fullLabel}
                >
                  <span className="today-ribbon-card-top">
                    <span className="today-ribbon-time">
                      {session.startTime}–{session.endTime}
                    </span>
                    <span className={`today-ribbon-state ${state}`}>{timeHint}</span>
                  </span>
                  <span className="today-ribbon-name">
                    <span
                      className="today-course-dot"
                      style={{ background: course.color }}
                      aria-hidden="true"
                    />
                    <span>{identity.title}</span>
                  </span>
                  {identity.classTag ? (
                    <span className="today-class-tag">{identity.classTag}</span>
                  ) : null}
                  <span className="today-ribbon-foot">
                    <span className="today-ribbon-place">
                      <MapPin size={11} aria-hidden="true" />
                      <span>{session.location || '地点待确认'}</span>
                    </span>
                    {pendingTaskCount > 0 ? (
                      <span className="today-ribbon-pending">{pendingTaskCount} 项待交</span>
                    ) : null}
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      ) : null}

      <div className="today-grid today-grid-compact">
        <section className="today-column today-work-col" aria-label="待交作业与等待批阅">
          <div className="studio-section-head">
            <div className="studio-section-title">
              <h2>待交作业</h2>
              {openCount > 0 ? <span className="studio-count-pill">{openCount}</span> : null}
              {overdueCount > 0 ? (
                <span className="studio-count-pill overdue" title="待交作业中包含的已逾期数量">
                  逾期 {overdueCount}
                </span>
              ) : null}
            </div>
            <button type="button" className="text-link" onClick={() => onNavigate('tasks')}>
              全部作业与成绩 <ArrowRight size={12} />
            </button>
          </div>

          <div className="today-work-list">
            {openTasks.length === 0 ? (
              <div className={`today-clear-state tone-${syncBannerTone(dataCondition)}`}>
                <EmptyState
                  compact
                  icon={todoEmptyIcon}
                  title={todoEmpty.title}
                  description={todoEmpty.description}
                  action={todoEmptyAction}
                />
              </div>
            ) : (
              openTasks.map((task) => {
                const course = task.courseId ? courseById.get(task.courseId) : null
                const bucket = dueBucket(task, now)
                const dueMs = new Date(task.dueAt).getTime() - now.getTime()
                const isUrgentToday =
                  bucket === 'today' &&
                  Number.isFinite(dueMs) &&
                  dueMs > 0 &&
                  dueMs <= 6 * 3_600_000
                const statusView = getTaskStatusView(task, now)
                const portalAction = getTaskPortalAction(task, course)
                const showPortalAction = isPlatformTask(task) || portalAction.target !== null
                const portalClass =
                  portalAction.kind === 'answer'
                    ? 'today-go-btn'
                    : portalAction.disabled
                      ? 'today-go-btn subtle is-disabled'
                      : 'today-go-btn subtle'
                return (
                  <div
                    className={`today-task-row${bucket === 'overdue' ? ' is-overdue' : isUrgentToday ? ' is-urgent' : ''}`}
                    key={task.id}
                  >
                    {statusView.canToggleLocal ? (
                      <button
                        type="button"
                        className="task-check"
                        aria-label="标记为完成"
                        onClick={() => onToggleTask(task)}
                      >
                        <CheckCircle2 />
                      </button>
                    ) : (
                      <span
                        className="task-check is-static"
                        title="学习通作业状态由平台同步"
                        aria-label="学习通作业"
                      >
                        <Circle />
                      </span>
                    )}

                    <button
                      type="button"
                      className="today-task-main"
                      onClick={() => onOpenTask(task)}
                    >
                      <span className="today-task-title">{task.title}</span>
                      <span className="today-task-meta">
                        {course ? (
                          <span
                            className="today-course-dot"
                            style={{ background: course.color }}
                            aria-hidden="true"
                          />
                        ) : null}
                        <span>
                          {course ? courseLabel(course) : '本地任务'} · {TASK_KIND_LABEL[task.kind]}
                        </span>
                      </span>
                    </button>

                    <div className="today-task-tail">
                      <span className={`studio-due-pill ${isUrgentToday ? 'urgent' : bucket}`}>
                        {formatRemainingCompact(task.dueAt, now)}
                      </span>
                      {showPortalAction ? (
                        <button
                          type="button"
                          className={portalClass}
                          onClick={() => onOpenTaskInPortal(task)}
                          disabled={portalAction.disabled}
                          aria-disabled={portalAction.disabled}
                          title={portalAction.title}
                        >
                          {portalAction.label} <ExternalLink size={11} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {reviewTasks.length > 0 ? (
            <div className="today-review-block" aria-label="已提交待审核">
              <div className="studio-section-head today-review-head">
                <div className="studio-section-title today-review-title-group">
                  <span className="today-review-indicator" aria-hidden="true" />
                  <span className="today-review-heading">
                    <h3>等待批阅</h3>
                    <span className="today-review-heading-note">已提交 · 等待老师处理</span>
                  </span>
                  {pendingReviewCount > 0 ? (
                    <span
                      className="today-review-pending"
                      aria-label={`${pendingReviewCount} 项待审核`}
                    >
                      <strong>{pendingReviewCount}</strong>
                      <span>项待审核</span>
                    </span>
                  ) : null}
                  <span className="studio-count-pill review" title="已提交和待审核总数">
                    {reviewTasks.length} 项
                  </span>
                </div>
                <button type="button" className="text-link" onClick={() => onNavigate('records')}>
                  查看全部提交 <ArrowRight size={12} />
                </button>
              </div>
              <div className="today-review-list">
                {visibleReviewTasks.map((task) => {
                  const course = task.courseId ? courseById.get(task.courseId) : null
                  const isPending = task.platformStatusKind === 'pending_review'
                  return (
                    <button
                      key={task.id}
                      type="button"
                      className={`today-review-row${isPending ? ' is-pending' : ''}`}
                      onClick={() => onOpenTask(task)}
                    >
                      <span
                        className="today-course-dot"
                        style={{ background: course?.color ?? 'var(--ds-warning)' }}
                        aria-hidden="true"
                      />
                      <span className="today-review-copy">
                        <span className="today-review-title">{task.title}</span>
                        <span className="today-review-course">
                          {course ? courseLabel(course) : '未关联课程'}
                        </span>
                      </span>
                      <Badge
                        tone={platformTone(task.platformStatusKind)}
                        className={`today-review-badge platform-tag ${task.platformStatusKind}`}
                      >
                        <Clock3 size={11} aria-hidden="true" />
                        {getTaskStatusView(task, now).platformLabel}
                      </Badge>
                    </button>
                  )
                })}
              </div>
            </div>
          ) : dataCondition === 'failure' ||
            dataCondition === 'partial' ||
            dataCondition === 'expired' ? (
            <div className="today-review-uncertain">
              <Clock3 size={13} aria-hidden="true" />
              <span>
                {reviewEmpty.title}：{reviewEmpty.description}
              </span>
            </div>
          ) : null}
        </section>

        <aside className="today-column today-side-col" aria-label="近期考试与最新通知">
          {upcomingExams.items.length > 0 ? (
            <div
              className={`today-side-block today-exam-block${upcomingExams.ongoingCount > 0 ? ' has-ongoing' : ''}`}
              aria-label="近期考试"
            >
              <div className="studio-section-head">
                <div className="studio-section-title">
                  <CalendarClock size={13} aria-hidden="true" />
                  <h2>近期考试</h2>
                  <span className="studio-count-pill">{upcomingExams.items.length}</span>
                </div>
                <button
                  type="button"
                  className="today-exam-all-link"
                  onClick={() => onNavigate('exams')}
                >
                  全部考试 <ArrowRight size={12} />
                </button>
              </div>
              <div className="today-exam-list">
                {upcomingExams.items.map(({ exam, bucket, course, countdownLabel }) => (
                  <button
                    key={exam.id}
                    type="button"
                    className="today-exam-row"
                    onClick={() => (course ? onOpenCourse(course) : onNavigate('exams'))}
                    title={course ? `进入课程「${course.name}」` : '查看考试安排'}
                  >
                    <span className="today-exam-copy">
                      <span className="today-exam-title">{exam.title}</span>
                      <span className="today-exam-meta">
                        {exam.courseName || '课程未标注'}
                        {exam.startAt ? ` · ${formatDateTime(exam.startAt)}` : ''}
                      </span>
                    </span>
                    <span className={`today-exam-pill${bucket === 'ongoing' ? ' is-ongoing' : ''}`}>
                      {countdownLabel}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="today-side-block">
            <div className="studio-section-head">
              <div className="studio-section-title">
                <h2>最新通知</h2>
                {prioritizedNotices.unreadCount > 0 ? (
                  <span className="today-notice-unread-pill">
                    未读 {prioritizedNotices.unreadCount}
                  </span>
                ) : null}
              </div>
              <button type="button" className="text-link" onClick={() => onNavigate('notices')}>
                收件箱 <ArrowRight size={12} />
              </button>
            </div>

            {recentNotices.length > 0 && recentNotices.every((notice) => notice.isDemo) ? (
              <p className="today-notice-provenance">本地演示通知，不代表学习通平台数据</p>
            ) : null}

            {recentNotices.length === 0 ? (
              <div className="today-notice-empty">
                <BellRing size={15} aria-hidden="true" />
                <div className="today-notice-empty-copy">
                  <strong>{noticesEmpty.title}</strong>
                  <span>{noticesEmpty.description}</span>
                </div>
              </div>
            ) : (
              <div className="today-notice-list">
                {recentNotices.map((notice) => (
                  <button
                    key={notice.id}
                    type="button"
                    className="today-notice-row notice-item"
                    aria-label={`查看通知：${notice.title}`}
                    onClick={() => onNavigate('notices')}
                  >
                    <span className="today-notice-icon" aria-hidden="true">
                      <Megaphone size={12} />
                    </span>
                    <span className="today-notice-main">
                      <span className="today-notice-title">
                        {notice.read === false ? <span className="today-unread-dot" /> : null}
                        {notice.title}
                      </span>
                      <span className="today-notice-meta">
                        <Clock3 size={10} />
                        {relativeTime(notice.publishedAt)} ·{' '}
                        {notice.isDemo
                          ? '演示通知'
                          : notice.courseName || notice.sender || '学习通'}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>

      <Calendar
        embedded
        tasks={tasks}
        courses={courses}
        exams={exams}
        now={now}
        weekStartsOn={weekStartsOn}
        headerBadge={liveClassBadge}
        onOpenTask={onOpenTask}
        onOpenTaskInPortal={onOpenTaskInPortal}
        onOpenCourse={onOpenCourse}
        onNavigateExams={() => onNavigate('exams')}
      />
    </div>
  )
}
