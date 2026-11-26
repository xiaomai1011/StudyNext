import { Fragment, useMemo, useState, type CSSProperties, type JSX } from 'react'
import {
  addDays,
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
  subDays,
  subMonths,
  subWeeks
} from 'date-fns'
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  MapPin
} from 'lucide-react'
import type { Course, Exam, Task } from '@shared/types'
import { addLocalDays, startOfLocalDay } from '@shared/domain'
import { coursesForSemester, getSemesterWindow, listSemesterOptions } from '@shared/semesters'
import {
  getTaskPortalAction,
  getTaskStatusView,
  isPlatformTask,
  isTaskActionable
} from '@shared/task-state'
import {
  buildCourseDisplayMap,
  buildDayAgenda,
  countActionableTasksByCourse,
  formatLocalDateKey,
  getSessionsForDate,
  groupExamsByLocalDay,
  groupTasksByLocalDay,
  isCalendarTaskOverdue,
  parseTimeToMinutes,
  partitionTimelineTasks,
  resolveEffectiveCalendarSemesterKey,
  sliceMonthCellEvents,
  type DayExamItem,
  type ExamScheduleBucket
} from '@shared/today-schedule'
import { buildWeekPeriods, sessionMatchesPeriod } from '@shared/week-timetable'
import { formatTime } from '../lib/format'
import { Badge } from '../ui/primitives'
import { platformStatusTone } from '../ui/status'

interface CalendarProps {
  tasks: Task[]
  courses: Course[]
  exams?: Exam[]
  now?: Date
  weekStartsOn: 0 | 1
  embedded?: boolean
  headerBadge?: JSX.Element | null
  onOpenTask: (task: Task) => void
  onOpenTaskInPortal?: (task: Task) => void
  onOpenCourse: (course: Course) => void
  onNavigateExams?: () => void
}

type CalendarView = 'timetable' | 'day' | 'month' | 'week'

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']
const HOUR_START = 8
const HOUR_END = 21
const HOUR_HEIGHT = 52

const EXAM_BUCKET_LABEL: Record<ExamScheduleBucket, string> = {
  ongoing: '进行中',
  upcoming: '即将开始',
  past: '已结束',
  unknown: '时间待确认'
}

function taskColor(task: Task, courseById: Map<string, Course>): string {
  if (!task.courseId) return 'var(--warning)'
  return courseById.get(task.courseId)?.color ?? 'var(--warning)'
}

