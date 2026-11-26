import type { Chapter, Course, StudyPoint } from './types'

export type CourseProgressState = 'ready' | 'no_tasks' | 'empty'

export interface CourseProgress {
  courseId: string
  chapterCount: number
  total: number
  done: number
  percent: number | null
  state: CourseProgressState
}

export interface GlobalProgress {
  total: number
  done: number
  percent: number | null
}

/**
 * 课程进度以真实任务点为唯一分母；章节数量和资料数量不能代替任务点。
 * 没有任务点时不伪造百分比，由界面显示“无任务点”。
 */
export function getCourseProgress(
  courseId: string,
  chapters: Chapter[],
  points: StudyPoint[]
): CourseProgress {
  const chapterCount = chapters.filter((chapter) => chapter.courseId === courseId).length
  const coursePoints = points.filter((point) => point.courseId === courseId)
  const total = coursePoints.length
  const done = coursePoints.filter((point) => point.status === 'done').length
  return {
    courseId,
    chapterCount,
    total,
    done,
    percent: total > 0 ? Math.round((done / total) * 100) : null,
    state: total > 0 ? 'ready' : chapterCount > 0 ? 'no_tasks' : 'empty'
  }
}

/**
 * 全局进度只汇总存在课程归属的真实任务点；孤立任务点和章节数不参与统计。
 * 总数为 0 时返回 null，表示“暂无任务点”，不是 0% 或 100%。
 */
export function getGlobalProgress(courses: Course[], points: StudyPoint[]): GlobalProgress {
  const courseIds = new Set(courses.map((course) => course.id))
  const validPoints = points.filter((point) => courseIds.has(point.courseId))
  const done = validPoints.filter((point) => point.status === 'done').length
  return {
    total: validPoints.length,
    done,
    percent: validPoints.length > 0 ? Math.round((done / validPoints.length) * 100) : null
  }
}
