import { describe, expect, it } from 'vitest'
import type { Chapter, Course, StudyPoint } from '@shared/types'
import { getCourseProgress, getGlobalProgress } from '@shared/study-progress'

const stamp = '2026-09-01T00:00:00.000Z'

function makeCourse(id: string, name = id): Course {
  return {
    id,
    externalId: `ext-${id}`,
    name,
    code: '',
    teacher: '',
    semester: '2026 秋季',
    category: '',
    color: '#000000',
    favorite: false,
    clazzId: null,
    className: null,
    schedule: [],
    semesterStart: '2026-09-01',
    maxWeek: 18,
    source: 'chaoxing',
    sourceUrl: null,
    createdAt: stamp,
    updatedAt: stamp
  }
}

function makeChapter(id: string, courseId: string, sortOrder = 0): Chapter {
  return {
    id,
    courseId,
    externalId: null,
    title: `章节 ${id}`,
    sortOrder,
    progress: 0,
    lastStudiedAt: null,
    sourceUrl: null,
    sections: [],
    source: 'chaoxing',
    createdAt: stamp,
    updatedAt: stamp
  }
}

function makePoint(id: string, courseId: string, chapterId: string, done = false): StudyPoint {
  return {
    id,
    chapterId,
    courseId,
    externalId: null,
    title: `任务点 ${id}`,
    kind: 'video',
    status: done ? 'done' : 'todo',
    durationMinutes: null,
    sortOrder: 0,
    source: 'chaoxing',
    createdAt: stamp,
    updatedAt: stamp
  }
}

describe('study progress', () => {
  it('有章节但没有任务点时返回 no_tasks，不虚构 100%', () => {
    const course = makeCourse('a')
    const chapters = [makeChapter('c1', 'a'), makeChapter('c2', 'a')]
    const result = getCourseProgress('a', chapters, [])
    expect(result.chapterCount).toBe(2)
    expect(result.total).toBe(0)
    expect(result.done).toBe(0)
    expect(result.percent).toBeNull()
    expect(result.state).toBe('no_tasks')
  })

  it('一章多个任务点时以任务点数量为分母，而不是章节数量', () => {
    const course = makeCourse('a')
    const chapters = [makeChapter('c1', 'a')]
    const points = [
      makePoint('p1', 'a', 'c1', true),
      makePoint('p2', 'a', 'c1', true),
      makePoint('p3', 'a', 'c1'),
      makePoint('p4', 'a', 'c1')
    ]
    const result = getCourseProgress('a', chapters, points)
    expect(result.total).toBe(4)
    expect(result.done).toBe(2)
    expect(result.percent).toBe(50)
    expect(result.state).toBe('ready')
  })

  it('多章节多任务点分别归属，不会把其他课程的点算入', () => {
    const chapters = [makeChapter('a1', 'a'), makeChapter('a2', 'a'), makeChapter('b1', 'b')]
    const points = [
      makePoint('a-p1', 'a', 'a1', true),
      makePoint('a-p2', 'a', 'a2'),
      makePoint('b-p1', 'b', 'b1', true),
      makePoint('b-p2', 'b', 'b1', true)
    ]
    expect(getCourseProgress('a', chapters, points).percent).toBe(50)
    expect(getCourseProgress('b', chapters, points).percent).toBe(100)
  })

  it('空课程返回 empty，没有章节也没有任务点', () => {
    const result = getCourseProgress('empty', [], [])
    expect(result.total).toBe(0)
    expect(result.percent).toBeNull()
    expect(result.state).toBe('empty')
  })

  it('任务点部分完成时课程和全局使用同一分子分母口径', () => {
    const courses = [makeCourse('a'), makeCourse('b')]
    const chapters = [makeChapter('a1', 'a'), makeChapter('b1', 'b')]
    const points = [
      makePoint('a1', 'a', 'a1', true),
      makePoint('a2', 'a', 'a1'),
      makePoint('a3', 'a', 'a1'),
      makePoint('b1', 'b', 'b1', true)
    ]
    const courseA = getCourseProgress('a', chapters, points)
    const courseB = getCourseProgress('b', chapters, points)
    const global = getGlobalProgress(courses, points)
    expect(courseA).toMatchObject({ total: 3, done: 1, percent: 33 })
    expect(courseB).toMatchObject({ total: 1, done: 1, percent: 100 })
    expect(global).toEqual({ total: 4, done: 2, percent: 50 })
  })

  it('零任务点课程不会拉低或抬高全局进度', () => {
    const courses = [makeCourse('a'), makeCourse('b')]
    const chapters = [makeChapter('a1', 'a'), makeChapter('b1', 'b')]
    const points = [makePoint('a1', 'a', 'a1', true)]
    expect(getGlobalProgress(courses, points)).toEqual({ total: 1, done: 1, percent: 100 })
  })

  it('所有课程都没有任务点时全局进度为 null，而不是 0% 或 100%', () => {
    const courses = [makeCourse('a'), makeCourse('b')]
    expect(getGlobalProgress(courses, [])).toEqual({ total: 0, done: 0, percent: null })
  })

  it('孤立任务点不进入全局进度', () => {
    const courses = [makeCourse('a')]
    const points = [
      makePoint('valid', 'a', 'missing-chapter', true),
      makePoint('orphan', 'missing-course', 'missing-chapter', true),
      makePoint('orphan-2', 'missing-course-2', 'missing-chapter-2')
    ]
    expect(getGlobalProgress(courses, points)).toEqual({ total: 1, done: 1, percent: 100 })
  })

  it('章节只用于状态判断，不参与完成率计算', () => {
    const chapters = [makeChapter('c1', 'a'), makeChapter('c2', 'a'), makeChapter('c3', 'a')]
    const points = [makePoint('p1', 'a', 'c1', true)]
    const result = getCourseProgress('a', chapters, points)
    expect(result.chapterCount).toBe(3)
    expect(result.total).toBe(1)
    expect(result.percent).toBe(100)
  })
})