export function Calendar({
  tasks,
  courses,
  exams = [],
  now: externalNow,
  weekStartsOn,
  embedded = false,
  headerBadge = null,
  onOpenTask,
  onOpenTaskInPortal,
  onOpenCourse,
  onNavigateExams
}: CalendarProps): JSX.Element {
  const [view, setView] = useState<CalendarView>('timetable')
  // null = auto-follow live `now` (including across midnight / semester transitions)
  const [manualDate, setManualDate] = useState<Date | null>(null)
  const [fallbackNow] = useState(() => new Date())
  // undefined = auto mode (follows active semester at `selectedDate`); null = user chose all; string = manual semester
  const [manualSemesterKey, setManualSemesterKey] = useState<string | null | undefined>(undefined)

  const now = externalNow ?? fallbackNow
  const selectedDate = manualDate ?? now
  const anchor = selectedDate

  const semesterOptions = useMemo(() => listSemesterOptions(courses), [courses])
  const semesterKey = useMemo(
    () => resolveEffectiveCalendarSemesterKey(courses, manualSemesterKey, selectedDate),
    [courses, manualSemesterKey, selectedDate]
  )

  const semesterCourses = useMemo(
    () => coursesForSemester(courses, semesterKey),
    [courses, semesterKey]
  )
  const courseById = useMemo(() => new Map(courses.map((course) => [course.id, course])), [courses])
  const courseDisplayMap = useMemo(() => buildCourseDisplayMap(courses), [courses])
  const courseDisplay = (course: Course) =>
    courseDisplayMap.get(course.id) ?? {
      title: course.name,
      classTag: null,
      fullLabel: course.name
    }
  const courseLabel = (course: Course): string => courseDisplay(course).fullLabel
  const pendingByCourse = useMemo(() => countActionableTasksByCourse(tasks), [tasks])

  const tasksByDay = useMemo(() => groupTasksByLocalDay(tasks), [tasks])
  const examsByDay = useMemo(() => groupExamsByLocalDay(exams, courses, now), [exams, courses, now])

  const openExamItem = (item: DayExamItem): void => {
    if (item.course) {
      onOpenCourse(item.course)
    } else {
      onNavigateExams?.()
    }
  }

  /** Unified date navigation helper keeping selectedDate & anchor synchronized across views. */
  const focusDate = (nextDate: Date, nextView?: CalendarView): void => {
    setManualDate(nextDate)
    if (nextView) setView(nextView)
  }

  const switchView = (nextView: CalendarView): void => {
    setView(nextView)
  }

  const openDayView = (date: Date): void => {
    focusDate(date, 'day')
  }

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

  const selectedAgenda = useMemo(
    () => buildDayAgenda(selectedDate, semesterCourses, tasksByDay, examsByDay, tasks, now),
    [selectedDate, semesterCourses, tasksByDay, examsByDay, tasks, now]
  )

  const title =
    view === 'month'
      ? `${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月`
      : view === 'day'
        ? `${format(selectedDate, 'M月d日')} · 周${WEEKDAY_NAMES[selectedDate.getDay()]}`
        : `${format(weekDays[0] ?? anchor, 'M月d日')} – ${format(weekDays[6] ?? anchor, 'M月d日')}`

  const anchorSemesterWindow = getSemesterWindow(semesterCourses, selectedDate)
  const activeWeekNumber =
    semesterKey === null && semesterOptions.length > 1 ? null : anchorSemesterWindow.currentWeek

  const todayWeekday = now.getDay() === 0 ? 7 : now.getDay()
  const isCurrentWeekAnchor = isSameDay(
    addLocalDays(
      startOfLocalDay(anchor),
      -(((anchor.getDay() === 0 ? 7 : anchor.getDay()) + 6) % 7)
    ),
    addLocalDays(startOfLocalDay(now), -((todayWeekday + 6) % 7))
  )

  const timetableDays = useMemo(() => {
    const anchorWd = anchor.getDay() === 0 ? 7 : anchor.getDay()
    const monday = addLocalDays(startOfLocalDay(anchor), -((anchorWd + 6) % 7))
    return Array.from({ length: 7 }, (_, index) => {
      const date = addLocalDays(monday, index)
      const dayWeekday = (index + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7
      const key = formatLocalDateKey(date)
      return {
        weekday: dayWeekday,
        date,
        dateKey: key,
        sessions: getSessionsForDate(semesterCourses, date),
        tasks: tasksByDay.get(key) ?? [],
        exams: examsByDay.get(key) ?? []
      }
    })
  }, [anchor, semesterCourses, tasksByDay, examsByDay])

  const hasTimetableAgenda = useMemo(
    () => timetableDays.some((day) => day.tasks.length > 0 || day.exams.length > 0),
    [timetableDays]
  )

  const timetablePeriods = useMemo(
    () =>
      buildWeekPeriods(timetableDays.flatMap((day) => day.sessions.map((item) => item.session))),
    [timetableDays]
  )
  const satEmpty =
    (timetableDays[5]?.sessions.length ?? 0) === 0 &&
    (timetableDays[5]?.tasks.length ?? 0) === 0 &&
    (timetableDays[5]?.exams.length ?? 0) === 0
  const sunEmpty =
    (timetableDays[6]?.sessions.length ?? 0) === 0 &&
    (timetableDays[6]?.tasks.length ?? 0) === 0 &&
    (timetableDays[6]?.exams.length ?? 0) === 0

  const move = (direction: -1 | 1): void => {
    const base = selectedDate
    const next =
      view === 'month'
        ? direction < 0
          ? subMonths(base, 1)
          : addMonths(base, 1)
        : view === 'day'
          ? direction < 0
            ? subDays(base, 1)
            : addDays(base, 1)
          : direction < 0
            ? subWeeks(base, 1)
            : addWeeks(base, 1)
    focusDate(next)
  }

  const goToday = (): void => {
    setManualDate(null)
  }

  const renderTimetable = (): JSX.Element => (
    <section className="studio-timetable-wrap">
      <div className="studio-timetable-bar">
        <div className="studio-timetable-nav">
          <button
            type="button"
            className="btn icon-only small"
            onClick={() => move(-1)}
            aria-label="上一周"
          >
            <ChevronLeft size={14} />
          </button>
          <button type="button" className="btn small" onClick={goToday}>
            本周
          </button>
          <button
            type="button"
            className="btn icon-only small"
            onClick={() => move(1)}
            aria-label="下一周"
          >
            <ChevronRight size={14} />
          </button>
          <span className="studio-timetable-range">
            {timetableDays[0] && timetableDays[6]
              ? `${format(timetableDays[0].date, 'M月d日')} – ${format(timetableDays[6].date, 'M月d日')}`
              : title}
          </span>
          {activeWeekNumber ? (
            <span className="today-week-pill">第 {activeWeekNumber} 周</span>
          ) : null}
        </div>
        <span className="studio-timetable-hint">点击日期看当日日程，点击课程进入课程空间</span>
      </div>

      <div
        className="week-table studio-full-week-table"
        data-sat-empty={satEmpty ? 'true' : 'false'}
        data-sun-empty={sunEmpty ? 'true' : 'false'}
      >
        <div className="week-table-corner" />
        {timetableDays.map((day) => {
          const dayLabel = ['一', '二', '三', '四', '五', '六', '日'][day.weekday - 1]
          const isDayToday = isCurrentWeekAnchor && day.weekday === todayWeekday
          const actionableTaskCount = day.tasks.filter(isTaskActionable).length
          return (
            <button
              type="button"
              className={`week-table-day${isDayToday ? ' today' : ''}`}
              key={day.weekday}
              onClick={() => openDayView(day.date)}
              title={`查看周${dayLabel}（${day.date.getMonth() + 1}/${day.date.getDate()}）完整日程`}
            >
              <span className="week-table-day-top">
                <strong>周{dayLabel}</strong>
                <span>
                  {day.date.getMonth() + 1}/{day.date.getDate()}
                </span>
              </span>
              {day.exams.length > 0 || actionableTaskCount > 0 ? (
                <span className="week-table-day-badges">
                  {day.exams.length > 0 ? (
                    <span className="week-table-day-badge exam">考 {day.exams.length}</span>
                  ) : null}
                  {actionableTaskCount > 0 ? (
                    <span className="week-table-day-badge task">截 {actionableTaskCount}</span>
                  ) : null}
                </span>
              ) : null}
            </button>
          )
        })}

        {hasTimetableAgenda ? (
          <>
            <div className="week-table-agenda-label">
              <span>截止</span>
              <span>与考试</span>
            </div>
            {timetableDays.map((day) => {
              const isDayToday = isCurrentWeekAnchor && day.weekday === todayWeekday
              const {
                visibleExams: shownExams,
                visibleTasks: shownTasks,
                hiddenCount
              } = sliceMonthCellEvents(day.exams, day.tasks, 2)
              return (
                <div
                  className={`week-table-agenda-cell${isDayToday ? ' today' : ''}`}
                  key={`agenda-${day.dateKey}`}
                >
                  {shownExams.map((item) => (
                    <button
                      type="button"
                      key={item.exam.id}
                      className="week-agenda-chip is-exam"
                      onClick={() => openExamItem(item)}
                      title={`考试：${item.exam.title}${item.exam.startAt ? ` · ${formatTime(item.exam.startAt)}` : ''}`}
                    >
                      考 · {item.exam.title}
                    </button>
                  ))}
                  {shownTasks.map((task) => {
                    const overdue = isCalendarTaskOverdue(task, now)
                    const settled = !isTaskActionable(task)
                    return (
                      <button
                        type="button"
                        key={task.id}
                        className={[
                          'week-agenda-chip',
                          overdue ? 'is-overdue' : '',
                          settled ? 'is-done' : ''
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        style={{ ['--chip-color' as string]: taskColor(task, courseById) }}
                        onClick={() => onOpenTask(task)}
                        title={`${task.title} · ${formatTime(task.dueAt)} 截止`}
                      >
                        {formatTime(task.dueAt)} {task.title}
                      </button>
                    )
                  })}
                  {hiddenCount > 0 ? (
                    <button
                      type="button"
                      className="week-agenda-more"
                      onClick={() => openDayView(day.date)}
                    >
                      +{hiddenCount} 项日程
                    </button>
                  ) : null}
                </div>
              )
            })}
          </>
        ) : null}

        {timetablePeriods.map((period) => (
          <Fragment key={period.key}>
            <div className="week-table-time">
              {period.fixed ? (
                <>
                  <strong>{period.label}</strong>
                  <span>
                    {period.start}–{period.end}
                  </span>
                </>
              ) : (
                <>
                  <strong>{period.start}</strong>
                  <span>{period.end}</span>
                </>
              )}
            </div>
            {timetableDays.map((day) => {
              const isDayToday = isCurrentWeekAnchor && day.weekday === todayWeekday
              const entries = day.sessions.filter((item) =>
                sessionMatchesPeriod(item.session, period)
              )
              return (
                <div
                  className={`week-table-cell${isDayToday ? ' today' : ''}`}
                  key={`${day.weekday}-${period.label}`}
                >
                  {entries.map((entry) => {
                    const pendingCount = pendingByCourse.get(entry.course.id) ?? 0
                    const identity = courseDisplay(entry.course)
                    return (
                      <button
                        type="button"
                        className="week-session"
                        key={entry.session.id}
                        onClick={() => onOpenCourse(entry.course)}
                        style={{ '--course-color': entry.course.color } as CSSProperties}
                        title={`${identity.fullLabel} · ${entry.session.startTime}-${entry.session.endTime}${entry.session.location ? ` · ${entry.session.location}` : ''}${pendingCount > 0 ? ` · ${pendingCount} 项待交作业` : ''}`}
                      >
                        <span className="week-session-head">
                          <span className="week-session-name">{identity.title}</span>
                          {pendingCount > 0 ? (
                            <span className="week-session-pending">{pendingCount} 待交</span>
                          ) : null}
                        </span>
                        {identity.classTag ? (
                          <span className="week-session-class">{identity.classTag}</span>
                        ) : null}
                        <span className="week-session-meta">
                          <span className="week-session-place">
                            {entry.session.location || '地点待确认'}
                          </span>
                          <span className="week-session-time">
                            {entry.session.startTime}–{entry.session.endTime}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </Fragment>
        ))}
      </div>
    </section>
  )

  const renderDay = (): JSX.Element => (
    <section className="studio-day-wrap" aria-label="当日学习日程">
      <div className="studio-timetable-bar">
        <div className="studio-timetable-nav">
          <button
            type="button"
            className="btn icon-only small"
            onClick={() => move(-1)}
            aria-label="上一天"
          >
            <ChevronLeft size={14} />
          </button>
          <button type="button" className="btn small" onClick={goToday}>
            今天
          </button>
          <button
            type="button"
            className="btn icon-only small"
            onClick={() => move(1)}
            aria-label="下一天"
          >
            <ChevronRight size={14} />
          </button>
          <span className="studio-timetable-range">
            {format(selectedDate, 'yyyy年M月d日')} · 周{WEEKDAY_NAMES[selectedDate.getDay()]}
          </span>
          {activeWeekNumber ? (
            <span className="today-week-pill">第 {activeWeekNumber} 周</span>
          ) : null}
        </div>
        <span className="studio-timetable-hint">
          {selectedAgenda.sessions.length} 节课 · {selectedAgenda.tasks.length} 项截止
          {selectedAgenda.exams.length > 0 ? ` · ${selectedAgenda.exams.length} 场考试` : ''}
        </span>
      </div>

      <div className="studio-day-grid">
        <div className="studio-day-col">
          <div className="studio-day-section-head">
            <h3>课程安排（{selectedAgenda.sessions.length}）</h3>
          </div>
          {selectedAgenda.sessions.length === 0 ? (
            <div className="studio-day-empty">当天没有排课，可用来推进待交作业或复习章节。</div>
          ) : (
            <div className="studio-day-list">
              {selectedAgenda.sessions.map(
                ({ course, session, state, timeHint, pendingTaskCount }) => {
                  const identity = courseDisplay(course)
                  return (
                    <button
                      type="button"
                      key={`${course.id}-${session.id}`}
                      className={`studio-day-session is-${state}`}
                      style={{ '--course-color': course.color } as CSSProperties}
                      onClick={() => onOpenCourse(course)}
                    >
                      <span className="studio-day-time">
                        <strong>{session.startTime}</strong>
                        <span>{session.endTime}</span>
                      </span>
                      <span className="studio-day-session-main">
                        <span className="studio-day-session-title">{identity.title}</span>
                        {identity.classTag ? (
                          <span className="today-class-tag">{identity.classTag}</span>
                        ) : null}
                        <span className="studio-day-session-sub">
                          <MapPin size={11} aria-hidden="true" />
                          <span>{session.location || '地点待确认'}</span>
                          <span className={`today-ribbon-state ${state}`}>{timeHint}</span>
                          {pendingTaskCount > 0 ? (
                            <span className="today-ribbon-pending">{pendingTaskCount} 项待交</span>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  )
                }
              )}
            </div>
          )}
        </div>

        <div className="studio-day-col">
          {selectedAgenda.exams.length > 0 ? (
            <>
              <div className="studio-day-section-head">
                <h3>考试安排（{selectedAgenda.exams.length}）</h3>
              </div>
              <div className="studio-day-list">
                {selectedAgenda.exams.map((item) => (
                  <button
                    type="button"
                    key={item.exam.id}
                    className="studio-day-task-row"
                    onClick={() => openExamItem(item)}
                  >
                    <span className="studio-day-time">
                      <strong>{item.exam.startAt ? formatTime(item.exam.startAt) : '--:--'}</strong>
                      <span>{item.exam.endAt ? formatTime(item.exam.endAt) : '考试'}</span>
                    </span>
                    <span className="studio-day-task-main">
                      <span className="studio-day-task-title">{item.exam.title}</span>
                      <span className="studio-day-task-meta">
                        <CalendarClock size={11} aria-hidden="true" />
                        <span>{item.exam.courseName || '课程未标注'}</span>
                      </span>
                    </span>
                    <span
                      className={`today-exam-pill${item.bucket === 'ongoing' ? ' is-ongoing' : ''}`}
                    >
                      {EXAM_BUCKET_LABEL[item.bucket]}
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          <div className="studio-day-section-head">
            <h3>当日截止任务（{selectedAgenda.tasks.length}）</h3>
          </div>
          {selectedAgenda.tasks.length === 0 ? (
            <div className="studio-day-empty">当天没有任务截止。</div>
          ) : (
            <div className="studio-day-list">
              {selectedAgenda.tasks.map((task) => {
                const course = task.courseId ? courseById.get(task.courseId) : null
                const statusView = getTaskStatusView(task, now)
                const overdue = isCalendarTaskOverdue(task, now)
                const portalAction = getTaskPortalAction(task, course)
                const showPortalAction =
                  Boolean(onOpenTaskInPortal) &&
                  (isPlatformTask(task) || portalAction.target !== null)
                return (
                  <div
                    key={task.id}
                    className={`studio-day-task-row${overdue ? ' is-overdue' : ''}`}
                  >
                    <button
                      type="button"
                      className="studio-day-task-main"
                      onClick={() => onOpenTask(task)}
                    >
                      <span className="studio-day-task-title">{task.title}</span>
                      <span className="studio-day-task-meta">
                        <Clock3 size={11} aria-hidden="true" />
                        <span>{formatTime(task.dueAt)} 截止</span>
                        <span>· {course ? courseLabel(course) : '本地任务'}</span>
                      </span>
                    </button>
                    <div className="studio-day-task-actions">
                      {statusView.platformLabel ? (
                        <Badge
                          tone={platformStatusTone(statusView.platformClass ?? 'unknown')}
                          className={`platform-tag ${statusView.platformClass ?? 'unknown'}`}
                        >
                          {statusView.platformLabel}
                        </Badge>
                      ) : null}
                      {showPortalAction && onOpenTaskInPortal ? (
                        <button
                          type="button"
                          className={
                            portalAction.kind === 'answer'
                              ? 'today-go-btn'
                              : portalAction.disabled
                                ? 'today-go-btn subtle is-disabled'
                                : 'today-go-btn subtle'
                          }
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
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  )

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
          const key = formatLocalDateKey(day)
          const dayTasks = tasksByDay.get(key) ?? []
          const dayExams = examsByDay.get(key) ?? []
          const sessions = getSessionsForDate(semesterCourses, day)
          const { visibleExams, visibleTasks, hiddenCount } = sliceMonthCellEvents(
            dayExams,
            dayTasks,
            3
          )
          return (
            <div
              key={key}
              data-date-key={key}
              className={[
                'calendar-day',
                !isSameMonth(day, anchor) ? 'other-month' : '',
                isToday(day) ? 'today' : '',
                isSameDay(day, selectedDate) ? 'selected' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => focusDate(day)}
              role="presentation"
            >
              <div className="calendar-day-head">
                <button
                  type="button"
                  className="calendar-day-number"
                  onClick={(event) => {
                    event.stopPropagation()
                    focusDate(day)
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
                      title={`${courseLabel(course)} ${session.startTime}`}
                    />
                  ))}
                </div>
              </div>
              {visibleExams.map((item) => (
                <button
                  type="button"
                  key={item.exam.id}
                  className="calendar-exam-event"
                  title={`考试：${item.exam.title}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    openExamItem(item)
                  }}
                >
                  考 · {item.exam.title}
                </button>
              ))}
              {visibleTasks.map((task) => (
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
                  {!isTaskActionable(task) ? '✓ ' : ''}
                  {task.title}
                </button>
              ))}
              {hiddenCount > 0 ? (
                <span className="calendar-more">还有 {hiddenCount} 项</span>
              ) : null}
            </div>
          )
        })}
      </div>
    </>
  )

  const renderWeek = (): JSX.Element => {
    const weekData = weekDays.map((day) => {
      const key = formatLocalDateKey(day)
      const dayTasks = tasksByDay.get(key) ?? []
      const dayExams = examsByDay.get(key) ?? []
      const partitioned = partitionTimelineTasks(dayTasks, HOUR_START, HOUR_END)
      return {
        day,
        key,
        sessions: getSessionsForDate(semesterCourses, day),
        dayExams,
        ...partitioned
      }
    })
    const hasAllDayOrAfterHours = weekData.some(
      (item) => item.dayExams.length > 0 || item.afterHours.length > 0
    )

    return (
      <div className="week-timeline-scroll">
        <div className="week-grid week-timeline-grid">
          <div className="week-corner">时间</div>
          {weekData.map(({ day, key }) => (
            <button
              type="button"
              key={`head-${key}`}
              data-date-key={key}
              className={[
                'week-day-head',
                isToday(day) ? 'today' : '',
                isSameDay(day, selectedDate) ? 'selected' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => focusDate(day)}
              title={`查看 ${format(day, 'M月d日')} 当日日程`}
            >
              <div>周{WEEKDAY_NAMES[day.getDay()]}</div>
              <div style={{ marginTop: 2, fontSize: 12, color: 'inherit', fontWeight: 720 }}>
                {day.getDate()}
              </div>
            </button>
          ))}

          {hasAllDayOrAfterHours ? (
            <>
              <div className="week-allday-label">
                晚间/
                <br />
                考试
              </div>
              {weekData.map(({ key, dayExams, afterHours }) => (
                <div className="week-allday-cell" key={`allday-${key}`} data-date-key={key}>
                  {dayExams.map((item) => (
                    <button
                      type="button"
                      key={item.exam.id}
                      className="week-agenda-chip is-exam"
                      onClick={() => openExamItem(item)}
                      title={`考试：${item.exam.title}${item.exam.startAt ? ` · ${formatTime(item.exam.startAt)}` : ''}`}
                    >
                      考 · {item.exam.title}
                    </button>
                  ))}
                  {afterHours.map((task) => {
                    const overdue = isCalendarTaskOverdue(task, now)
                    return (
                      <button
                        type="button"
                        key={task.id}
                        className={`week-agenda-chip${overdue ? ' is-overdue' : !isTaskActionable(task) ? ' is-done' : ''}`}
                        style={{ ['--chip-color' as string]: taskColor(task, courseById) }}
                        onClick={() => onOpenTask(task)}
                        title={`${task.title} · ${formatTime(task.dueAt)} 截止`}
                      >
                        {formatTime(task.dueAt)} {task.title}
                      </button>
                    )
                  })}
                </div>
              ))}
            </>
          ) : null}

          <div className="week-time-col">
            {Array.from({ length: HOUR_END - HOUR_START }, (_, index) => (
              <div className="week-time-label" key={index}>
                {String(HOUR_START + index).padStart(2, '0')}:00
              </div>
            ))}
          </div>

          {weekData.map(({ key, sessions, timed }) => (
            <div
              className="week-day-col"
              key={`col-${key}`}
              data-date-key={key}
              style={{ height: (HOUR_END - HOUR_START) * HOUR_HEIGHT }}
            >
              {Array.from({ length: HOUR_END - HOUR_START }, (_, index) => (
                <div className="week-hour-cell" key={index} />
              ))}
              {sessions.map(({ course, session }) => {
                const start = parseTimeToMinutes(session.startTime)
                const end = parseTimeToMinutes(session.endTime)
                const top = Math.max(0, ((start - HOUR_START * 60) / 60) * HOUR_HEIGHT)
                const height = Math.max(24, ((end - start) / 60) * HOUR_HEIGHT - 2)
                if (start < HOUR_START * 60 || start >= HOUR_END * 60) return null
                const identity = courseDisplay(course)
                return (
                  <button
                    type="button"
                    key={`${course.id}-${session.id}`}
                    className="week-course-block"
                    style={{
                      top,
                      height,
                      ['--block-color' as string]: course.color
                    }}
                    title={`${identity.fullLabel} ${session.startTime}-${session.endTime} ${session.location}`}
                    aria-label={`打开课程 ${course.name}`}
                    onClick={() => onOpenCourse(course)}
                  >
                    <strong>{identity.title}</strong>
                    {identity.classTag ? (
                      <span className="week-session-class">{identity.classTag}</span>
                    ) : null}
                    <span>
                      {session.startTime}–{session.endTime}
                    </span>
                    <br />
                    <span>{session.location}</span>
                  </button>
                )
              })}
              {timed.map((task) => {
                const due = new Date(task.dueAt)
                const minutes = due.getHours() * 60 + due.getMinutes()
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
          ))}
        </div>
      </div>
    )
  }

  const controls = (
    <div className="header-actions">
      {semesterOptions.length > 1 ? (
        <select
          className="semester-select"
          aria-label="选择课表学期"
          value={semesterKey ?? 'all'}
          onChange={(event) => {
            const value = event.target.value
            setManualSemesterKey(value === 'all' ? null : value)
          }}
        >
          <option value="all">全部学期</option>
          {semesterOptions.map((option) => (
            <option value={option.key} key={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      ) : null}
      <div className="segmented">
        <button
          type="button"
          className={view === 'timetable' ? 'active' : ''}
          onClick={() => switchView('timetable')}
        >
          周课表
        </button>
        <button
          type="button"
          className={view === 'day' ? 'active' : ''}
          onClick={() => switchView('day')}
        >
          日视图
        </button>
        <button
          type="button"
          className={view === 'month' ? 'active' : ''}
          onClick={() => switchView('month')}
        >
          月视图
        </button>
        <button
          type="button"
          className={view === 'week' ? 'active' : ''}
          onClick={() => switchView('week')}
        >
          时间轴
        </button>
      </div>
    </div>
  )

  const body =
    view === 'timetable' ? (
      renderTimetable()
    ) : view === 'day' ? (
      renderDay()
    ) : (
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
              {view === 'month'
                ? '课程以圆点显示，红标为考试'
                : '晚间（21:00 后）截止与考试置顶显示'}
            </span>
          </div>
          {view === 'month' ? renderMonth() : renderWeek()}
        </section>

        <aside className="card agenda-panel">
          <div className="agenda-head-row">
            <div className="agenda-date">{format(selectedDate, 'yyyy 年 M 月 d 日')}</div>
            <button type="button" className="agenda-day-link" onClick={() => switchView('day')}>
              日视图
            </button>
          </div>
          <div className="agenda-sub">
            周{WEEKDAY_NAMES[selectedDate.getDay()]} · {selectedAgenda.sessions.length} 节课 ·{' '}
            {selectedAgenda.tasks.length} 项任务
            {selectedAgenda.exams.length > 0 ? ` · ${selectedAgenda.exams.length} 场考试` : ''}
          </div>

          <div className="agenda-section-title">课程安排</div>
          {selectedAgenda.sessions.length === 0 ? (
            <div className="mini-empty" style={{ padding: '10px 0' }}>
              当天没有课程。
            </div>
          ) : (
            selectedAgenda.sessions.map(({ course, session }) => (
              <button
                type="button"
                className="agenda-item agenda-course-item"
                key={`${course.id}-${session.id}`}
                onClick={() => onOpenCourse(course)}
              >
                <span className="agenda-time">{session.startTime}</span>
                <span className="agenda-main">
                  {courseLabel(course)}
                  <span
                    className="agenda-location"
                    style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                  >
                    <MapPin size={9} /> {session.location || '地点待确认'} · {session.endTime}
                  </span>
                </span>
              </button>
            ))
          )}

          {selectedAgenda.exams.length > 0 ? (
            <>
              <div className="agenda-section-title">考试安排</div>
              {selectedAgenda.exams.map((item) => (
                <button
                  type="button"
                  className="agenda-item"
                  key={item.exam.id}
                  onClick={() => openExamItem(item)}
                >
                  <span className="agenda-time">
                    {item.exam.startAt ? formatTime(item.exam.startAt) : '--:--'}
                  </span>
                  <div className="agenda-main">
                    {item.exam.title}
                    <div className="agenda-location">
                      {item.exam.courseName || '课程未标注'} · {EXAM_BUCKET_LABEL[item.bucket]}
                    </div>
                  </div>
                </button>
              ))}
            </>
          ) : null}

          <div className="agenda-section-title">截止任务</div>
          {selectedAgenda.tasks.length === 0 ? (
            <div className="mini-empty" style={{ padding: '10px 0' }}>
              当天没有任务截止。
            </div>
          ) : (
            selectedAgenda.tasks.map((task) => {
              const statusView = getTaskStatusView(task, now)
              const overdue = isCalendarTaskOverdue(task, now)
              const course = task.courseId ? courseById.get(task.courseId) : null
              return (
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
                    style={{ textDecoration: !isTaskActionable(task) ? 'line-through' : 'none' }}
                  >
                    {task.title}
                    <div className="agenda-location">
                      {course ? courseLabel(course) : '未关联课程'}
                      {statusView.platformLabel ? (
                        <>
                          {' '}
                          <span className={`agenda-status-chip${overdue ? ' is-overdue' : ''}`}>
                            {statusView.platformLabel}
                          </span>
                        </>
                      ) : overdue ? (
                        <>
                          {' '}
                          <span className="agenda-status-chip is-overdue">已逾期</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                </button>
              )
            })
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
    )

  if (embedded) {
    return (
      <section className="today-timetable-section" aria-label="本周课表">
        <div className="today-timetable-head">
          <div className="today-timetable-title-group">
            <h2>
              {view === 'timetable'
                ? '本周课表'
                : view === 'day'
                  ? '日视图'
                  : view === 'month'
                    ? '月视图'
                    : '时间轴'}
            </h2>
            {headerBadge}
          </div>
          {controls}
        </div>
        {body}
      </section>
    )
  }

  return (
    <div className="studio-page studio-calendar-page">
      <header className="studio-page-head">
        <div>
          <h1 className="page-title">课表与日历</h1>
        </div>
        {controls}
      </header>
      {body}
    </div>
  )
}
