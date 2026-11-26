import { describe, expect, it } from 'vitest'
import type { CourseSession } from '@shared/types'
import { buildWeekPeriods, sessionMatchesPeriod, weekPeriodKey } from '@shared/week-timetable'

function session(id: string, startTime: string, endTime: string): CourseSession {
  return {
    id,
    weekday: 1,
    startTime,
    endTime,
    location: '',
    weeks: ''
  }
}

describe('week timetable period assignment', () => {
  it('重叠但起止时间不同的课程各自只属于一个动态时间行', () => {
    const a = session('a', '20:30', '22:00')
    const b = session('b', '21:00', '22:30')
    const periods = buildWeekPeriods([a, b])

    expect(weekPeriodKey(a)).toBe('time-20:30-22:00')
    expect(weekPeriodKey(b)).toBe('time-21:00-22:30')
    expect(periods).toHaveLength(7)
    for (const item of [a, b]) {
      expect(periods.filter((period) => sessionMatchesPeriod(item, period))).toHaveLength(1)
    }
    expect(periods.some((period) => period.key === weekPeriodKey(a))).toBe(true)
    expect(periods.some((period) => period.key === weekPeriodKey(b))).toBe(true)
  })

  it('开始时间相同、结束时间不同不会被合并', () => {
    const a = session('a', '20:30', '21:30')
    const b = session('b', '20:30', '22:00')
    expect(weekPeriodKey(a)).not.toBe(weekPeriodKey(b))
    expect(buildWeekPeriods([a, b])).toHaveLength(7)
  })

  it('结束时间相同、开始时间不同不会被错误分配', () => {
    const a = session('a', '20:30', '22:00')
    const b = session('b', '21:00', '22:00')
    const periods = buildWeekPeriods([a, b])

    expect(weekPeriodKey(a)).not.toBe(weekPeriodKey(b))
    expect(periods.filter((period) => sessionMatchesPeriod(b, period))).toHaveLength(1)
    expect(sessionMatchesPeriod(b, periods.find((p) => p.key === weekPeriodKey(a))!)).toBe(false)
  })

  it('完全相同时间段的课程共用一行，但每门课只匹配一次', () => {
    const a = session('a', '20:30', '22:00')
    const b = session('b', '20:30', '22:00')
    const periods = buildWeekPeriods([a, b])
    const matches = periods.filter((period) => sessionMatchesPeriod(a, period))

    expect(weekPeriodKey(a)).toBe(weekPeriodKey(b))
    expect(periods).toHaveLength(6)
    expect(matches).toHaveLength(1)
    expect(matches[0]!.label).toBe('20:30–22:00')
  })

  it('固定五节课内的课程仍使用固定时间行', () => {
    const fixed = session('fixed', '08:30', '09:50')
    const periods = buildWeekPeriods([fixed])

    expect(weekPeriodKey(fixed)).toBe('fixed-0')
    expect(periods).toHaveLength(5)
    expect(periods.filter((period) => sessionMatchesPeriod(fixed, period))).toHaveLength(1)
  })

  it('08:00 与 10:00 开课的高校作息自动归入第 1/2 节并展示真实起止时间，不生成幽灵空行', () => {
    const s1 = session('s1', '08:00', '09:40')
    const s2 = session('s2', '10:00', '11:40')
    const periods = buildWeekPeriods([s1, s2])

    expect(weekPeriodKey(s1)).toBe('fixed-0')
    expect(weekPeriodKey(s2)).toBe('fixed-1')
    expect(periods).toHaveLength(5)
    expect(periods[0]).toMatchObject({ key: 'fixed-0', start: '08:00', end: '09:40' })
    expect(periods[1]).toMatchObject({ key: 'fixed-1', start: '10:00', end: '11:40' })
  })
})
