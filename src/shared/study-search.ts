import type { Chapter, Course, StudyPoint } from './types'
import { getCourseIdentityLabel } from './course-identity'

export type StudySearchKind = 'course' | 'chapter' | 'point'

export interface StudySearchResult {
  key: string
  kind: StudySearchKind
  courseId: string
  courseName: string
  classLabel: string
  chapterId: string | null
  pointId: string | null
  title: string
  context: string
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN')
}

/**
 * Search across every course, chapter and study point. Course identity is
 * always carried by stable IDs; display names and class labels are context
 * only. A point without a known chapter remains selectable at course level.
 */
export function searchStudy(
  courses: readonly Course[],
  chapters: readonly Chapter[],
  points: readonly StudyPoint[],
  query: string,
  limit = 80
): StudySearchResult[] {
  const term = normalize(query)
  if (!term) return []

  const courseById = new Map(courses.map((course) => [course.id, course]))
  const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]))
  const results: StudySearchResult[] = []

  for (const course of courses) {
    const classLabel = getCourseIdentityLabel(course)
    const courseName = normalize(course.name)
    if (courseName.includes(term)) {
      results.push({
        key: `course:${course.id}`,
        kind: 'course',
        courseId: course.id,
        courseName: course.name,
        classLabel,
        chapterId: null,
        pointId: null,
        title: course.name,
        context: classLabel
      })
    }
  }

  for (const chapter of chapters) {
    const course = courseById.get(chapter.courseId)
    if (!course) continue
    if (!normalize(chapter.title).includes(term)) continue
    results.push({
      key: `chapter:${chapter.id}`,
      kind: 'chapter',
      courseId: course.id,
      courseName: course.name,
      classLabel: getCourseIdentityLabel(course),
      chapterId: chapter.id,
      pointId: null,
      title: chapter.title,
      context: `${course.name} · ${getCourseIdentityLabel(course)}`
    })
  }

  for (const point of points) {
    if (!normalize(point.title).includes(term)) continue
    const course = courseById.get(point.courseId)
    if (!course) continue
    const chapter = chapterById.get(point.chapterId) ?? null
    results.push({
      key: `point:${point.id}`,
      kind: 'point',
      courseId: course.id,
      courseName: course.name,
      classLabel: getCourseIdentityLabel(course),
      chapterId: chapter?.id ?? null,
      pointId: point.id,
      title: point.title,
      context: chapter ? `${course.name} · ${chapter.title}` : `${course.name} · 所属章节未知`
    })
  }

  const rank: Record<StudySearchKind, number> = { course: 0, chapter: 1, point: 2 }
  return results
    .sort((a, b) => {
      const aStarts = normalize(a.title).startsWith(term) ? 0 : 1
      const bStarts = normalize(b.title).startsWith(term) ? 0 : 1
      return (
        aStarts - bStarts || rank[a.kind] - rank[b.kind] || a.title.localeCompare(b.title, 'zh-CN')
      )
    })
    .slice(0, limit)
}
