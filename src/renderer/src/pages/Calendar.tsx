import { useMemo, useState, type JSX } from 'react'
import {
  addMonths,
  addWeeks,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
  subMonths,
  subWeeks
} from 'date-fns'
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, MapPin } from 'lucide-react'
import type { Course, CourseSession, Task } from '@shared/types'
import { dedupeCourseSessions, dueBucket, isDueAtUnknown, semesterWeekOf, weekInSchedule } from '@shared/domain'
import { formatTime } from '../lib/format'

interface CalendarProps {
  tasks: Task[]
  courses: Course[]
  weekStartsOn: 0 | 1
  onOpenTask: (task: Task) => void
}

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']
const HOUR_START = 8
const HOUR_END = 21
const HOUR_HEIGHT = 52
const WEEKDAY_FULL = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

function dateKey(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}

function parseTime(value: string): number {
  const [hour = '0', minute = '0'] = value.split(':')
  return Number(hour) * 60 + Number(minute)
}

function taskColor(task: Task, courseById: Map<string, Course>): string {
  if (!task.courseId) return 'var(--warning)'
  return courseById.get(task.courseId)?.color ?? 'var(--warning)'
}

export function Calendar({ tasks, courses, weekStartsOn, onOpenTask }: CalendarProps) {
  const [view, setView] = useState<'month' | 'week'>('month')
  const [anchor, setAnchor] = useState(() => new Date())
  const [selectedDate, setSelectedDate] = useState(() => new Date())

  const courseById = useMemo(() => new Map(courses.map((course) => [course.id, course])), [courses])
  const semesterStart = courses[0]?.semesterStart ?? null
  const maxWeek = courses[0]?.maxWeek ?? 0
  const sessionActive = (session: CourseSession, date: Date): boolean => {
    const week = semesterWeekOf(date, semesterStart)
    if (week === null) return true
    if (maxWeek > 0 && (week < 1 || week > maxWeek)) return false
    return weekInSchedule(session.weeks, week)
  }
  const tasksByDay = useMemo(() => {
    const map = new Map<string, Task[]>()
    for (const task of tasks) {
      if (task.status === 'todo' && dueBucket(task, new Date()) === 'overdue') continue
      if (isDueAtUnknown(task.dueAt)) continue
      const due = new Date(task.dueAt)
      if (!Number.isFinite(due.getTime())) continue
      const key = dateKey(due)
      const list = map.get(key) ?? []
      list.push(task)
      map.set(key, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())
    }
    return map
  }, [tasks])

  const monthDays = useMemo(() => {
    const start = startOfWeek(startOfMonth(anchor), { weekStartsOn })
    const end = endOfWeek(endOfMonth(anchor), { weekStartsOn })
    return eachDayOfInterval({ start, end })
  }, [anchor, weekStartsOn])

  const weekDays = useMemo(() => {
    const start = startOfWeek(anchor, { weekStartsOn })
    return eachDayOfInterval({ start, end: addWeeks(start, 1) }).slice(0, 7)
  }, [anchor, weekStartsOn])

  const weekdayHeaders = useMemo(() => {
    const start = startOfWeek(new Date(), { weekStartsOn })
    return Array.from({ length: 7 }, (_, index) => {
      const day = new Date(start)
      day.setDate(start.getDate() + index)
      return WEEKDAY_NAMES[day.getDay()]
    })
  }, [weekStartsOn])

  const selectedKey = dateKey(selectedDate)
  const selectedTasks = (tasksByDay.get(selectedKey) ?? []).slice().sort((a, b) => {
    if (a.status !== b.status) return a.status === 'done' ? 1 : -1
    return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()
  })
  const selectedWeekday = selectedDate.getDay() === 0 ? 7 : selectedDate.getDay()
  const selectedSessions = dedupeCourseSessions(
    courses.flatMap((course) =>
      course.schedule
        .filter((session) => session.weekday === selectedWeekday && sessionActive(session, selectedDate))
        .map((session) => ({ course, session }))
    )
  ).sort((a, b) => a.session.startTime.localeCompare(b.session.startTime))

  const title =
    view === 'month'
      ? `${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月`
      : `${format(weekDays[0] ?? anchor, 'M月d日')} – ${format(weekDays[6] ?? anchor, 'M月d日')}`

  const move = (direction: -1 | 1): void => {
    const next =
      view === 'month'
        ? direction < 0
          ? subMonths(anchor, 1)
          : addMonths(anchor, 1)
        : direction < 0
          ? subWeeks(anchor, 1)
          : addWeeks(anchor, 1)
    setAnchor(next)
    setSelectedDate(next)
  }

  const goToday = (): void => {
    const today = new Date()
    setAnchor(today)
    setSelectedDate(today)
  }

  const renderMonth = (): JSX.Element => (
    <>
      <div className="calendar-weekdays">
        {weekdayHeaders.map((label, index) => (
          <div className="calendar-weekday" key={`${label}-${index}`}>
            周{label}
          </div>
        ))}
      </div>
      <div className="calendar-month-grid">
        {monthDays.map((day) => {
          const key = dateKey(day)
          const dayTasks = tasksByDay.get(key) ?? []
          const sessions = dedupeCourseSessions(
            courses.flatMap((course) =>
              course.schedule
                .filter(
                  (session) =>
                    session.weekday === (day.getDay() === 0 ? 7 : day.getDay()) &&
                    sessionActive(session, day)
                )
                .map((session) => ({ course, session }))
            )
          )
          return (
            <div
              key={key}
              className={[
                'calendar-day',
                !isSameMonth(day, anchor) ? 'other-month' : '',
                isToday(day) ? 'today' : '',
                isSameDay(day, selectedDate) ? 'selected' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => setSelectedDate(day)}
              role="presentation"
            >
              <div className="calendar-day-head">
                <button
                  type="button"
                  className="calendar-day-number"
                  onClick={(event) => {
                    event.stopPropagation()
                    setSelectedDate(day)
                  }}
                >
                  {day.getDate()}
                </button>
                <div className="calendar-session-dots">
                  {sessions.slice(0, 4).map(({ course, session }) => (
                    <span
                      key={`${course.id}-${session.id}`}
                      className="calendar-session-dot"
                      style={{ ['--dot-color' as string]: course.color }}
                      title={`${course.name} ${session.startTime}`}
                    />
                  ))}
                </div>
              </div>
              {dayTasks.slice(0, 3).map((task) => (
                <button
                  type="button"
                  key={task.id}
                  className="calendar-event"
                  style={{ ['--event-color' as string]: taskColor(task, courseById) }}
                  title={task.title}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpenTask(task)
                  }}
                >
                  {task.status === 'done' ? '✓ ' : ''}
                  {task.title}
                </button>
              ))}
              {dayTasks.length > 3 ? (
                <span className="calendar-more">还有 {dayTasks.length - 3} 项</span>
              ) : null}
            </div>
          )
        })}
      </div>
    </>
  )

  const renderWeek = (): JSX.Element => (
    <div className="week-grid">
      <div className="week-corner">时间</div>
      {weekDays.map((day) => (
        <div
          key={`head-${dateKey(day)}`}
          className={isToday(day) ? 'week-day-head today' : 'week-day-head'}
        >
          <div>周{WEEKDAY_NAMES[day.getDay()]}</div>
          <div style={{ marginTop: 2, fontSize: 12, color: 'inherit', fontWeight: 720 }}>
            {day.getDate()}
          </div>
        </div>
      ))}

      <div className="week-time-col">
        {Array.from({ length: HOUR_END - HOUR_START }, (_, index) => (
          <div className="week-time-label" key={index}>
            {String(HOUR_START + index).padStart(2, '0')}:00
          </div>
        ))}
      </div>

      {weekDays.map((day) => {
        const weekday = day.getDay() === 0 ? 7 : day.getDay()
        const sessions = dedupeCourseSessions(
          courses.flatMap((course) =>
            course.schedule
              .filter((session) => session.weekday === weekday && sessionActive(session, day))
              .map((session) => ({ course, session }))
          )
        )
        const dayTasks = tasksByDay.get(dateKey(day)) ?? []
        return (
          <div
            className="week-day-col"
            key={`col-${dateKey(day)}`}
            style={{ height: (HOUR_END - HOUR_START) * HOUR_HEIGHT }}
          >
            {Array.from({ length: HOUR_END - HOUR_START }, (_, index) => (
              <div className="week-hour-cell" key={index} />
            ))}
            {sessions.map(({ course, session }) => {
              const start = parseTime(session.startTime)
              const end = parseTime(session.endTime)
              const top = Math.max(0, ((start - HOUR_START * 60) / 60) * HOUR_HEIGHT)
              const height = Math.max(24, ((end - start) / 60) * HOUR_HEIGHT - 2)
              if (start < HOUR_START * 60 || start >= HOUR_END * 60) return null
              return (
                <div
                  key={`${course.id}-${session.id}`}
                  className="week-course-block"
                  style={{
                    top,
                    height,
                    ['--block-color' as string]: course.color
                  }}
                  title={`${course.name} ${session.startTime}-${session.endTime} ${session.location}`}
                >
                  <strong>{course.name}</strong>
                  <span>
                    {session.startTime}–{session.endTime}
                  </span>
                  <br />
                  <span>{session.location}</span>
                </div>
              )
            })}
            {dayTasks.map((task) => {
              const due = new Date(task.dueAt)
              const minutes = due.getHours() * 60 + due.getMinutes()
              if (minutes < HOUR_START * 60 || minutes > HOUR_END * 60) return null
              return (
                <button
                  type="button"
                  key={task.id}
                  className="week-task-chip"
                  style={{ top: Math.max(0, ((minutes - HOUR_START * 60) / 60) * HOUR_HEIGHT) }}
                  onClick={() => onOpenTask(task)}
                  title={`${task.title} · ${formatTime(task.dueAt)} 截止`}
                >
                  {formatTime(task.dueAt)} {task.title}
                </button>
              )
            })}
          </div>
        )
      })}
    </div>
  )

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header-copy">
          <div className="eyebrow">
            <CalendarDays size={12} /> 课程日历
          </div>
          <h1 className="page-title">日历与安排</h1>
          <p className="page-subtitle">月视图查看 DDL 分布，周视图对照课程时间安排。</p>
        </div>
        <div className="header-actions">
          <div className="segmented">
            <button
              type="button"
              className={view === 'month' ? 'active' : ''}
              onClick={() => setView('month')}
            >
              月视图
            </button>
            <button
              type="button"
              className={view === 'week' ? 'active' : ''}
              onClick={() => setView('week')}
            >
              周视图
            </button>
          </div>
        </div>
      </header>

      <div className="calendar-layout">
        <section className="card calendar-shell">
          <div className="calendar-toolbar">
            <button
              type="button"
              className="btn icon-only small"
              onClick={() => move(-1)}
              aria-label="上一页"
            >
              <ChevronLeft />
            </button>
            <button type="button" className="btn small" onClick={goToday}>
              今天
            </button>
            <button
              type="button"
              className="btn icon-only small"
              onClick={() => move(1)}
              aria-label="下一页"
            >
              <ChevronRight />
            </button>
            <div className="calendar-title">{title}</div>
            <span className="spacer" style={{ flex: 1 }} />
            <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>
              {view === 'month' ? '课程以圆点显示' : '课程按每周固定时间显示'}
            </span>
          </div>
          {view === 'month' ? renderMonth() : renderWeek()}
        </section>

        <aside className="card agenda-panel">
          <div className="agenda-date">{format(selectedDate, 'yyyy 年 M 月 d 日')}</div>
          <div className="agenda-sub">
            周{WEEKDAY_NAMES[selectedDate.getDay()]} · {selectedTasks.length} 项任务
          </div>

          <div className="agenda-section-title">课程安排</div>
          {selectedSessions.length === 0 ? (
            <div className="mini-empty" style={{ padding: '10px 0' }}>
              当天没有课程。
            </div>
          ) : (
            selectedSessions.map(
              ({ course, session }: { course: Course; session: CourseSession }) => (
                <div className="agenda-item" key={`${course.id}-${session.id}`}>
                  <span className="agenda-time">{session.startTime}</span>
                  <div className="agenda-main">
                    {course.name}
                    <div
                      className="agenda-location"
                      style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                    >
                      <MapPin size={9} /> {session.location} · {session.endTime}
                    </div>
                  </div>
                </div>
              )
            )
          )}

          <div className="agenda-section-title">截止任务</div>
          {selectedTasks.length === 0 ? (
            <div className="mini-empty" style={{ padding: '10px 0' }}>
              当天没有任务截止。
            </div>
          ) : (
            selectedTasks.map((task) => (
              <button
                type="button"
                className="agenda-item"
                key={task.id}
                onClick={() => onOpenTask(task)}
              >
                <span
                  className="agenda-time"
                  style={{ display: 'flex', alignItems: 'center', gap: 3 }}
                >
                  <Clock3 size={9} /> {formatTime(task.dueAt)}
                </span>
                <div
                  className="agenda-main"
                  style={{ textDecoration: task.status === 'done' ? 'line-through' : 'none' }}
                >
                  {task.title}
                  <div className="agenda-location">
                    {task.courseId
                      ? (courseById.get(task.courseId)?.name ?? '未关联课程')
                      : '未关联课程'}
                  </div>
                </div>
              </button>
            ))
          )}

          <div
            style={{
              marginTop: 16,
              paddingTop: 12,
              borderTop: '1px solid var(--border)',
              color: 'var(--text-faint)',
              fontSize: 9.5,
              lineHeight: 1.6
            }}
          >
            课程按学习通课表的周次显示；单双周按 weeks 字段过滤，调休以平台课表为准。
          </div>
        </aside>
      </div>
    </div>
  )
}
