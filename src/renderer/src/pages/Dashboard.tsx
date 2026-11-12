import { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  CircleCheckBig,
  Clock3,
  Database,
  GraduationCap,
  ListChecks,
  Megaphone,
  Sparkles
} from 'lucide-react'
import type { AppNotice, Course, DataSource, SyncStatus, Task } from '@shared/types'
import type { NavigateTarget } from '@shared/types'
import {
  computeTaskStats,
  dedupeCourseSessions,
  dueBucket,
  formatRemainingCompact,
  isSameLocalDay,
  semesterWeekOf,
  sortTasksByDue,
  weekInSchedule
} from '@shared/domain'
import { TASK_KIND_LABEL } from '@shared/constants'
import { courseInitial, formatDateTime, formatTime, relativeTime } from '../lib/format'

interface DashboardProps {
  courses: Course[]
  tasks: Task[]
  notices: AppNotice[]
  syncStatus: SyncStatus
  onOpenTask: (task: Task) => void
  onToggleTask: (task: Task) => void
  onNavigate: (target: NavigateTarget) => void
}

const NOTICE_ICON = {
  course: BookOpen,
  system: Sparkles,
  notice: Megaphone
} as const

function sourceLabel(source: DataSource | null): string {
  if (source === 'demo') return '本地演示数据'
  if (source === 'import') return '本地学习快照'
  if (source === 'chaoxing') return '学习通 Web Session'
  if (source === 'manual') return '手动录入'
  return '尚未连接外部数据源'
}

