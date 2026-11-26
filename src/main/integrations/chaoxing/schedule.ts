import type { CourseSession } from '@shared/types'
import { ChaoxingParseError } from './parsers'

/**
 * 学习通课表（kb.chaoxing.com/pc/curriculum/getMyLessons）解析。
 *
 * 协议要点：
 * - 不带 week 参数只返回“当前周”的课，weeks 字段就是当前周数；
 * - 要拿全学期必须 week=1..maxWeek 逐周拉取，再按课程/星期/节次聚合；
 * - dayOfWeek 是 1 基（1=周一 … 7=周日）；
 * - lessonTimeConfigArray 是学校真实节次表，格式如 "8:00-8:50"。
 */

export interface SectionTime {
  start: string
  end: string
}

export interface RawScheduleLesson {
  lessonId: string
  name: string
  teacherName: string
  location: string
  dayOfWeek: number
  beginNumber: number
  length: number
  weeks: string
  courseId: string | null
}

export interface SchedulePayload {
  semesterStart: string | null
  maxWeek: number
  currentWeek: number
  sections: SectionTime[]
  lessons: RawScheduleLesson[]
}

export interface AggregatedScheduleLesson extends RawScheduleLesson {
  weekNumbers: number[]
}

export interface ChaoxingSchedule {
  semesterStart: string | null
  maxWeek: number
  currentWeek: number
  sections: SectionTime[]
  lessons: AggregatedScheduleLesson[]
}

const DEFAULT_SECTIONS: SectionTime[] = [
  { start: '08:00', end: '08:45' },
  { start: '08:55', end: '09:40' },
  { start: '10:00', end: '10:45' },
  { start: '10:55', end: '11:40' },
  { start: '14:00', end: '14:45' },
  { start: '14:55', end: '15:40' },
  { start: '16:00', end: '16:45' },
  { start: '16:55', end: '17:40' },
  { start: '19:00', end: '19:45' },
  { start: '19:55', end: '20:40' },
  { start: '20:50', end: '21:35' },
  { start: '21:45', end: '22:30' }
]

export function parseSchedulePayload(raw: unknown): SchedulePayload {
  if (!raw || typeof raw !== 'object') {
    throw new ChaoxingParseError('UNEXPECTED_PAGE', '课表接口返回非 JSON 对象')
  }
  const root = raw as { result?: unknown; data?: unknown; msg?: unknown }
  if (root.result !== 1 && root.result !== '1') {
    throw new ChaoxingParseError(
      'UNEXPECTED_PAGE',
      `课表接口返回失败${typeof root.msg === 'string' ? `：${root.msg}` : ''}`
    )
  }
  const data =
    root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : {}
  const curriculum =
    data.curriculum && typeof data.curriculum === 'object'
      ? (data.curriculum as Record<string, unknown>)
      : {}
  const lessonArray = Array.isArray(data.lessonArray) ? data.lessonArray : []
  return {
    semesterStart: readSemesterStart(curriculum),
    maxWeek: clampInt(curriculum.maxWeek, 1, 30, 20),
    currentWeek: clampInt(curriculum.currentWeek, 1, 30, 1),
    sections: parseSectionTimes(curriculum.lessonTimeConfigArray),
    lessons: lessonArray
      .map((item) => parseLesson(item))
      .filter((item): item is RawScheduleLesson => item !== null)
  }
}

export function parseScheduleWeeksPayload(raw: unknown): ChaoxingSchedule {
  const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
  if (!parsed || typeof parsed !== 'object') {
    throw new ChaoxingParseError('UNEXPECTED_PAGE', '课表页返回非 JSON 对象')
  }
  const root = parsed as { curriculum?: unknown; weeks?: unknown }
  const curriculum =
    root.curriculum && typeof root.curriculum === 'object'
      ? (root.curriculum as Record<string, unknown>)
      : {}
  const weeks = Array.isArray(root.weeks) ? root.weeks : []
  const merged = new Map<string, { lesson: RawScheduleLesson; weekNumbers: number[] }>()
  let observedMaxWeek = 0
  for (const entry of weeks) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as { week?: unknown; lessons?: unknown }
    const week = toInt(item.week)
    if (week < 1) continue
    observedMaxWeek = Math.max(observedMaxWeek, week)
    if (!Array.isArray(item.lessons)) continue
    for (const rawLesson of item.lessons) {
      const lesson = parseLesson(rawLesson)
      if (!lesson) continue
      // 学习通课表每次请求返回的 lessonId 是“周次实例”级别（同一门课每周不同），
      // 合并时不能用 lessonId 作为键，否则一门课会被拆成十几个单周节次。
      const key = [
        lesson.dayOfWeek,
        lesson.beginNumber,
        lesson.length,
        lesson.location,
        lesson.teacherName,
        lesson.name
      ].join('|')
      const existing = merged.get(key)
      if (existing) {
        existing.weekNumbers.push(week)
      } else {
        merged.set(key, { lesson, weekNumbers: [week] })
      }
    }
  }
  const declaredMax = clampInt(curriculum.maxWeek, 1, 30, observedMaxWeek || 20)
  return {
    semesterStart: readSemesterStart(curriculum),
    maxWeek: Math.max(declaredMax, observedMaxWeek),
    currentWeek: clampInt(curriculum.currentWeek, 1, 30, 1),
    sections: parseSectionTimes(curriculum.lessonTimeConfigArray),
    lessons: [...merged.values()].map(({ lesson, weekNumbers }) => ({
      ...lesson,
      weeks: compressWeeks(weekNumbers),
      weekNumbers
    }))
  }
}

