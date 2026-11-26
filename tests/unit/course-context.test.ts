import { describe, expect, it } from 'vitest'
import { UNKNOWN_DUE_AT } from '../../src/shared/constants'
import type { Chapter, Course, Exam, Task } from '../../src/shared/types'
import {
  examsForCourse,
  findUniqueCourseByName,
  getChapterOfficialUrl,
  getCourseOfficialUrl,
  isAmbiguousCourseName,
  sortCourseWorkspaceTasks
} from '../../src/shared/course-context'

function course(overrides: Partial<Course>): Course {
  return {
    id: 'course-1',
    name: '程序设计基础',
    code: 'CS101',
    teacher: '张老师',
    semester: '2025 秋',
    category: '专业课',
    color: '#2c5f7c',
    source: 'demo',
    sourceUrl: null,
    ...overrides
  } as Course
}

describe('course context helpers', () => {
  it('returns a course only when the name identifies exactly one course', () => {
    const unique = course({ id: 'a' })
    expect(findUniqueCourseByName([unique], '程序设计基础')?.id).toBe('a')
    expect(findUniqueCourseByName([unique], '  程序设计基础  ')?.id).toBe('a')
    expect(findUniqueCourseByName([unique], '不存在')).toBeNull()
    expect(findUniqueCourseByName([unique], '')).toBeNull()
  })

  it('rejects ambiguous same-name courses instead of picking the first', () => {
    const courses = [course({ id: 'a', clazzId: '101' }), course({ id: 'b', clazzId: '102' })]
    expect(findUniqueCourseByName(courses, '程序设计基础')).toBeNull()
  })

  it('returns only a verified official URL', () => {
    expect(getCourseOfficialUrl(course({ sourceUrl: 'https://mooc1.chaoxing.com/course/1' }))).toBe(
      'https://mooc1.chaoxing.com/course/1'
    )
    expect(getCourseOfficialUrl(course({ sourceUrl: 'http://mooc1.chaoxing.com/course/1' }))).toBe(
      'https://mooc1.chaoxing.com/course/1'
    )
    expect(getCourseOfficialUrl(course({ sourceUrl: 'https://evil.example/course/1' }))).toBeNull()
    expect(getCourseOfficialUrl(course({ sourceUrl: '   ' }))).toBeNull()
    expect(getCourseOfficialUrl(course({ sourceUrl: null }))).toBeNull()
    expect(getCourseOfficialUrl(null)).toBeNull()
  })

  it('resolves chapter official URLs with allowlist enforcement and course fallback', () => {
    const validCourse = course({ sourceUrl: 'https://mooc1.chaoxing.com/course/1' })
    const chapter = {
      sourceUrl: 'https://evil.example/chapter',
      sections: [
        {
          number: '1.1',
          title: '绪论',
          completed: false,
          locked: false,
          pendingCount: 1,
          sourceUrl: 'https://evil.example/sec',
          resources: []
        }
      ]
    } satisfies Pick<Chapter, 'sourceUrl' | 'sections'>

    expect(getChapterOfficialUrl(validCourse, chapter)).toBe('https://mooc1.chaoxing.com/course/1')
    expect(
      getChapterOfficialUrl(validCourse, {
        ...chapter,
        sections: [{ ...chapter.sections[0]!, sourceUrl: 'http://mooc1.chaoxing.com/sec/1' }]
      })
    ).toBe('https://mooc1.chaoxing.com/sec/1')
    // Locked sections must never be chosen as chapter official entry URLs
    expect(
      getChapterOfficialUrl(validCourse, {
        sourceUrl: 'https://mooc1.chaoxing.com/chapter/1',
        sections: [
          {
            ...chapter.sections[0]!,
            locked: true,
            sourceUrl: 'https://mooc1.chaoxing.com/sec/locked'
          }
        ]
      })
    ).toBe('https://mooc1.chaoxing.com/chapter/1')
    expect(
      getChapterOfficialUrl(course({ sourceUrl: null }), {
        sourceUrl: null,
        sections: [
          {
            ...chapter.sections[0]!,
            locked: true,
            sourceUrl: 'https://mooc1.chaoxing.com/sec/locked'
          }
        ]
      })
    ).toBeNull()
    expect(getChapterOfficialUrl(course({ sourceUrl: null }), chapter)).toBeNull()
  })

  it('detects ambiguous same-name courses and sorts course tasks with active work first', () => {
    const classA = course({ id: 'a', clazzId: '101' })
    const classB = course({ id: 'b', clazzId: '102' })
    expect(isAmbiguousCourseName(classA, [classA])).toBe(false)
    expect(isAmbiguousCourseName(classA, [classA, classB])).toBe(true)

    const now = new Date('2026-11-24T10:00:00.000Z')
    const makeTask = (id: string, overrides: Partial<Task>): Task =>
      ({
        id,
        title: id,
        description: '',
        courseId: 'a',
        priority: 'medium',
        kind: 'homework',
        status: 'todo',
        dueAt: '2026-11-25T10:00:00.000Z',
        completedAt: null,
        completionSource: null,
        source: 'chaoxing',
        externalId: id,
        sourceUpdatedAt: null,
        sourceUrl: null,
        platformStatus: null,
        platformStatusKind: 'not_submitted',
        submittedAt: null,
        score: null,
        fullScore: null,
        teacherFeedback: null,
        attachments: [],
        manualFields: [],
        fieldSources: {},
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
        reminders: [],
        ...overrides
      }) as Task

    const ordered = sortCourseWorkspaceTasks(
      [
        makeTask('old-done', {
          dueAt: '2026-09-10T10:00:00.000Z',
          status: 'done',
          platformStatusKind: 'reviewed'
        }),
        makeTask('submitted', {
          dueAt: '2026-11-20T10:00:00.000Z',
          platformStatusKind: 'submitted'
        }),
        makeTask('overdue-old', { dueAt: '2026-10-01T10:00:00.000Z' }),
        makeTask('overdue-recent', { dueAt: '2026-11-24T09:00:00.000Z' }),
        makeTask('upcoming-later', { dueAt: '2026-11-28T10:00:00.000Z' }),
        makeTask('upcoming-soon', { dueAt: '2026-11-24T11:00:00.000Z' }),
        makeTask('unknown-due', { dueAt: UNKNOWN_DUE_AT })
      ],
      now
    )

    expect(ordered.map((t) => t.id)).toEqual([
      'upcoming-soon',
      'upcoming-later',
      'overdue-recent',
      'overdue-old',
      'unknown-due',
      'submitted',
      'old-done'
    ])
  })

  it('attaches exams to a course only when its name is unique', () => {
    const exam = {
      id: 'exam-1',
      externalId: 'exam-ext-1',
      title: '期中考试',
      courseName: '程序设计基础',
      startAt: null,
      endAt: null,
      durationMinutes: null,
      examStatus: '',
      answerStatus: '',
      score: null,
      mode: null,
      sourceUrl: null,
      source: 'chaoxing' as const,
      updatedAt: '2026-11-01T00:00:00.000Z'
    } satisfies Exam

    expect(examsForCourse(course({ id: 'a' }), [course({ id: 'a' })], [exam])).toEqual([exam])
    expect(
      examsForCourse(
        course({ id: 'a', clazzId: '101' }),
        [course({ id: 'a', clazzId: '101' }), course({ id: 'b', clazzId: '102' })],
        [exam]
      )
    ).toEqual([])
    expect(
      examsForCourse(course({ id: 'a' }), [course({ id: 'a' })], [{ ...exam, courseName: null }])
    ).toEqual([])
  })
})
