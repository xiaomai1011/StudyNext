import { createHash } from 'node:crypto'
import type {
  CourseSession,
  SnapshotImportResult,
  SnapshotInfo,
  StudyPointKind,
  TaskKind,
  TaskPriority,
  TaskUpsertInput
} from '@shared/types'
import { UserFacingError } from '../lib/errors'
import type { StudyNextStore } from '../storage/store'

type UnknownRecord = Record<string, unknown>

export interface ParsedSnapshotPoint {
  externalId: string
  title: string
  kind: StudyPointKind
  completed: boolean
  durationMinutes: number | null
  sortOrder: number
}

export interface ParsedSnapshotChapter {
  externalId: string
  title: string
  sortOrder: number
  progress: number
  points: ParsedSnapshotPoint[]
}

export interface ParsedSnapshotCourse {
  externalId: string
  name: string
  code: string
  teacher: string
  category: string
  sourceUrl: string | null
  schedule: CourseSession[]
  chapters: ParsedSnapshotChapter[]
}

export interface ParsedSnapshotTask {
  externalId: string
  title: string
  description: string
  courseExternalId: string | null
  courseName: string | null
  priority: TaskPriority
  kind: TaskKind
  status: 'todo' | 'done'
  dueAt: string
}

export interface ParsedSnapshot {
  courses: ParsedSnapshotCourse[]
  tasks: ParsedSnapshotTask[]
  warnings: string[]
  sourceName: string
}

const pointKindMap: Record<string, StudyPointKind> = {
  video: 'video',
  视频: 'video',
  reading: 'reading',
  阅读: 'reading',
  quiz: 'quiz',
  test: 'quiz',
  测验: 'quiz',
  discussion: 'discussion',
  讨论: 'discussion',
  assignment: 'assignment',
  homework: 'assignment',
  作业: 'assignment',
  other: 'other'
}

const taskKindMap: Record<string, TaskKind> = {
  homework: 'homework',
  assignment: 'homework',
  作业: 'homework',
  exam: 'exam',
  test: 'exam',
  考试: 'exam',
  reading: 'reading',
  阅读: 'reading',
  activity: 'activity',
  活动: 'activity'
}

