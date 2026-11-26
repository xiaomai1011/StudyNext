import type { Chapter, Course, Exam, Task, TaskPriority } from './types'
import { isDueAtUnknown, sortTasksByDue } from './domain'
import { normalizePortalTargetUrl } from './portal-url'
import { isTaskActionable } from './task-state'

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  high: 0,
  medium: 1,
  low: 2
}

/**
 * Resolve a course only when the name identifies exactly one course.
 * Course names are not globally unique across teaching classes, so a
 * non-unique match must never silently choose the first row.
 */
export function findUniqueCourseByName(
  courses: readonly Course[],
  name: string | null | undefined
): Course | null {
  const normalized = name?.trim()
  if (!normalized) return null
  const matches = courses.filter((course) => course.name.trim() === normalized)
  return matches.length === 1 ? (matches[0] ?? null) : null
}

export function isAmbiguousCourseName(course: Course, courses: readonly Course[]): boolean {
  const unique = findUniqueCourseByName(courses, course.name)
  return unique?.id !== course.id
}

/** Return a course's verified official Portal URL, or null when absent or not allowlisted. */
export function getCourseOfficialUrl(
  course: Pick<Course, 'sourceUrl'> | null | undefined
): string | null {
  return normalizePortalTargetUrl(course?.sourceUrl)
}

/** Return the best allowlisted Portal URL for opening a chapter (unlocked section -> chapter -> course). */
export function getChapterOfficialUrl(
  course: Pick<Course, 'sourceUrl'> | null | undefined,
  chapter: Pick<Chapter, 'sourceUrl' | 'sections'>
): string | null {
  for (const section of chapter.sections) {
    if (section.locked) continue
    const sectionUrl = normalizePortalTargetUrl(section.sourceUrl)
    if (sectionUrl) return sectionUrl
  }
  return normalizePortalTargetUrl(chapter.sourceUrl) ?? normalizePortalTargetUrl(course?.sourceUrl)
}

/**
 * Orders a course's tasks so active work is never buried under historical
 * completed assignments:
 * 1. Actionable upcoming tasks with concrete deadlines (soonest first).
 * 2. Actionable overdue tasks (most recently missed first).
 * 3. Actionable tasks with unknown due dates.
 * 4. Submitted / pending-review tasks (most recent due first).
 * 5. Reviewed / done tasks (most recent due first).
 */
export function sortCourseWorkspaceTasks(tasks: readonly Task[], now = new Date()): Task[] {
  const nowMs = now.getTime()
  const upcoming: Task[] = []
  const overdue: Task[] = []
  const unknownDue: Task[] = []
  const waiting: Task[] = []
  const finished: Task[] = []

  for (const task of tasks) {
    if (isTaskActionable(task)) {
      if (isDueAtUnknown(task.dueAt)) {
        unknownDue.push(task)
      } else {
        const dueMs = Date.parse(task.dueAt)
        if (!Number.isFinite(dueMs)) unknownDue.push(task)
        else if (dueMs < nowMs) overdue.push(task)
        else upcoming.push(task)
      }
      continue
    }
    if (task.platformStatusKind === 'submitted' || task.platformStatusKind === 'pending_review') {
      waiting.push(task)
    } else {
      finished.push(task)
    }
  }

  const byDueDesc = (a: Task, b: Task): number => {
    const aMs = isDueAtUnknown(a.dueAt) ? 0 : Date.parse(a.dueAt)
    const bMs = isDueAtUnknown(b.dueAt) ? 0 : Date.parse(b.dueAt)
    if (Number.isFinite(aMs) && Number.isFinite(bMs) && bMs !== aMs) return bMs - aMs
    return PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority]
  }

  return [
    ...sortTasksByDue(upcoming),
    ...overdue.sort(byDueDesc),
    ...unknownDue.sort((a, b) => PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority]),
    ...waiting.sort(byDueDesc),
    ...finished.sort(byDueDesc)
  ]
}

/**
 * Exams are associated to courses by name only (the platform record has no
 * course ID). Attach them only when the name identifies this course uniquely;
 * ambiguous same-name teaching classes must use the cross-course exam tab.
 */
export function examsForCourse(
  course: Course,
  courses: readonly Course[],
  exams: readonly Exam[]
): Exam[] {
  const unique = findUniqueCourseByName(courses, course.name)
  if (unique?.id !== course.id) return []
  const name = course.name.trim()
  return exams.filter((exam) => exam.courseName?.trim() === name)
}