export function Dashboard({
  courses,
  tasks,
  notices,
  syncStatus,
  onOpenTask,
  onToggleTask,
  onNavigate
}: DashboardProps) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const visibleTasks = useMemo(
    () => tasks.filter((task) => !(task.status === 'todo' && dueBucket(task, new Date()) === 'overdue')),
    [tasks]
  )
  const stats = useMemo(() => computeTaskStats(visibleTasks, now), [visibleTasks, now])
  const todayTasks = useMemo(
    () =>
      sortTasksByDue(
        visibleTasks.filter((task) => task.status === 'todo')
      ).slice(0, 6),
    [visibleTasks]
  )
  const upcoming = useMemo(
    () =>
      sortTasksByDue(
        visibleTasks.filter((task) => {
          if (task.status === 'done') return false
          const due = new Date(task.dueAt).getTime()
          return due >= now.getTime() && due <= now.getTime() + 7 * 86_400_000
        })
      ).slice(0, 5),
    [visibleTasks, now]
  )
  const courseById = useMemo(() => new Map(courses.map((course) => [course.id, course])), [courses])
  const weekday = now.getDay() === 0 ? 7 : now.getDay()
  const semesterStart = courses[0]?.semesterStart ?? null
  const maxWeek = courses[0]?.maxWeek ?? 0
  const currentWeek = semesterWeekOf(now, semesterStart)
  const todaySessions = useMemo(
    () =>
      dedupeCourseSessions(
        courses.flatMap((course) =>
          course.schedule
            .filter(
              (session) =>
                session.weekday === weekday &&
                (currentWeek === null ||
                  ((maxWeek === 0 || (currentWeek >= 1 && currentWeek <= maxWeek)) &&
                    weekInSchedule(session.weeks, currentWeek)))
            )
            .map((session) => ({ course, session }))
        )
      ).sort((a, b) => a.session.startTime.localeCompare(b.session.startTime)),
    [courses, weekday, currentWeek, maxWeek]
  )
  const greeting =
    now.getHours() < 6
      ? '夜深了'
      : now.getHours() < 12
        ? '早上好'
        : now.getHours() < 18
          ? '下午好'
          : '晚上好'
  const recentNotices = notices.slice(0, 4)
  const completionDelta =
    stats.open === 0 && stats.total > 0 ? '所有任务均已处理' : `还有 ${stats.open} 项待完成`

  return (
    <div className="page">
      <div className="dashboard-hero">
        <div>
          <div className="greeting">{greeting}，今天也按自己的节奏来。</div>
          <h1 className="page-title">学习总览</h1>
          <p className="page-subtitle">课程、作业和截止时间汇聚在一处。当前数据来自本地数据库。</p>
        </div>
        <div className="hero-note" title={`数据源：${sourceLabel(syncStatus.source)}`}>
          <Database size={14} />
          <span>
            {syncStatus.lastSuccessAt
              ? `${syncStatus.source === 'import' ? '最近导入' : '最近同步'} ${formatDateTime(syncStatus.lastSuccessAt)}`
              : '尚未同步外部数据'}{' '}
            · {sourceLabel(syncStatus.source)}
          </span>
        </div>
      </div>

      <div className="metric-grid">
        <article className="card metric-card warning">
          <div className="metric-label">
            <span className="metric-icon">
              <CalendarClock />
            </span>
            未完成任务
          </div>
          <div className="metric-value">
            {stats.open}
            <span className="metric-suffix">项</span>
          </div>
          <div className="metric-foot">
            {stats.overdue > 0 ? `其中 ${stats.overdue} 项已逾期` : '已逾期任务不在此列出'}
          </div>
        </article>

        <article className="card metric-card">
          <div className="metric-label">
            <span className="metric-icon">
              <Clock3 />
            </span>
            未来 7 天截止
          </div>
          <div className="metric-value">
            {stats.dueThisWeek}
            <span className="metric-suffix">项</span>
          </div>
          <div className="metric-foot">按截止时间升序排列</div>
        </article>

        <article className="card metric-card teal">
          <div className="metric-label">
            <span className="metric-icon">
              <CircleCheckBig />
            </span>
            任务完成率
          </div>
          <div className="metric-value">
            {stats.completionRate}
            <span className="metric-suffix">%</span>
          </div>
          <div className="progress-wrap">
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${stats.completionRate}%` }} />
            </div>
          </div>
          <div className="metric-foot">{completionDelta}</div>
        </article>

        <article className="card metric-card">
          <div className="metric-label">
            <span className="metric-icon">
              <GraduationCap />
            </span>
            本学期课程
          </div>
          <div className="metric-value">
            {courses.length}
            <span className="metric-suffix">门</span>
          </div>
          <div className="metric-foot">
            收藏 {courses.filter((course) => course.favorite).length} 门课程
          </div>
        </article>
      </div>

      <div className="dashboard-grid">
        <div className="dashboard-column">
          <section className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">待办任务</h2>
                <p className="card-subtitle">所有未完成任务，按截止时间排序</p>
              </div>
              <span className="spacer" />
              <button type="button" className="text-link" onClick={() => onNavigate('tasks')}>
                任务中心 <ArrowRight size={12} style={{ verticalAlign: '-1px' }} />
              </button>
            </div>
            <div className="today-list">
              {todayTasks.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">
                    <CheckCircle2 />
                  </div>
                  <div className="empty-title">当前没有未完成任务</div>
                  <div className="empty-text">
                    所有任务都已完成；新的作业同步后会自动出现在这里。
                  </div>
                </div>
              ) : (
                todayTasks.map((task) => {
                  const course = task.courseId ? courseById.get(task.courseId) : null
                  const bucket = dueBucket(task, now)
                  return (
                    <div className="task-line" key={task.id}>
                      <button
                        type="button"
                        className={task.status === 'done' ? 'task-check checked' : 'task-check'}
                        aria-label={task.status === 'done' ? '标记为待完成' : '标记为完成'}
                        onClick={() => onToggleTask(task)}
                      >
                        <CheckCircle2 />
                      </button>
                      <button
                        type="button"
                        className="task-line-main"
                        style={{
                          border: 0,
                          background: 'transparent',
                          padding: 0,
                          textAlign: 'left'
                        }}
                        onClick={() => onOpenTask(task)}
                      >
                        <div className="task-line-title">{task.title}</div>
                        <div className="task-line-meta">
                          {course ? (
                            <span
                              className="course-chip"
                              style={{ ['--chip-color' as string]: course.color }}
                            >
                              {course.name}
                            </span>
                          ) : (
                            <span className="course-chip">未关联课程</span>
                          )}
                          <span className="dot-separator" />
                          <span>{TASK_KIND_LABEL[task.kind]}</span>
                        </div>
                      </button>
                      <span
                        className={`due-pill ${bucket === 'overdue' ? 'overdue' : bucket === 'today' ? 'today' : ''}`}
                      >
                        {task.status === 'done'
                          ? '已完成'
                          : formatRemainingCompact(task.dueAt, now)}
                      </span>
                    </div>
                  )
                })
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">即将截止</h2>
                <p className="card-subtitle">未来七天内的作业与考试安排</p>
              </div>
              <span className="spacer" />
              <button type="button" className="text-link" onClick={() => onNavigate('calendar')}>
                查看日历 <ArrowRight size={12} style={{ verticalAlign: '-1px' }} />
              </button>
            </div>
            <div className="deadline-list">
              {upcoming.length === 0 ? (
                <div className="mini-empty">未来七天没有新的截止任务。</div>
              ) : (
                upcoming.map((task) => {
                  const due = new Date(task.dueAt)
                  const course = task.courseId ? courseById.get(task.courseId) : null
                  return (
                    <button
                      type="button"
                      className="deadline-item"
                      key={task.id}
                      onClick={() => onOpenTask(task)}
                    >
                      <div className="deadline-date">
                        <strong>{due.getDate()}</strong>
                        <span>{due.getMonth() + 1} 月</span>
                      </div>
                      <div className="deadline-main">
                        <div className="deadline-title">{task.title}</div>
                        <div className="deadline-sub">
                          {course?.name ?? '未关联课程'} · {TASK_KIND_LABEL[task.kind]} ·{' '}
                          {formatTime(task.dueAt)}
                        </div>
                      </div>
                      <span className="due-pill">{formatRemainingCompact(task.dueAt, now)}</span>
                    </button>
                  )
                })
              )}
            </div>
          </section>
        </div>

        <div className="dashboard-column">
          <section className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">今日课程</h2>
                <p className="card-subtitle">
                  {formatDateTime(now.toISOString()).split(' ')[0]} · 按上课时间排序
                </p>
              </div>
            </div>
            <div className="course-mini-list">
              {todaySessions.length === 0 ? (
                <div className="mini-empty">今天没有排课，适合整理作业或预习。</div>
              ) : (
                todaySessions.map(({ course, session }) => (
                  <div
                    className="course-mini"
                    key={`${course.id}-${session.id}`}
                    style={{ ['--course-color' as string]: course.color }}
                  >
                    <div className="course-mini-time">
                      {session.startTime}
                      <br />
                      <span style={{ color: 'var(--text-faint)', fontWeight: 500 }}>
                        {session.endTime}
                      </span>
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div className="course-mini-name">{course.name}</div>
                      <div style={{ color: 'var(--text-faint)', fontSize: 10, marginTop: 2 }}>
                        {course.teacher}
                      </div>
                    </div>
                    <div className="course-mini-location">{session.location}</div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">最近通知</h2>
                <p className="card-subtitle">
                  {notices.length > 0 ? '当前为演示通知，不代表学习通消息' : '尚未接入学习通通知'}
                </p>
              </div>
              <span className="spacer" />
              <button type="button" className="text-link" onClick={() => onNavigate('portal')}>
                官方收件箱 <ArrowRight size={12} style={{ verticalAlign: '-1px' }} />
              </button>
            </div>
            <div className="notice-list">
              {recentNotices.map((notice) => {
                const Icon = NOTICE_ICON[notice.category]
                return (
                  <div className="notice-item" key={notice.id}>
                    <div className={`notice-icon ${notice.category}`}>
                      <Icon />
                    </div>
                    <div className="notice-main">
                      <div className="notice-title">{notice.title}</div>
                      <div className="notice-body">{notice.body}</div>
                      <div className="notice-time">{relativeTime(notice.publishedAt)} · 演示</div>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="card" style={{ padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div className="metric-icon">
                <ListChecks />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 650 }}>任务进度</div>
                <div style={{ color: 'var(--text-faint)', fontSize: 10, marginTop: 2 }}>
                  已完成 {stats.completed} / {stats.total} 项
                </div>
              </div>
              <div style={{ fontSize: 18, fontWeight: 750 }}>{stats.completionRate}%</div>
            </div>
            <div className="progress-wrap">
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${stats.completionRate}%` }} />
              </div>
            </div>
            <div
              style={{ marginTop: 11, color: 'var(--text-faint)', fontSize: 10, lineHeight: 1.6 }}
            >
              {isSameLocalDay(now, new Date()) ? '统计范围：当前全部课程任务，仅保存在本机。' : ''}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