export function parseStudySnapshot(content: string): ParsedSnapshot {
  let raw: unknown
  try {
    raw = JSON.parse(content) as unknown
  } catch {
    throw new UserFacingError('SNAPSHOT_INVALID_JSON', 'JSON 格式无效，请检查快照文件')
  }
  if (!isRecord(raw)) {
    throw new UserFacingError('SNAPSHOT_INVALID', '快照根节点必须是 JSON 对象')
  }
  const root = isRecord(raw.data) ? raw.data : raw
  const warnings: string[] = []
  const courses: ParsedSnapshotCourse[] = []
  const courseByExternal = new Map<string, ParsedSnapshotCourse>()
  const courseByName = new Map<string, ParsedSnapshotCourse>()
  const courseByRawId = new Map<string, ParsedSnapshotCourse>()

  const rawCourses = asArray(root.courses)
  for (const [index, item] of rawCourses.entries()) {
    if (!isRecord(item)) {
      warnings.push(`第 ${index + 1} 门课程不是对象，已跳过`)
      continue
    }
    const name = firstString(item.name, item.title, item.courseName)
    if (!name) {
      warnings.push(`第 ${index + 1} 门课程缺少名称，已跳过`)
      continue
    }
    const externalId =
      firstString(item.id, item.courseId, item.externalId) ?? stableId('course', name)
    const course: ParsedSnapshotCourse = {
      externalId,
      name,
      code: firstString(item.code, item.courseCode) ?? '',
      teacher: firstString(item.teacher, item.teacherName, item.instructor) ?? '',
      category: firstString(item.category, item.type) ?? '学习通',
      sourceUrl: firstString(item.url, item.sourceUrl, item.link),
      schedule: parseSessions(item.sessions ?? item.schedule),
      chapters: []
    }
    courses.push(course)
    courseByExternal.set(externalId, course)
    courseByName.set(name.trim().toLowerCase(), course)
    const rawId = firstString(item.id, item.courseId)
    if (rawId) courseByRawId.set(rawId, course)
    for (const [chapterIndex, chapterRaw] of asArray(item.chapters).entries()) {
      const chapter = parseChapter(chapterRaw, chapterIndex, warnings)
      if (chapter) {
        course.chapters.push(chapter)
        courseByExternal.set(externalId, course)
      }
    }
  }

  const topChapters = asArray(root.chapters)
  for (const [chapterIndex, chapterRaw] of topChapters.entries()) {
    if (!isRecord(chapterRaw)) continue
    const chapter = parseChapter(chapterRaw, chapterIndex, warnings)
    if (!chapter) continue
    const course = resolveCourse(chapterRaw, courses, courseByExternal, courseByName, courseByRawId)
    if (!course) {
      warnings.push(`章节「${chapter.title}」找不到所属课程，已跳过`)
      continue
    }
    if (!course.chapters.some((existing) => existing.externalId === chapter.externalId)) {
      course.chapters.push(chapter)
    }
  }

  const tasks: ParsedSnapshotTask[] = []
  const taskKeys = new Set<string>()
  for (const [taskIndex, taskRaw] of asArray(root.homeworks ?? root.assignments).entries()) {
    if (!isRecord(taskRaw)) continue
    const task = parseTask(taskRaw, taskIndex, 'homework', warnings)
    if (!task) continue
    attachTaskCourse(task, taskRaw, courses, courseByExternal, courseByName, courseByRawId)
    addParsedTask(tasks, taskKeys, task)
  }
  for (const [taskIndex, taskRaw] of asArray(root.exams).entries()) {
    if (!isRecord(taskRaw)) continue
    const task = parseTask(taskRaw, taskIndex, 'exam', warnings)
    if (!task) continue
    attachTaskCourse(task, taskRaw, courses, courseByExternal, courseByName, courseByRawId)
    addParsedTask(tasks, taskKeys, task)
  }

  // Nested tasks are collected after top-level tasks so explicit top-level data wins.
  for (const course of courses) {
    for (const task of tasksFromRaw(root, course, warnings)) {
      task.courseExternalId = course.externalId
      task.courseName = course.name
      task.externalId = courseTaskExternalId(course, task.externalId)
      addParsedTask(tasks, taskKeys, task)
    }
  }

  if (courses.length === 0 && tasks.length === 0) {
    throw new UserFacingError('SNAPSHOT_EMPTY', '快照中没有找到课程、章节或任务')
  }

  return {
    courses,
    tasks,
    warnings: warnings.slice(0, 30),
    sourceName: firstString(root.source, root.exporter, raw.source) ?? '学习通快照'
  }
}

function tasksFromRaw(
  root: UnknownRecord,
  course: ParsedSnapshotCourse,
  warnings: string[]
): ParsedSnapshotTask[] {
  const rawCourse = asArray(root.courses).find((item) => {
    if (!isRecord(item)) return false
    const externalId = firstString(item.id, item.courseId, item.externalId)
    if (externalId && externalId === course.externalId) return true
    const name = firstString(item.name, item.title, item.courseName)
    return name?.trim().toLowerCase() === course.name.trim().toLowerCase()
  })
  if (!isRecord(rawCourse)) return []
  const result: ParsedSnapshotTask[] = []
  for (const [index, item] of asArray(rawCourse.homeworks ?? rawCourse.assignments).entries()) {
    const task = parseTask(item, index, 'homework', warnings)
    if (task) result.push(task)
  }
  for (const [index, item] of asArray(rawCourse.exams).entries()) {
    const task = parseTask(item, index, 'exam', warnings)
    if (task) result.push(task)
  }
  return result
}