export function parseSectionTimes(value: unknown): SectionTime[] {
  if (!Array.isArray(value)) return DEFAULT_SECTIONS
  const sections: SectionTime[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const match = /^\s*(\d{1,2}):(\d{2})\s*[-–~]\s*(\d{1,2}):(\d{2})\s*$/.exec(item)
    if (!match) continue
    const [, sh, sm, eh, em] = match
    sections.push({
      start: `${String(Number(sh)).padStart(2, '0')}:${sm}`,
      end: `${String(Number(eh)).padStart(2, '0')}:${em}`
    })
  }
  return sections.length > 0 ? sections : DEFAULT_SECTIONS
}

export function compressWeeks(weeks: number[]): string {
  const sorted = [...new Set(weeks)]
    .filter((w) => Number.isFinite(w) && w > 0)
    .sort((a, b) => a - b)
  if (sorted.length === 0) return ''
  const parts: string[] = []
  let start = sorted[0] as number
  let previous = start
  for (const week of sorted.slice(1)) {
    if (week === previous + 1) {
      previous = week
      continue
    }
    parts.push(start === previous ? String(start) : `${start}-${previous}`)
    start = week
    previous = week
  }
  parts.push(start === previous ? String(start) : `${start}-${previous}`)
  return parts.join(',')
}

export function lessonToSession(
  lesson: AggregatedScheduleLesson,
  sections: SectionTime[]
): CourseSession | null {
  if (lesson.dayOfWeek < 1 || lesson.dayOfWeek > 7) return null
  const begin = Math.max(1, Math.min(lesson.beginNumber, sections.length))
  const endIndex = Math.max(
    begin,
    Math.min(begin + Math.max(1, lesson.length) - 1, sections.length)
  )
  const start = sections[begin - 1]
  const end = sections[endIndex - 1]
  if (!start || !end) return null
  return {
    id: `${lesson.lessonId || lesson.name}-${lesson.dayOfWeek}-${begin}`,
    weekday: lesson.dayOfWeek as CourseSession['weekday'],
    startTime: start.start,
    endTime: end.end,
    location: lesson.location,
    weeks: compressWeeks(lesson.weekNumbers)
  }
}

export function normalizeCourseName(value: string): string {
  return value.replace(/[\s\u200b\u00a0]+/g, '').toLowerCase()
}

function parseLesson(value: unknown): RawScheduleLesson | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const name = typeof item.name === 'string' ? item.name.trim() : ''
  if (!name) return null
  const dayOfWeek = toInt(item.dayOfWeek)
  const beginNumber = toInt(item.beginNumber)
  if (dayOfWeek < 1 || dayOfWeek > 7 || beginNumber < 1) return null
  const length = Math.max(1, toInt(item.length) || 1)
  return {
    lessonId: typeof item.lessonId === 'string' ? item.lessonId : String(item.lessonId ?? ''),
    name,
    teacherName: typeof item.teacherName === 'string' ? item.teacherName.trim() : '',
    location: typeof item.location === 'string' ? item.location.trim() : '',
    dayOfWeek,
    beginNumber,
    length,
    weeks: typeof item.weeks === 'string' ? item.weeks : String(item.weeks ?? ''),
    courseId: item.courseId != null ? String(item.courseId) : null
  }
}

function readSemesterStart(curriculum: Record<string, unknown>): string | null {
  const raw = curriculum.firstWeekDate ?? curriculum.firstWeekDateReal
  if (raw == null) return null
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms <= 0) return null
  // firstWeekDate 是第 1 周周一 00:00（北京时间），按 UTC+8 取日期，避免 UTC 偏移成周日。
  return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10)
}

function toInt(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : 0
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}
