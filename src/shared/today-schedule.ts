import type { AppNotice, Course, CourseSession, Exam, Task } from './types'
import {
  addLocalDays,
  dedupeCourseSessions,
  dueBucket,
  formatRemainingCompact,
  isDueAtUnknown,
  isSameLocalDay,
  startOfLocalDay,
  weekInSchedule
} from './domain'
import { findUniqueCourseByName } from './course-context'
import { getCourseClassLabel, shortStableId } from './course-identity'
import {
  coursesForSemester,
  getCourseSemester,
  getCourseWindow,
  isCourseActiveAt,
  preferredSemesterKey,
  UNKNOWN_SEMESTER
} from './semesters'
import { isTaskActionable } from './task-state'

export type ExamScheduleBucket = 'ongoing' | 'upcoming' | 'past' | 'unknown'
export type SessionLiveState = 'live' | 'next' | 'later' | 'done'

export interface CourseDisplayIdentity {
  title: string
  classTag: string | null
  fullLabel: string
}

export interface ScheduledCourseSession {
  course: Course
  session: CourseSession
  state: SessionLiveState
  timeHint: string
  pendingTaskCount: number
}

export interface NextClassSummary {
  kind: 'live' | 'next_today' | 'upcoming_day'
  dayOffset: number
  date: Date
  course: Course
  session: CourseSession
  timeHint: string
  dayLabel: string
}

export interface UpcomingExamItem {
  exam: Exam
  bucket: ExamScheduleBucket
  course: Course | null
  countdownLabel: string
}

export interface UpcomingExamsResult {
  items: UpcomingExamItem[]
  ongoingCount: number
  withinSevenDaysCount: number
}

export interface PrioritizedNoticesResult {
  items: AppNotice[]
  unreadCount: number
}

export interface DayExamItem {
  exam: Exam
  bucket: ExamScheduleBucket
  course: Course | null
}

export interface DayAgenda {
  date: Date
  dateKey: string
  sessions: ScheduledCourseSession[]
  exams: DayExamItem[]
  tasks: Task[]
}

export interface PartitionedTimelineTasks {
  timed: Task[]
  afterHours: Task[]
}

export interface MonthCellEventsSlice<E, T> {
  visibleExams: E[]
  visibleTasks: T[]
  hiddenCount: number
}

const WEEKDAY_SHORT = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
const EXAM_TERMINAL_STATUS_RE =
  /已结束|已完成|已提交|已交卷|已批阅|已通过|待批阅|待审核|已过期|已关闭|缺考|已作废/
const EXAM_ONGOING_STATUS_RE = /进行中|考试中|作答中/
const EXAM_SCORE_PLACEHOLDER_RE =
  /^(?:[-–—−‐‑~～/\\]+|暂无(?:成绩|分数)?|未(?:评分|出分|批阅|公布|开始|考)|无(?:成绩|分数)?|null|none|n\/?a)$/i

/**
 * Maximum age for treating a freshly-synced ongoing exam snapshot (without `endAt`)
 * as live even when the exam has a multi-day opening window.
 */
const EXAM_ONGOING_FRESH_SYNC_MS = 30 * 60_000
/** Grace margin added to a known `durationMinutes` when bounding an unrefreshed snapshot. */
const EXAM_ONGOING_GRACE_MS = 15 * 60_000
/** Default maximum trust window when both `endAt` and `durationMinutes` are absent. */
const EXAM_ONGOING_DEFAULT_TRUST_MS = 3 * 3_600_000

/**
 * Distinguishes real exam scores (including `'0'`, `'0.0'`, `'0分'`) from
 * platform placeholders like `'--'`, `'-'`, `'—'`, `'暂无'`, `'未评分'`, `'N/A'`.
 */
export function normalizeExamScore(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? ''
  if (!trimmed) return null
  if (EXAM_SCORE_PLACEHOLDER_RE.test(trimmed)) return null
  return trimmed
}

export function hasRealExamScore(raw: string | null | undefined): boolean {
  return normalizeExamScore(raw) !== null
}

export function parseTimeToMinutes(value: string): number {
  const [hour = '0', minute = '0'] = value.split(':')
  const h = Number(hour)
  const m = Number(minute)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0
  return h * 60 + m
}