function parseChapter(
  value: unknown,
  index: number,
  warnings: string[]
): ParsedSnapshotChapter | null {
  if (!isRecord(value)) return null
  const title = firstString(value.title, value.name, value.chapterName)
  if (!title) {
    warnings.push(`第 ${index + 1} 个章节缺少标题，已跳过`)
    return null
  }
  const externalId =
    firstString(value.id, value.chapterId, value.externalId) ??
    stableId('chapter', `${title}:${index}`)
  const points: ParsedSnapshotPoint[] = []
  for (const [pointIndex, pointRaw] of asArray(
    value.points ?? value.tasks ?? value.items
  ).entries()) {
    if (!isRecord(pointRaw)) continue
    const pointTitle = firstString(pointRaw.title, pointRaw.name)
    if (!pointTitle) continue
    const kindRaw = (firstString(pointRaw.kind, pointRaw.type) ?? 'other').toLowerCase()
    points.push({
      externalId:
        firstString(pointRaw.id, pointRaw.pointId, pointRaw.externalId) ??
        stableId('point', `${externalId}:${pointTitle}:${pointIndex}`),
      title: pointTitle,
      kind: pointKindMap[kindRaw] ?? 'other',
      completed:
        valueToBoolean(pointRaw.completed) ||
        ['done', 'complete', 'completed', '已完成'].includes(
          (firstString(pointRaw.status) ?? '').toLowerCase()
        ),
      durationMinutes: toPositiveInteger(
        pointRaw.durationMinutes ?? pointRaw.duration ?? pointRaw.minutes
      ),
      sortOrder: toNonNegativeInteger(pointRaw.sortOrder ?? pointRaw.order, pointIndex)
    })
  }
  return {
    externalId,
    title,
    sortOrder: toNonNegativeInteger(value.sortOrder ?? value.order, index),
    progress: normalizeProgress(value.progress ?? value.percent),
    points
  }
}

function parseTask(
  value: unknown,
  index: number,
  fallbackKind: TaskKind,
  warnings: string[]
): ParsedSnapshotTask | null {
  if (!isRecord(value)) return null
  const title = firstString(value.title, value.name, value.taskName)
  if (!title) {
    warnings.push(`第 ${index + 1} 个任务缺少标题，已跳过`)
    return null
  }
  const dueAt = parseDate(
    value.dueAt ??
      value.deadline ??
      value.endAt ??
      value.endTime ??
      value.startAt ??
      value.startTime ??
      value.due
  )
  if (!dueAt) {
    warnings.push(`任务「${title}」缺少有效截止时间，已跳过`)
    return null
  }
  const kindRaw = (firstString(value.kind, value.type) ?? fallbackKind).toLowerCase()
  const priorityRaw = (firstString(value.priority) ?? 'medium').toLowerCase()
  const priority: TaskPriority =
    priorityRaw === 'high' || priorityRaw === '高' || priorityRaw === '高优先级'
      ? 'high'
      : priorityRaw === 'low' || priorityRaw === '低' || priorityRaw === '低优先级'
        ? 'low'
        : 'medium'
  const status = ['done', 'completed', 'complete', '已完成'].includes(
    (firstString(value.status) ?? '').toLowerCase()
  )
    ? 'done'
    : 'todo'
  return {
    externalId:
      firstString(value.id, value.taskId, value.homeworkId, value.externalId) ??
      stableId('task', `${title}:${dueAt}:${index}`),
    title,
    description: firstString(value.description, value.content, value.remark) ?? '',
    courseExternalId: firstString(value.courseId, value.course_id),
    courseName: firstString(value.courseName, value.course),
    priority,
    kind: taskKindMap[kindRaw] ?? fallbackKind,
    status,
    dueAt
  }
}

function attachTaskCourse(
  task: ParsedSnapshotTask,
  raw: UnknownRecord,
  courses: ParsedSnapshotCourse[],
  byExternal: Map<string, ParsedSnapshotCourse>,
  byName: Map<string, ParsedSnapshotCourse>,
  byRawId: Map<string, ParsedSnapshotCourse>
): void {
  const course = resolveCourse(raw, courses, byExternal, byName, byRawId)
  if (course) {
    task.courseExternalId = course.externalId
    task.courseName = course.name
    task.externalId = courseTaskExternalId(course, task.externalId)
  }
}

function addParsedTask(
  tasks: ParsedSnapshotTask[],
  taskKeys: Set<string>,
  task: ParsedSnapshotTask
): void {
  const key = task.externalId
  if (taskKeys.has(key)) return
  taskKeys.add(key)
  tasks.push(task)
}

