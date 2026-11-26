import { describe, expect, it } from 'vitest'
import type { Chapter, Course, StudyPoint } from '../../src/shared/types'
import { getCourseClassLabel, shortStableId } from '../../src/shared/course-identity'
import { searchStudy } from '../../src/shared/study-search'

const courseA: Course = {
  id: 'course-a',
  externalId: '100:200',
  name: '程序设计基础',
  code: 'CS101',
  category: '专业课',
  teacher: '教师 A',
  semester: '2026 春',
  color: '#123456',
  favorite: false,
  source: 'chaoxing',
  className: '2024级1班',
  clazzId: '200',
  sourceUrl: 'https://mooc1.chaoxing.com/course?cpi=1',
  schedule: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

const courseB: Course = {
  ...courseA,
  id: 'course-b',
  externalId: '100:201',
  className: '2024级2班',
  clazzId: '201',
  color: '#654321'
}

const courseC: Course = {
  ...courseA,
  id: 'course-c',
  externalId: '100:202',
  name: '大学英语',
  code: 'EN101',
  className: null,
  clazzId: null
}

const chapterA: Chapter = {
  id: 'chapter-a',
  courseId: courseA.id,
  externalId: 'chapter-ext-a',
  title: '函数与模块',
  sortOrder: 1,
  progress: 50,
  lastStudiedAt: null,
  sourceUrl: 'https://mooc1.chaoxing.com/chapter/a',
  sections: [],
  source: 'chaoxing',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

const chapterB: Chapter = {
  ...chapterA,
  id: 'chapter-b',
  courseId: courseB.id,
  title: '函数与模块',
  sortOrder: 1
}

const pointA: StudyPoint = {
  id: 'point-a',
  chapterId: chapterA.id,
  courseId: courseA.id,
  externalId: 'point-ext-a',
  title: '函数定义',
  kind: 'video',
  status: 'todo',
  durationMinutes: 12,
  sortOrder: 1,
  source: 'chaoxing',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

describe('course identity', () => {
  it('uses teaching class, course code and class id without inventing values', () => {
    expect(getCourseClassLabel(courseA)).toBe('教学班 2024级1班 · 课程号 CS101 · 班级 200')
    expect(getCourseClassLabel(courseC)).toBe('课程号 EN101')
  })

  it('distinguishes same-name courses with different teaching classes', () => {
    expect(getCourseClassLabel(courseA)).not.toBe(getCourseClassLabel(courseB))
    expect(courseA.name).toBe(courseB.name)
  })

  it('falls back to a stable display id when other identifiers are absent', () => {
    expect(
      getCourseClassLabel({
        ...courseC,
        code: '',
        clazzId: null,
        className: null,
        id: 'course-123456789'
      })
    ).toBe('ID 23456789')
    expect(shortStableId('course-123456789')).toBe('23456789')
  })
})

describe('study search', () => {
  it('searches every course, not only the selected course', () => {
    const results = searchStudy([courseA, courseB], [chapterA, chapterB], [pointA], '大学英语')
    expect(results.some((result) => result.courseId === courseB.id)).toBe(false)
    expect(
      searchStudy([courseA, courseB, courseC], [chapterA], [pointA], '大学英语')[0]
    ).toMatchObject({
      kind: 'course',
      courseId: courseC.id
    })
  })

  it('returns chapter ownership and point chapter ids', () => {
    const chapterResult = searchStudy(
      [courseA, courseB],
      [chapterA, chapterB],
      [pointA],
      '函数与模块'
    )
    expect(chapterResult.filter((result) => result.kind === 'chapter')).toHaveLength(2)
    expect(chapterResult.find((result) => result.courseId === courseB.id)).toMatchObject({
      chapterId: chapterB.id,
      courseId: courseB.id
    })

    const pointResult = searchStudy([courseA], [chapterA], [pointA], '函数定义')[0]
    expect(pointResult).toMatchObject({
      kind: 'point',
      courseId: courseA.id,
      chapterId: chapterA.id,
      pointId: pointA.id
    })
  })

  it('returns an explicit empty list for a query with no matches', () => {
    expect(searchStudy([courseA], [chapterA], [pointA], '完全不存在的关键词')).toEqual([])
  })

  it('keeps course ids stable while showing class context', () => {
    const results = searchStudy([courseA, courseB], [chapterA, chapterB], [], '程序设计')
    expect(results.map((result) => result.courseId).sort()).toEqual([courseA.id, courseB.id])
    expect(results.map((result) => result.classLabel)).toEqual(
      expect.arrayContaining([
        '教学班 2024级1班 · 课程号 CS101 · 班级 200',
        '教学班 2024级2班 · 课程号 CS101 · 班级 201'
      ])
    )
  })
})
