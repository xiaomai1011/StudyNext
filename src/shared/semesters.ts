import type { Course } from './types'
import { semesterWeekOf } from './domain'

export const UNKNOWN_SEMESTER = '学期未标注'

export interface SemesterOption {
  key: string
  label: string
  count: number
  semesterStart: string | null
  maxWeek: number
  reliable: boolean
}

export interface SemesterWindow {
  semesterStart: string | null
  maxWeek: number
  currentWeek: number | null
}

export function getCourseSemester(course: Course): string {
  const value = course.semester?.trim()
  return value || UNKNOWN_SEMESTER
}

function validStart(value: string | null | undefined): string | null {
  if (!value) return null
  const parsed = Date.parse(`${value}T00:00:00+08:00`)
  return Number.isFinite(parsed) ? value : null
}

/**
 * 按平台给出的 semester 字符串分组，不用课程名称、最后登录时间或列表顺序猜测学期。
 * 没有 semester 的课程全部归入“学期未标注”。
 */
export function listSemesterOptions(courses: Course[]): SemesterOption[] {
  const groups = new Map<string, SemesterOption>()
  for (const course of courses) {
    const label = getCourseSemester(course)
    const key = label
    const current = groups.get(key) ?? {
      key,
      label,
      count: 0,
      semesterStart: null,
      maxWeek: 0,
      reliable: false
    }
    current.count += 1
    const start = validStart(course.semesterStart)
    if (start) {
      current.reliable = true
      if (!current.semesterStart) {
        current.semesterStart = start
      }
    }
    if (course.maxWeek && course.maxWeek > current.maxWeek) {
      current.maxWeek = course.maxWeek
    }
    groups.set(key, current)
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
}

/**
 * 只在证据足够时推断“当前学期”：
 * - 有可靠 semesterStart 时，选开始时间最晚的一组；
 * - 没有可靠日期但只有一个学期分组时，使用该分组；
 * - 多组且无日期时返回 null，表示不做猜测，显示全部学期。
 */
export function preferredSemesterKey(courses: Course[]): string | null {
  const options = listSemesterOptions(courses)
  const dated = options.filter((option) => option.semesterStart !== null)
  if (dated.length > 0) {
    return [...dated].sort((a, b) => {
      const aTime = Date.parse(`${a.semesterStart}T00:00:00+08:00`)
      const bTime = Date.parse(`${b.semesterStart}T00:00:00+08:00`)
      return bTime - aTime || b.count - a.count
    })[0]!.key
  }
  return options.length === 1 ? options[0]!.key : null
}

export function coursesForSemester(courses: Course[], key: string | null): Course[] {
  if (!key) return courses
  return courses.filter((course) => getCourseSemester(course) === key)
}

/**
 * 只使用选中学期课程的时间证据。多个不同 semesterStart 时取出现次数最多的一组，
 * 避免单门异常课程把整张课表推到错误周次。
 */
export function getSemesterWindow(courses: Course[], now = new Date()): SemesterWindow {
  const starts = new Map<string, number>()
  let maxWeek = 0
  for (const course of courses) {
    const start = validStart(course.semesterStart)
    if (start) starts.set(start, (starts.get(start) ?? 0) + 1)
    if (course.maxWeek && course.maxWeek > maxWeek) maxWeek = course.maxWeek
  }
  const semesterStart =
    [...starts.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0]?.[0] ?? null
  return {
    semesterStart,
    maxWeek,
    currentWeek: semesterWeekOf(now, semesterStart)
  }
}

/**
 * 每个课程只使用自己的学期证据计算周次。
 * 全部学期模式下不能用某个“代表课程”的开学日期判断所有课程。
 */
export function getCourseWindow(course: Course, now = new Date()): SemesterWindow {
  return getSemesterWindow([course], now)
}

/**
 * 当前日期是否在课程所属学期的有效教学周内。
 * 没有可靠开学日期时不做猜测，保留课程；有日期但在开学前/超过最大周次时隐藏。
 */
export function isCourseActiveAt(course: Course, now = new Date()): boolean {
  const window = getCourseWindow(course, now)
  if (window.currentWeek === null) return true
  if (window.currentWeek < 1) return false
  return window.maxWeek <= 0 || window.currentWeek <= window.maxWeek
}