export function formatLocalDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function formatMinutesSpan(minutes: number): string {
  const safe = Math.max(1, Math.round(minutes))
  if (safe < 60) return `${safe} 分钟`
  const hours = Math.floor(safe / 60)
  const rest = safe % 60
  return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`
}

function hasValidSemesterStart(course: Course): boolean {
  if (!course.semesterStart) return false
  return Number.isFinite(Date.parse(`${course.semesterStart}T00:00:00+08:00`))
}

/**
 * Resolves courses that are genuinely active on `date` across semesters.
 * Pre-enrolled future semesters (week < 1 on `date`) or ended historical semesters
 * (week > maxWeek on `date`) never mask currently active courses.
 */
export function selectCoursesActiveAt(courses: readonly Course[], date: Date): Course[] {
  const activeDated = courses.filter(
    (course) => hasValidSemesterStart(course) && isCourseActiveAt(course, date)
  )
  const undated = courses.filter((course) => !hasValidSemesterStart(course))

  if (activeDated.length > 0) {
    const activeSemesters = new Set(activeDated.map((course) => getCourseSemester(course)))
    const matchingUndated = undated.filter((course) => {
      const sem = getCourseSemester(course)
      return sem === UNKNOWN_SEMESTER || activeSemesters.has(sem)
    })
    return [...activeDated, ...matchingUndated]
  }

  if (undated.length > 0) {
    const fallbackKey = preferredSemesterKey(undated)
    return coursesForSemester(undated, fallbackKey)
  }

  return []
}

/**
 * Picks the best default semester key for calendar views at `now`:
 * prefers a semester that actually has active teaching weeks at `now`,
 * falling back to `preferredSemesterKey(courses)` when none is currently in session.
 */
export function resolveDefaultCalendarSemesterKey(
  courses: readonly Course[],
  now = new Date()
): string | null {
  const activeDated = courses.filter(
    (course) => hasValidSemesterStart(course) && isCourseActiveAt(course, now)
  )
  if (activeDated.length > 0) {
    const counts = new Map<string, { count: number; latestStart: number }>()
    for (const course of activeDated) {
      const key = getCourseSemester(course)
      const startMs = Date.parse(`${course.semesterStart}T00:00:00+08:00`)
      const current = counts.get(key) ?? { count: 0, latestStart: startMs }
      current.count += 1
      if (startMs > current.latestStart) current.latestStart = startMs
      counts.set(key, current)
    }
    return (
      [...counts.entries()].sort(
        (a, b) => b[1].count - a[1].count || b[1].latestStart - a[1].latestStart
      )[0]?.[0] ?? null
    )
  }
  return preferredSemesterKey([...courses])
}

/**
 * Resolves the effective calendar semester key by separating auto mode
 * (`manualSemesterKey === undefined`) from an explicit user choice
 * (`null` = "全部学期", `string` = chosen semester).
 * - In auto mode, follows `resolveDefaultCalendarSemesterKey(courses, now)` live.
 * - In manual mode, preserves the user's selection as long as it still exists.
 */
export function resolveEffectiveCalendarSemesterKey(
  courses: readonly Course[],
  manualSemesterKey: string | null | undefined,
  now = new Date()
): string | null {
  if (manualSemesterKey === null) return null
  if (manualSemesterKey !== undefined) {
    const exists = courses.some((course) => getCourseSemester(course) === manualSemesterKey)
    if (exists) return manualSemesterKey
  }
  return resolveDefaultCalendarSemesterKey(courses, now)
}

/**
 * Builds collision-free, stable display labels for courses using `course-identity.ts`.
 * When multiple courses share a name (and even a className), escalates to
 * `getCourseClassLabel(course)` and finally appends `shortStableId(course.id)` so
 * same-name teaching classes always remain distinguishable.
 */
export function buildCourseDisplayMap(
  courses: readonly Course[]
): Map<string, CourseDisplayIdentity> {
  const groups = new Map<string, Course[]>()
  for (const course of courses) {
    const key = course.name.trim()
    const list = groups.get(key) ?? []
    list.push(course)
    groups.set(key, list)
  }

  const result = new Map<string, CourseDisplayIdentity>()
  for (const group of groups.values()) {
    if (group.length === 1) {
      const only = group[0]!
      result.set(only.id, {
        title: only.name,
        classTag: null,
        fullLabel: only.name
      })
      continue
    }

    const compactCounts = new Map<string, number>()
    for (const course of group) {
      const compact = course.className?.trim() ?? ''
      if (compact) {
        compactCounts.set(compact, (compactCounts.get(compact) ?? 0) + 1)
      }
    }

    const identityLabelCounts = new Map<string, number>()
    for (const course of group) {
      const label = getCourseClassLabel(course)
      identityLabelCounts.set(label, (identityLabelCounts.get(label) ?? 0) + 1)
    }

    for (const course of group) {
      const compact = course.className?.trim() ?? ''
      let classTag: string
      if (compact && compactCounts.get(compact) === 1) {
        classTag = compact
      } else {
        const fullIdentity = getCourseClassLabel(course)
        if ((identityLabelCounts.get(fullIdentity) ?? 0) === 1) {
          classTag = fullIdentity
        } else {
          classTag = `${fullIdentity} · ID ${shortStableId(course.id)}`
        }
      }
      result.set(course.id, {
        title: course.name,
        classTag,
        fullLabel: `${course.name}（${classTag}）`
      })
    }
  }

  return result
}

export function buildDuplicateCourseNameSet(courses: readonly Course[]): Set<string> {
  const seen = new Map<string, number>()
  for (const course of courses) {
    const key = course.name.trim()
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  return new Set([...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name))
}

export function formatCourseDisambiguatedName(
  course: Course,
  duplicateNames: ReadonlySet<string>
): string {
  if (!duplicateNames.has(course.name.trim())) return course.name
  return `${course.name}（${course.className?.trim() || getCourseClassLabel(course)}）`
}

export function countActionableTasksByCourse(tasks: readonly Task[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    if (!task.courseId || !isTaskActionable(task)) continue
    counts.set(task.courseId, (counts.get(task.courseId) ?? 0) + 1)
  }
  return counts
}

export function getSessionsForDate(
  courses: readonly Course[],
  date: Date
): Array<{ course: Course; session: CourseSession }> {
  const weekday = date.getDay() === 0 ? 7 : date.getDay()
  return dedupeCourseSessions(
    courses.flatMap((course) => {
      if (!isCourseActiveAt(course, date)) return []
      const week = getCourseWindow(course, date).currentWeek
      return course.schedule
        .filter(
          (session) =>
            session.weekday === weekday && (week === null || weekInSchedule(session.weeks, week))
        )
        .map((session) => ({ course, session }))
    })
  ).sort((a, b) => a.session.startTime.localeCompare(b.session.startTime))
}

export function buildDaySessions(
  courses: readonly Course[],
  tasks: readonly Task[],
  date: Date,
  now = new Date()
): ScheduledCourseSession[] {
  const raw = getSessionsForDate(courses, date)
  const pendingByCourse = countActionableTasksByCourse(tasks)
  const todayMatch = isSameLocalDay(date, now)
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const dayStart = startOfLocalDay(date).getTime()
  const todayStart = startOfLocalDay(now).getTime()
  let markedNext = false

  return raw.map(({ course, session }) => {
    const start = parseTimeToMinutes(session.startTime)
    const end = parseTimeToMinutes(session.endTime)
    let state: SessionLiveState = 'later'
    let timeHint = '待上课'

    if (todayMatch) {
      if (nowMinutes >= start && nowMinutes < end) {
        state = 'live'
        timeHint = `上课中 · 剩 ${formatMinutesSpan(end - nowMinutes)}`
      } else if (nowMinutes < start) {
        if (!markedNext) {
          markedNext = true
          state = 'next'
          timeHint = `${formatMinutesSpan(start - nowMinutes)}后上课`
        } else {
          state = 'later'
          timeHint = '待上课'
        }
      } else {
        state = 'done'
        timeHint = '已结束'
      }
    } else if (dayStart < todayStart) {
      state = 'done'
      timeHint = '已结束'
    }

    return {
      course,
      session,
      state,
      timeHint,
      pendingTaskCount: pendingByCourse.get(course.id) ?? 0
    }
  })
}

/**
 * Finds the current or next upcoming class across all courses by evaluating
 * each candidate date against actual active semesters and teaching weeks.
 */
export function findNextUpcomingClass(
  courses: readonly Course[],
  now = new Date(),
  lookaheadDays = 7
): NextClassSummary | null {
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const todayCandidates = selectCoursesActiveAt(courses, now)
  const todaySessions = getSessionsForDate(todayCandidates, now)
  for (const entry of todaySessions) {
    const start = parseTimeToMinutes(entry.session.startTime)
    const end = parseTimeToMinutes(entry.session.endTime)
    if (nowMinutes >= start && nowMinutes < end) {
      return {
        kind: 'live',
        dayOffset: 0,
        date: now,
        course: entry.course,
        session: entry.session,
        timeHint: `剩 ${formatMinutesSpan(end - nowMinutes)}`,
        dayLabel: '今天'
      }
    }
    if (nowMinutes < start) {
      return {
        kind: 'next_today',
        dayOffset: 0,
        date: now,
        course: entry.course,
        session: entry.session,
        timeHint: `${formatMinutesSpan(start - nowMinutes)}后`,
        dayLabel: '今天'
      }
    }
  }

  const todayStart = startOfLocalDay(now)
  for (let offset = 1; offset <= lookaheadDays; offset += 1) {
    const targetDate = addLocalDays(todayStart, offset)
    const activeForDay = selectCoursesActiveAt(courses, targetDate)
    const sessions = getSessionsForDate(activeForDay, targetDate)
    if (sessions.length === 0) continue
    const first = sessions[0]!
    const wd = targetDate.getDay() === 0 ? 7 : targetDate.getDay()
    const dayLabel = offset === 1 ? '明天' : offset === 2 ? '后天' : (WEEKDAY_SHORT[wd] ?? '')
    return {
      kind: 'upcoming_day',
      dayOffset: offset,
      date: targetDate,
      course: first.course,
      session: first.session,
      timeHint: `${dayLabel} ${first.session.startTime}`,
      dayLabel
    }
  }

  return null
}

function isOngoingWithoutEndTrustworthy(exam: Exam, nowMs: number): boolean {
  const startMs = exam.startAt ? Date.parse(exam.startAt) : Number.NaN
  const updatedMs = exam.updatedAt ? Date.parse(exam.updatedAt) : Number.NaN
  const durationMs =
    typeof exam.durationMinutes === 'number' &&
    Number.isFinite(exam.durationMinutes) &&
    exam.durationMinutes > 0
      ? exam.durationMinutes * 60_000
      : null

  const updatedAgeMs = Number.isFinite(updatedMs) ? nowMs - updatedMs : Number.NaN

  // 1. Platform freshly confirmed ongoing within 30 minutes (guarding against future clock skew).
  if (
    Number.isFinite(updatedAgeMs) &&
    updatedAgeMs >= 0 &&
    updatedAgeMs <= EXAM_ONGOING_FRESH_SYNC_MS
  ) {
    return true
  }

  // 2. Bound how long an unrefreshed ongoing status without `endAt` remains trustworthy
  //    using real `startAt`, `durationMinutes`, and `updatedAt` (never fabricating `endAt`).
  const trustFromStartMs =
    durationMs !== null ? durationMs + EXAM_ONGOING_GRACE_MS : EXAM_ONGOING_DEFAULT_TRUST_MS
  const withinStartWindow =
    Number.isFinite(startMs) && nowMs >= startMs && nowMs <= startMs + trustFromStartMs

  const trustFromUpdateMs =
    durationMs !== null
      ? Math.min(durationMs + EXAM_ONGOING_GRACE_MS, EXAM_ONGOING_DEFAULT_TRUST_MS)
      : EXAM_ONGOING_DEFAULT_TRUST_MS
  const withinUpdateWindow =
    Number.isFinite(updatedAgeMs) && updatedAgeMs >= 0 && updatedAgeMs <= trustFromUpdateMs

  if (Number.isFinite(startMs)) {
    if (!withinStartWindow) return false
    if (Number.isFinite(updatedMs) && updatedMs >= startMs) {
      return withinUpdateWindow
    }
    return true
  }

  return withinUpdateWindow
}

/**
 * Classifies an exam conservatively using explicit platform status and real timestamps:
 * - Explicit terminal platform status or real non-placeholder score (including `'0'`) => `'past'`.
 * - Explicit `endAt < nowMs` => `'past'`.
 * - Future `startAt > nowMs` => `'upcoming'`.
 * - Past `startAt <= nowMs` with concrete `endAt >= nowMs` => `'ongoing'`.
 * - Missing `endAt`: NEVER fabricates an end time; only `'ongoing'` when the platform
 *   explicitly reports ongoing AND the cached status is still within its trustworthy window
 *   (`updatedAt`, `startAt`, `durationMinutes`), otherwise `'unknown'` (时间待确认).
 */
export function classifyExamBucket(exam: Exam, nowMs: number): ExamScheduleBucket {
  const examStatus = exam.examStatus?.trim() ?? ''
  const answerStatus = exam.answerStatus?.trim() ?? ''
  const hasScore = hasRealExamScore(exam.score)

  if (
    hasScore ||
    EXAM_TERMINAL_STATUS_RE.test(examStatus) ||
    EXAM_TERMINAL_STATUS_RE.test(answerStatus)
  ) {
    return 'past'
  }

  const explicitOngoing =
    EXAM_ONGOING_STATUS_RE.test(examStatus) || EXAM_ONGOING_STATUS_RE.test(answerStatus)
  const start = exam.startAt ? Date.parse(exam.startAt) : Number.NaN
  const end = exam.endAt ? Date.parse(exam.endAt) : Number.NaN

  if (Number.isFinite(end) && end < nowMs) return 'past'

  if (!Number.isFinite(start)) {
    return explicitOngoing && isOngoingWithoutEndTrustworthy(exam, nowMs) ? 'ongoing' : 'unknown'
  }

  if (start > nowMs) {
    return 'upcoming'
  }

  if (Number.isFinite(end)) {
    return end >= nowMs ? 'ongoing' : 'past'
  }

  return explicitOngoing && isOngoingWithoutEndTrustworthy(exam, nowMs) ? 'ongoing' : 'unknown'
}

export function getUpcomingDashboardExams(
  exams: readonly Exam[],
  courses: readonly Course[],
  now = new Date(),
  options?: { windowDays?: number; limit?: number }
): UpcomingExamsResult {
  const windowDays = options?.windowDays ?? 14
  const limit = options?.limit ?? 3
  const nowMs = now.getTime()
  const horizonMs = nowMs + windowDays * 24 * 3_600_000
  const sevenDayMs = nowMs + 7 * 24 * 3_600_000

  let ongoingCount = 0
  let withinSevenDaysCount = 0
  const candidates: Array<UpcomingExamItem & { sortMs: number }> = []

  for (const exam of exams) {
    const bucket = classifyExamBucket(exam, nowMs)
    if (bucket !== 'ongoing' && bucket !== 'upcoming') continue
    const startMs = exam.startAt ? Date.parse(exam.startAt) : Number.NaN
    if (bucket === 'upcoming' && (!Number.isFinite(startMs) || startMs > horizonMs)) continue

    if (bucket === 'ongoing') {
      ongoingCount += 1
      withinSevenDaysCount += 1
    } else if (Number.isFinite(startMs) && startMs <= sevenDayMs) {
      withinSevenDaysCount += 1
    }

    const endMs = exam.endAt ? Date.parse(exam.endAt) : Number.NaN
    const countdownLabel =
      bucket === 'ongoing'
        ? Number.isFinite(endMs) && endMs > nowMs
          ? `进行中 · 剩 ${formatMinutesSpan((endMs - nowMs) / 60_000)}`
          : '进行中'
        : formatRemainingCompact(exam.startAt!, now).replace(/后截止$/, '后开始')

    candidates.push({
      exam,
      bucket,
      course: findUniqueCourseByName(courses, exam.courseName),
      countdownLabel,
      sortMs: Number.isFinite(startMs) ? startMs : nowMs
    })
  }

  candidates.sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket === 'ongoing' ? -1 : 1
    return a.sortMs - b.sortMs
  })

  return {
    items: candidates.slice(0, limit).map(({ sortMs: _ignored, ...rest }) => rest),
    ongoingCount,
    withinSevenDaysCount
  }
}

export function prioritizeDashboardNotices(
  notices: readonly AppNotice[],
  limit = 4
): PrioritizedNoticesResult {
  const unreadCount = notices.filter((notice) => notice.read === false).length
  const ranked = notices
    .map((notice, index) => ({
      notice,
      index,
      unreadRank: notice.read === false ? 0 : 1,
      publishedMs: Number.isFinite(Date.parse(notice.publishedAt))
        ? Date.parse(notice.publishedAt)
        : 0
    }))
    .sort((a, b) => {
      if (a.unreadRank !== b.unreadRank) return a.unreadRank - b.unreadRank
      if (b.publishedMs !== a.publishedMs) return b.publishedMs - a.publishedMs
      return a.index - b.index
    })
  return {
    items: ranked.slice(0, limit).map((item) => item.notice),
    unreadCount
  }
}

export function groupTasksByLocalDay(tasks: readonly Task[]): Map<string, Task[]> {
  const map = new Map<string, Task[]>()
  for (const task of tasks) {
    if (isDueAtUnknown(task.dueAt)) continue
    const due = new Date(task.dueAt)
    if (!Number.isFinite(due.getTime())) continue
    const key = formatLocalDateKey(due)
    const list = map.get(key) ?? []
    list.push(task)
    map.set(key, list)
  }
  for (const list of map.values()) {
    list.sort((a, b) => {
      const aAct = isTaskActionable(a) ? 0 : 1
      const bAct = isTaskActionable(b) ? 0 : 1
      if (aAct !== bAct) return aAct - bAct
      return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()
    })
  }
  return map
}

export function groupExamsByLocalDay(
  exams: readonly Exam[],
  courses: readonly Course[],
  now = new Date()
): Map<string, DayExamItem[]> {
  const map = new Map<string, DayExamItem[]>()
  const nowMs = now.getTime()
  for (const exam of exams) {
    if (!exam.startAt) continue
    const start = new Date(exam.startAt)
    if (!Number.isFinite(start.getTime())) continue
    const key = formatLocalDateKey(start)
    const list = map.get(key) ?? []
    list.push({
      exam,
      bucket: classifyExamBucket(exam, nowMs),
      course: findUniqueCourseByName(courses, exam.courseName)
    })
    map.set(key, list)
  }
  for (const list of map.values()) {
    list.sort((a, b) => Date.parse(a.exam.startAt ?? '') - Date.parse(b.exam.startAt ?? ''))
  }
  return map
}

export function buildDayAgenda(
  date: Date,
  semesterCourses: readonly Course[],
  tasksByDay: ReadonlyMap<string, Task[]>,
  examsByDay: ReadonlyMap<string, DayExamItem[]>,
  allTasks: readonly Task[],
  now = new Date()
): DayAgenda {
  const key = formatLocalDateKey(date)
  return {
    date,
    dateKey: key,
    sessions: buildDaySessions(semesterCourses, allTasks, date, now),
    exams: examsByDay.get(key) ?? [],
    tasks: tasksByDay.get(key) ?? []
  }
}

/**
 * Computes rendered exams/tasks in a month grid cell and the exact hidden count
 * (`totalCount - renderedCount`), ensuring unrendered exams are never omitted.
 */
export function sliceMonthCellEvents<E, T>(
  dayExams: readonly E[],
  dayTasks: readonly T[],
  maxTotal = 3
): MonthCellEventsSlice<E, T> {
  const firstExams = dayExams.slice(0, Math.min(1, maxTotal))
  const taskSlots = Math.max(0, maxTotal - firstExams.length)
  const visibleTasks = dayTasks.slice(0, taskSlots)
  const extraExamSlots = Math.max(0, maxTotal - firstExams.length - visibleTasks.length)
  const visibleExams =
    extraExamSlots > 0 ? dayExams.slice(0, firstExams.length + extraExamSlots) : firstExams
  const totalCount = dayExams.length + dayTasks.length
  const renderedCount = visibleExams.length + visibleTasks.length
  return {
    visibleExams,
    visibleTasks,
    hiddenCount: Math.max(0, totalCount - renderedCount)
  }
}

/**
 * Splits a day's deadline tasks so evening deadlines (e.g. 22:00 / 23:59) or
 * early-morning deadlines outside the hourly timeline window are surfaced in
 * the dedicated all-day / evening rail instead of being silently dropped.
 */
export function partitionTimelineTasks(
  dayTasks: readonly Task[],
  hourStart = 8,
  hourEnd = 21
): PartitionedTimelineTasks {
  const timed: Task[] = []
  const afterHours: Task[] = []
  const minMinutes = hourStart * 60
  const maxMinutes = hourEnd * 60

  for (const task of dayTasks) {
    const due = new Date(task.dueAt)
    if (!Number.isFinite(due.getTime())) continue
    const minutes = due.getHours() * 60 + due.getMinutes()
    if (minutes >= minMinutes && minutes <= maxMinutes) {
      timed.push(task)
    } else {
      afterHours.push(task)
    }
  }

  return { timed, afterHours }
}

/** Helper to check if a task on a calendar day is an actionable overdue deadline. */
export function isCalendarTaskOverdue(task: Task, now = new Date()): boolean {
  return isTaskActionable(task) && dueBucket(task, now) === 'overdue'
}
