import type { Course } from './types'

/**
 * Short, stable text used only for display. It must not be used to resolve a
 * course: `course.id` remains the only identity passed through the UI.
 */
export function shortStableId(value: string, length = 8): string {
  const normalized = value.trim()
  if (normalized.length <= length) return normalized
  return normalized.slice(-length)
}

/**
 * Human-readable teaching-class identity. Teaching classes are not globally
 * unique by name, so available identifiers are combined instead of guessing.
 */
export function getCourseClassLabel(course: Course): string {
  const labels: string[] = []
  const className = course.className?.trim()
  const code = course.code?.trim()
  const clazzId = course.clazzId?.trim()

  if (className) labels.push(`教学班 ${className}`)
  if (code) labels.push(`课程号 ${code}`)
  if (clazzId) labels.push(`班级 ${clazzId}`)
  if (labels.length === 0) labels.push(`ID ${shortStableId(course.id)}`)
  return labels.join(' · ')
}

/** Compact secondary label for course lists and search results. */
export function getCourseIdentityLabel(course: Course): string {
  return getCourseClassLabel(course)
}
