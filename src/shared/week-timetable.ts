import type { CourseSession } from './types'

export interface WeekPeriod {
  key: string
  label: string
  start: string
  end: string
  fixed: boolean
}

export const FIXED_WEEK_PERIODS: WeekPeriod[] = [
  { key: 'fixed-0', label: '第 1 节', start: '08:20', end: '10:00', fixed: true },
  { key: 'fixed-1', label: '第 2 节', start: '10:20', end: '12:00', fixed: true },
  { key: 'fixed-2', label: '第 3 节', start: '14:00', end: '15:40', fixed: true },
  { key: 'fixed-3', label: '第 4 节', start: '16:00', end: '17:40', fixed: true },
  { key: 'fixed-4', label: '第 5 节', start: '18:40', end: '20:20', fixed: true }
]

const FIXED_PERIOD_MATCH_WINDOWS: ReadonlyArray<{ start: string; end: string }> = [
  { start: '07:50', end: '09:59' },
  { start: '10:00', end: '12:15' },
  { start: '13:30', end: '15:59' },
  { start: '16:00', end: '18:10' },
  { start: '18:20', end: '20:20' }
]

function fixedPeriodIndex(session: CourseSession): number {
  return FIXED_PERIOD_MATCH_WINDOWS.findIndex(
    (window) => session.startTime >= window.start && session.startTime < window.end
  )
}

/**
 * 每个 session 只能归属于一个时间行：
 * - 开始时间落在标准五节教学时段窗口内（兼容 08:00/08:20、10:00/10:20 等高校作息）时归固定节次；
 * - 否则按完整开始/结束时间生成动态行。
 * 固定节次若匹配到同一作息时段，则直接显示该校真实起止时间，避免产生重叠空行。
 */
export function weekPeriodKey(session: CourseSession): string {
  const fixedIndex = fixedPeriodIndex(session)
  return fixedIndex >= 0
    ? FIXED_WEEK_PERIODS[fixedIndex]!.key
    : `time-${session.startTime}-${session.endTime}`
}

export function buildWeekPeriods(sessions: CourseSession[]): WeekPeriod[] {
  const fixedBounds = new Map<string, { start: string; end: string }>()
  const custom = new Map<string, WeekPeriod>()
  for (const session of sessions) {
    const fixedIdx = fixedPeriodIndex(session)
    if (fixedIdx >= 0) {
      const key = FIXED_WEEK_PERIODS[fixedIdx]!.key
      const existing = fixedBounds.get(key)
      if (!existing) {
        fixedBounds.set(key, { start: session.startTime, end: session.endTime })
      } else {
        fixedBounds.set(key, {
          start: session.startTime < existing.start ? session.startTime : existing.start,
          end: session.endTime > existing.end ? session.endTime : existing.end
        })
      }
      continue
    }
    const key = weekPeriodKey(session)
    if (custom.has(key)) continue
    custom.set(key, {
      key,
      label: `${session.startTime}–${session.endTime}`,
      start: session.startTime,
      end: session.endTime,
      fixed: false
    })
  }
  const fixedPeriods = FIXED_WEEK_PERIODS.map((period) => {
    const actual = fixedBounds.get(period.key)
    return actual ? { ...period, start: actual.start, end: actual.end } : period
  })
  return [...fixedPeriods, ...custom.values()].sort(
    (a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end)
  )
}

export function sessionMatchesPeriod(session: CourseSession, period: WeekPeriod): boolean {
  return weekPeriodKey(session) === period.key
}