function courseTaskExternalId(course: ParsedSnapshotCourse, externalId: string): string {
  return externalId.startsWith(`${course.externalId}:`)
    ? externalId
    : `${course.externalId}:${externalId}`
}

function resolveCourse(
  raw: UnknownRecord,
  courses: ParsedSnapshotCourse[],
  byExternal: Map<string, ParsedSnapshotCourse>,
  byName: Map<string, ParsedSnapshotCourse>,
  byRawId: Map<string, ParsedSnapshotCourse>
): ParsedSnapshotCourse | null {
  const externalId = firstString(raw.courseId, raw.course_id, raw.courseExternalId)
  if (externalId) {
    const match = byExternal.get(externalId) ?? byRawId.get(externalId)
    if (match) return match
  }
  const name = firstString(raw.courseName, raw.course)
  if (name) {
    const match = byName.get(name.trim().toLowerCase())
    if (match) return match
  }
  return courses.length === 1 ? (courses[0] ?? null) : null
}

export function importStudySnapshot(
  store: StudyNextStore,
  input: { fileName: string; content: string }
): SnapshotImportResult {
  const parsed = parseStudySnapshot(input.content)
  const settings = store.getSettings()
  let importedCourses = 0
  let updatedCourses = 0
  let importedChapters = 0
  let importedPoints = 0
  let totalChapters = 0
  let totalPoints = 0
  let importedTasks = 0
  let updatedTasks = 0
  let deadlineChanges = 0
  let conflicts = 0
  let skipped = 0
  const warnings = [...parsed.warnings]
  const courseIds = new Map<string, string>()

  for (const parsedCourse of parsed.courses) {
    try {
      const result = store.upsertSnapshotCourse({
        externalId: parsedCourse.externalId,
        name: parsedCourse.name,
        code: parsedCourse.code,
        teacher: parsedCourse.teacher,
        category: parsedCourse.category,
        sourceUrl: parsedCourse.sourceUrl,
        schedule: parsedCourse.schedule
      })
      courseIds.set(parsedCourse.externalId, result.course.id)
      if (result.created) importedCourses += 1
      else updatedCourses += 1
      for (const parsedChapter of parsedCourse.chapters) {
        const chapterResult = store.upsertSnapshotChapter({
          courseId: result.course.id,
          externalId: parsedChapter.externalId,
          title: parsedChapter.title,
          sortOrder: parsedChapter.sortOrder,
          progress: parsedChapter.progress
        })
        totalChapters += 1
        if (chapterResult.created) importedChapters += 1
        for (const parsedPoint of parsedChapter.points) {
          const pointResult = store.upsertSnapshotPoint({
            chapterId: chapterResult.chapter.id,
            courseId: result.course.id,
            externalId: parsedPoint.externalId,
            title: parsedPoint.title,
            kind: parsedPoint.kind,
            completed: parsedPoint.completed,
            durationMinutes: parsedPoint.durationMinutes,
            sortOrder: parsedPoint.sortOrder
          })
          totalPoints += 1
          if (pointResult.created) importedPoints += 1
        }
        if (parsedChapter.points.length > 0) {
          store.recalculateChapterProgress(chapterResult.chapter.id)
        }
      }
    } catch (error) {
      warnings.push(`导入课程「${parsedCourse.name}」失败：${errorText(error)}`)
    }
  }

  const now = new Date().toISOString()
  for (const task of parsed.tasks) {
    let courseId = task.courseExternalId ? (courseIds.get(task.courseExternalId) ?? null) : null
    if (!courseId && task.courseName) {
      const existing = store.findCourseByName(task.courseName)
      if (existing) courseId = existing.id
      else {
        const created = store.createImportedCourse(task.courseName)
        courseId = created.id
      }
    }
    if (!courseId && task.courseExternalId) {
      const existing = store.findCourseByExternalId('import', task.courseExternalId)
      courseId = existing?.id ?? null
    }
    const taskInput: TaskUpsertInput = {
      title: task.title,
      description: task.description,
      courseId,
      priority: task.priority,
      kind: task.kind,
      dueAt: task.dueAt,
      reminderOffsets: settings.defaultReminderOffsets,
      status: task.status
    }
    try {
      const result = store.upsertImportedTask(taskInput, {
        externalId: task.externalId,
        source: 'import',
        sourceUpdatedAt: now
      })
      if (result.action === 'created') importedTasks += 1
      else if (result.action === 'updated') updatedTasks += 1
      else skipped += 1
      if (result.deadlineChanged) deadlineChanges += 1
      conflicts += result.conflicts.length
    } catch (error) {
      warnings.push(`导入任务「${task.title}」失败：${errorText(error)}`)
    }
  }

  const snapshot: SnapshotInfo = {
    importedAt: now,
    fileName: input.fileName,
    courses: importedCourses + updatedCourses,
    chapters: totalChapters,
    points: totalPoints,
    tasks: importedTasks + updatedTasks
  }
  const changedCount =
    importedCourses +
    updatedCourses +
    importedChapters +
    importedPoints +
    importedTasks +
    updatedTasks
  const state: SnapshotImportResult['state'] =
    warnings.length === 0 ? 'success' : changedCount > 0 ? 'partial' : 'failure'
  return {
    state,
    importedCourses,
    updatedCourses,
    importedChapters,
    importedPoints,
    importedTasks,
    updatedTasks,
    deadlineChanges,
    conflicts,
    skipped,
    warnings: warnings.slice(0, 30),
    message:
      state === 'failure'
        ? '快照导入失败，请检查文件格式'
        : `已导入 ${importedCourses + updatedCourses} 门课程、${importedChapters} 个章节、${importedPoints} 个学习点；新增 ${importedTasks} 个任务，更新 ${updatedTasks} 个任务${deadlineChanges > 0 ? `，检测到 ${deadlineChanges} 个截止时间变化` : ''}${conflicts > 0 ? `，保留 ${conflicts} 个手动字段` : ''}`,
    snapshot
  }
}

