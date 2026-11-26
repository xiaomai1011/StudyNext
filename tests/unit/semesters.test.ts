import { describe, expect, it } from 'vitest'
import type { Course } from '@shared/types'
import {
  UNKNOWN_SEMESTER,
  coursesForSemester,
  getCourseSemester,
  getCourseWindow,
  getSemesterWindow,
  isCourseActiveAt,
  listSemesterOptions,
  preferredSemesterKey
} from '@shared/semesters'

const stamp = '2026-09-01T00:00:00.000Z'

function makeCourse(
  id: string,
  semester: string,
  semesterStart: string | null = null,
  maxWeek = 0
): Course {
  return {
    id,
    externalId: `ext-${id}`,
    name: `课程 ${id}`,
    code: '',
    teacher: '',
    semester,
    category: '',
    color: '#000000',
    favorite: false,
    clazzId: null,
    className: null,
    schedule: [],
    semesterStart,
    maxWeek,
    source: 'chaoxing',
    sourceUrl: null,
    createdAt: stamp,
    updatedAt: stamp
  }
}

describe('semester context', () => {
  it('semester 为空时归入未标注，不用课程名猜测', () => {
    expect(getCourseSemester(makeCourse('a', ''))).toBe(UNKNOWN_SEMESTER)
  })

  it('按 semester 字符串分组并保留可靠日期和最大周次', () => {
    const options = listSemesterOptions([
      makeCourse('a', '2026 秋季', '2026-09-01', 18),
      makeCourse('b', '2026 秋季', '2026-09-01', 20),
      makeCourse('c', '2026 春季', null, 16),
      makeCourse('d', '')
    ])
    expect(options).toHaveLength(3)
    const autumn = options.find((option) => option.key === '2026 秋季')
    expect(autumn).toMatchObject({
      count: 2,
      semesterStart: '2026-09-01',
      maxWeek: 20,
      reliable: true
    })
    expect(options.find((option) => option.key === UNKNOWN_SEMESTER)?.reliable).toBe(false)
  })

  it('有可靠日期时选择开始时间最晚的学期', () => {
    const courses = [
      makeCourse('a', '2025 秋季', '2025-09-01'),
      makeCourse('b', '2026 秋季', '2026-09-01'),
      makeCourse('c', '2026 春季', '2026-02-20')
    ]
    expect(preferredSemesterKey(courses)).toBe('2026 秋季')
  })

  it('只有一个无日期学期时可以选择它', () => {
    expect(preferredSemesterKey([makeCourse('a', '2026 秋季')])).toBe('2026 秋季')
  })

  it('多个无日期学期时不猜测，返回 null 表示全部学期', () => {
    expect(
      preferredSemesterKey([makeCourse('a', '2026 秋季'), makeCourse('b', '2026 春季')])
    ).toBeNull()
  })

  it('按学期筛选课程', () => {
    const courses = [
      makeCourse('a', '2026 秋季'),
      makeCourse('b', '2026 春季'),
      makeCourse('c', '')
    ]
    expect(coursesForSemester(courses, '2026 秋季').map((course) => course.id)).toEqual(['a'])
    expect(coursesForSemester(courses, UNKNOWN_SEMESTER).map((course) => course.id)).toEqual(['c'])
    expect(coursesForSemester(courses, null)).toHaveLength(3)
  })

  it('课表窗口取多数课程的学期开始日期与最大周次', () => {
    const courses = [
      makeCourse('a', '2026 秋季', '2026-09-01', 18),
      makeCourse('b', '2026 秋季', '2026-09-01', 20),
      makeCourse('c', '异常学期', '2026-10-01', 30)
    ]
    const window = getSemesterWindow(courses, new Date('2026-09-15T12:00:00+08:00'))
    expect(window.semesterStart).toBe('2026-09-01')
    expect(window.maxWeek).toBe(30)
    expect(window.currentWeek).toBe(3)
  })

  it('没有学期开始日期时当前周为 null，不自行猜测', () => {
    const window = getSemesterWindow(
      [makeCourse('a', '未知学期', null, 18)],
      new Date('2026-09-15T12:00:00+08:00')
    )
    expect(window.semesterStart).toBeNull()
    expect(window.currentWeek).toBeNull()
    expect(window.maxWeek).toBe(18)
  })

  it('全部学期模式下每门课程使用自己的开学日期，春季结束不混入秋季周次', () => {
    const spring = makeCourse('spring', '2026 春季', '2026-02-23', 18)
    const autumn = makeCourse('autumn', '2026 秋季', '2026-09-07', 18)
    const now = new Date('2026-09-14T12:00:00+08:00')

    expect(getCourseWindow(spring, now)).toMatchObject({
      semesterStart: '2026-02-23',
      maxWeek: 18,
      currentWeek: 30
    })
    expect(getCourseWindow(autumn, now)).toMatchObject({
      semesterStart: '2026-09-07',
      maxWeek: 18,
      currentWeek: 2
    })
    expect(isCourseActiveAt(spring, now)).toBe(false)
    expect(isCourseActiveAt(autumn, now)).toBe(true)
  })

  it('开学前和超过最大教学周都判定为非当前课程', () => {
    const course = makeCourse('a', '2026 秋季', '2026-09-07', 18)
    expect(isCourseActiveAt(course, new Date('2026-09-01T12:00:00+08:00'))).toBe(false)
    expect(isCourseActiveAt(course, new Date('2026-09-07T12:00:00+08:00'))).toBe(true)
    expect(isCourseActiveAt(course, new Date('2027-01-20T12:00:00+08:00'))).toBe(false)
  })

  it('没有可靠开学日期的课程不被猜测，也不因共享窗口被隐藏', () => {
    const course = makeCourse('unknown', '学期未标注', null, 18)
    expect(isCourseActiveAt(course, new Date('2026-09-14T12:00:00+08:00'))).toBe(true)
  })

  it('空课程列表返回空窗口', () => {
    const window = getSemesterWindow([], new Date('2026-09-15T12:00:00+08:00'))
    expect(window).toEqual({ semesterStart: null, maxWeek: 0, currentWeek: null })
  })
})