function parseSessions(value: unknown): CourseSession[] {
  const result: CourseSession[] = []
  for (const [index, item] of asArray(value).entries()) {
    if (!isRecord(item)) continue
    const weekday = toNonNegativeInteger(item.weekday ?? item.day, 0)
    if (weekday < 1 || weekday > 7) continue
    const startTime = firstString(item.startTime, item.start) ?? '08:00'
    const endTime = firstString(item.endTime, item.end) ?? '09:40'
    result.push({
      id: firstString(item.id) ?? stableId('session', `${weekday}:${startTime}:${index}`),
      weekday: weekday as CourseSession['weekday'],
      startTime,
      endTime,
      location: firstString(item.location, item.room) ?? '',
      weeks: firstString(item.weeks, item.weekRange) ?? ''
    })
  }
  return result
}

function parseDate(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000
    const date = new Date(millis)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (typeof value !== 'string' || !value.trim()) return null
  const date = new Date(value.trim())
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizeProgress(value: unknown): number {
  const isPercentString = typeof value === 'string' && value.includes('%')
  const number =
    typeof value === 'string' ? Number.parseFloat(value.replace('%', '').trim()) : value
  if (typeof number !== 'number' || !Number.isFinite(number)) return 0
  // Numeric 0–1 values are treated as fractions; an explicit "50%" string stays a percentage.
  const normalized = !isPercentString && number <= 1 ? number * 100 : number
  return Math.max(0, Math.min(100, Math.round(normalized)))
}

function valueToBoolean(value: unknown): boolean {
  if (value === true || value === 1) return true
  if (typeof value !== 'string') return false
  return ['true', '1', 'yes', 'done', 'complete', 'completed', '已完成'].includes(
    value.trim().toLowerCase()
  )
}

function toPositiveInteger(value: unknown): number | null {
  const number = typeof value === 'string' ? Number.parseInt(value, 10) : value
  return typeof number === 'number' && Number.isFinite(number) && number > 0
    ? Math.round(number)
    : null
}

function toNonNegativeInteger(value: unknown, fallback: number): number {
  const number = typeof value === 'string' ? Number.parseInt(value, 10) : value
  return typeof number === 'number' && Number.isFinite(number) && number >= 0
    ? Math.round(number)
    : fallback
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha1').update(value).digest('hex').slice(0, 16)}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
