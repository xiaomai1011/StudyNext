import type { Chapter, ChapterSection, Course, StudyPoint, Task } from './types'
import { normalizePortalTargetUrl } from './portal-url'
import { isTaskActionable } from './task-state'

export type ChapterWorkflowStatus = 'incomplete' | 'completed' | 'locked' | 'unknown'
export type ChapterFilterMode = 'all' | 'incomplete'
export type OfficialDestinationKind = 'section' | 'chapter' | 'course' | 'none'

export interface ChapterOfficialDestination {
  kind: OfficialDestinationKind
  url: string | null
  section: ChapterSection | null
}

export interface ResolveDestinationOptions {
  preferredSectionNumber?: string | null | undefined
  mode?: 'resume' | 'review' | 'chapter_only' | undefined
  chapterPoints?: readonly StudyPoint[] | undefined
}

export interface ChapterPointSectionAssociation {
  pointToSection: Map<StudyPoint, ChapterSection | null>
  sectionTodoCount: Map<ChapterSection, number>
  unassociatedPoints: StudyPoint[]
}

export interface ChapterWorkflowSummary {
  chapterId: string
  status: ChapterWorkflowStatus
  pointTotal: number
  pointDone: number
  remainingPoints: number
  lockedPointCount: number
  remainingMinutes: number
  sectionTotal: number
  sectionDone: number
  unfinishedUnlockedSections: number
  sectionPendingCount: number
  lockedSectionCount: number
  lockedPendingCount: number
  nextUnfinishedSection: ChapterSection | null
}

export interface StudyResumeRecord {
  courseId: string
  chapterId: string
  sectionNumber: string | null
  sectionTitle: string | null
  updatedAt: string
}

export type StudyResumeMap = Record<string, StudyResumeRecord>

export type CourseResumeKind =
  | 'resume_recent'
  | 'resume_platform'
  | 'next_unfinished'
  | 'locked_only'
  | 'all_done'
  | 'browse_only'
  | 'empty'

export interface CourseResumeTarget {
  kind: CourseResumeKind
  chapter: Chapter | null
  chapterIndex: number | null
  section: ChapterSection | null
  officialUrl: string | null
  destination: ChapterOfficialDestination
  lastActivityAt: string | null
  remainingPoints: number
  remainingMinutes: number
  unfinishedChapterCount: number
  sectionPendingCount: number
  lockedChapterCount: number
  lockedPendingCount: number
}

export const STUDY_RESUME_STORAGE_KEY = 'studynext.course-study-resume.v1'

export function parseStudyResumeStorage(raw: string | null | undefined): StudyResumeMap {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: StudyResumeMap = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const candidate = value as Record<string, unknown>
      if (
        typeof candidate.courseId !== 'string' ||
        !candidate.courseId.trim() ||
        typeof candidate.chapterId !== 'string' ||
        !candidate.chapterId.trim() ||
        typeof candidate.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(candidate.updatedAt))
      ) {
        continue
      }
      result[key] = {
        courseId: candidate.courseId,
        chapterId: candidate.chapterId,
        sectionNumber:
          typeof candidate.sectionNumber === 'string' && candidate.sectionNumber.trim()
            ? candidate.sectionNumber.trim()
            : null,
        sectionTitle:
          typeof candidate.sectionTitle === 'string' && candidate.sectionTitle.trim()
            ? candidate.sectionTitle.trim()
            : null,
        updatedAt: candidate.updatedAt
      }
    }
    return result
  } catch {
    return {}
  }
}

export function upsertStudyResumeRecord(
  current: StudyResumeMap,
  record: StudyResumeRecord,
  maxEntries = 40
): StudyResumeMap {
  const entries = Object.values({
    ...current,
    [record.courseId]: record
  })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, Math.max(1, maxEntries))

  const next: StudyResumeMap = {}
  for (const item of entries) {
    next[item.courseId] = item
  }
  return next
}

function extractChapterExternalPrefix(externalId: string | null | undefined): string | null {
  const normalized = externalId?.trim()
  if (!normalized) return null
  const markerIndex = normalized.lastIndexOf(':ch:')
  if (markerIndex <= 0) return null
  return normalized.slice(0, markerIndex)
}

function extractPointSectionRef(
  externalId: string | null | undefined
): { prefix: string | null; sectionNumber: string } | null {
  const normalized = externalId?.trim()
  if (!normalized) return null
  const markerIndex = normalized.lastIndexOf(':sec:')
  if (markerIndex >= 0) {
    const sectionNumber = normalized.slice(markerIndex + 5).trim()
    if (!sectionNumber) return null
    const prefix = markerIndex > 0 ? normalized.slice(0, markerIndex) : null
    return { prefix, sectionNumber }
  }
  if (normalized.startsWith('sec:')) {
    const sectionNumber = normalized.slice(4).trim()
    return sectionNumber ? { prefix: null, sectionNumber } : null
  }
  return null
}

/**
 * Associate synced StudyPoints with ChapterSections using stable section identifiers only:
 * 1. Chaoxing synced externalId pattern `${courseExternalId}:sec:${section.number}` (or `sec:${number}`)
 *    matched against a unique `section.number` in `chapter.sections` (respecting course prefix when present).
 * 2. Exact unique match of `point.externalId` against a section's `chapterId` when no `:sec:` marker is present.
 * Points without a clear, unique match remain unassociated (`null`) and are never guessed by title or index.
 */
export function associateChapterPointsWithSections(
  chapter: Pick<Chapter, 'sections'> & { externalId?: string | null | undefined },
  chapterPoints: readonly StudyPoint[]
): ChapterPointSectionAssociation {
  const uniqueByNumber = new Map<string, ChapterSection | 'ambiguous'>()
  const uniqueByChapterId = new Map<string, ChapterSection | 'ambiguous'>()

  for (const section of chapter.sections) {
    const num = section.number.trim()
    if (num) {
      uniqueByNumber.set(num, uniqueByNumber.has(num) ? 'ambiguous' : section)
    }
    const secChapterId = section.chapterId?.trim()
    if (secChapterId) {
      uniqueByChapterId.set(
        secChapterId,
        uniqueByChapterId.has(secChapterId) ? 'ambiguous' : section
      )
    }
  }

  const chapterPrefix = extractChapterExternalPrefix(chapter.externalId)
  const pointToSection = new Map<StudyPoint, ChapterSection | null>()
  const sectionTodoCount = new Map<ChapterSection, number>()
  const unassociatedPoints: StudyPoint[] = []

  for (const point of chapterPoints) {
    let matched: ChapterSection | null = null
    const secRef = extractPointSectionRef(point.externalId)
    if (secRef) {
      const prefixMatches = !chapterPrefix || !secRef.prefix || chapterPrefix === secRef.prefix
      if (prefixMatches) {
        const candidate = uniqueByNumber.get(secRef.sectionNumber)
        if (candidate && candidate !== 'ambiguous') {
          matched = candidate
        }
      }
    } else if (point.externalId?.trim()) {
      const candidate = uniqueByChapterId.get(point.externalId.trim())
      if (candidate && candidate !== 'ambiguous') {
        matched = candidate
      }
    }

    pointToSection.set(point, matched)
    if (!matched) {
      unassociatedPoints.push(point)
    } else if (point.status !== 'done') {
      sectionTodoCount.set(matched, (sectionTodoCount.get(matched) ?? 0) + 1)
    }
  }

  return { pointToSection, sectionTodoCount, unassociatedPoints }
}

/**
 * A section is explicitly completed when the synced section state says so and no pending item
 * remains. In that case stale local todo StudyPoints must not resurrect the section as unfinished.
 * `pendingCount > 0` always wins over `completed: true`.
 */
function isSectionExplicitlyCompleted(section: ChapterSection): boolean {
  return section.completed && section.pendingCount <= 0
}

function isSectionActionablyUnfinished(
  section: ChapterSection,
  sectionTodoCount: ReadonlyMap<ChapterSection, number>
): boolean {
  if (section.locked) return false
  // Pending evidence wins over the completed flag.
  if (section.pendingCount > 0) return true
  // Explicitly completed synced section wins over stale local todo StudyPoints.
  if (section.completed) return false
  // A section that is not explicitly completed may still be actionable from an associated todo.
  return (sectionTodoCount.get(section) ?? 0) > 0
}

/**
 * Summarize a chapter's real synced workflow state without fabricating progress.
 * Uses stable StudyPoint <-> ChapterSection associations to separate 4 states:
 * - `incomplete`: actionable unfinished evidence (unlocked/unassociated todo points, or unlocked section with pendingCount > 0 / associated todo point).
 * - `locked`: no unlocked actionable work remains, while locked sections/points remain unfinished.
 * - `completed`: confirmed complete (all points done or stale-only within explicitly completed sections, or zero points with all sections completed) and no locked remainder.
 * - `unknown`: directory/outline-only chapter with zero task points and no explicit pending/completion signal.
 */
export function getChapterWorkflowSummary(
  chapter: Chapter,
  chapterPoints: readonly StudyPoint[]
): ChapterWorkflowSummary {
  const { pointToSection, sectionTodoCount } = associateChapterPointsWithSections(
    chapter,
    chapterPoints
  )

  const sectionTotal = chapter.sections.length
  let sectionDone = 0
  let unfinishedUnlockedSections = 0
  let sectionPendingCount = 0
  let lockedSectionCount = 0
  let lockedSectionTaskCount = 0
  let nextUnfinishedSection: ChapterSection | null = null

  for (const section of chapter.sections) {
    const associatedTodos = sectionTodoCount.get(section) ?? 0
    if (section.locked) {
      lockedSectionCount += 1
      lockedSectionTaskCount += Math.max(Math.max(0, section.pendingCount), associatedTodos)
      continue
    }
    if (isSectionExplicitlyCompleted(section)) {
      sectionDone += 1
    }
    if (isSectionActionablyUnfinished(section, sectionTodoCount)) {
      unfinishedUnlockedSections += 1
      if (section.pendingCount > 0) {
        sectionPendingCount += section.pendingCount
      }
      if (!nextUnfinishedSection) {
        nextUnfinishedSection = section
      }
    }
  }

  const allSectionsLocked = sectionTotal > 0 && lockedSectionCount === sectionTotal

  const pointTotal = chapterPoints.length
  let pointDone = 0
  let actionableRemainingPoints = 0
  let lockedPointCount = 0
  let unassociatedLockedTodoPoints = 0
  let staleTodoPointCount = 0
  let remainingMinutes = 0

  for (const point of chapterPoints) {
    if (point.status === 'done') {
      pointDone += 1
      continue
    }
    const associated = pointToSection.get(point) ?? null
    if (associated?.locked) {
      lockedPointCount += 1
      continue
    }
    if (allSectionsLocked) {
      lockedPointCount += 1
      unassociatedLockedTodoPoints += 1
      continue
    }
    if (associated && isSectionExplicitlyCompleted(associated)) {
      // Stale local todo against a synced completed section: keep the record and pointTotal,
      // but do not report it as actionable remaining work or resume bait.
      staleTodoPointCount += 1
      continue
    }
    actionableRemainingPoints += 1
    if (typeof point.durationMinutes === 'number' && point.durationMinutes > 0) {
      remainingMinutes += point.durationMinutes
    }
  }

  const lockedPendingCount = lockedSectionTaskCount + unassociatedLockedTodoPoints
  const hasLockedUnfinished =
    allSectionsLocked ||
    lockedPendingCount > 0 ||
    lockedPointCount > 0 ||
    (lockedSectionCount > 0 && sectionDone < sectionTotal)

  const settledPointCount = pointDone + staleTodoPointCount

  let status: ChapterWorkflowStatus
  if (actionableRemainingPoints > 0 || unfinishedUnlockedSections > 0) {
    status = 'incomplete'
  } else if (hasLockedUnfinished) {
    status = 'locked'
  } else if (
    (pointTotal > 0 && settledPointCount === pointTotal) ||
    (pointTotal === 0 && sectionTotal > 0 && sectionDone === sectionTotal)
  ) {
    status = 'completed'
  } else {
    status = 'unknown'
  }

  return {
    chapterId: chapter.id,
    status,
    pointTotal,
    pointDone,
    remainingPoints: actionableRemainingPoints,
    lockedPointCount,
    remainingMinutes,
    sectionTotal,
    sectionDone,
    unfinishedUnlockedSections,
    sectionPendingCount,
    lockedSectionCount,
    lockedPendingCount,
    nextUnfinishedSection
  }
}

/**
 * Single source of truth resolving both the official Portal URL and the exact target section
 * so UI labels, Portal navigation, and local resume persistence never diverge.
 * Locked sections are strictly excluded in every mode.
 */
export function resolveChapterOfficialDestination(
  course: Pick<Course, 'sourceUrl'> | null | undefined,
  chapter: Pick<Chapter, 'sourceUrl' | 'sections'> & { externalId?: string | null | undefined },
  options?: ResolveDestinationOptions
): ChapterOfficialDestination {
  const mode = options?.mode ?? 'resume'
  const preferredNumber = options?.preferredSectionNumber?.trim() || null
  const chapterUrl = normalizePortalTargetUrl(chapter.sourceUrl)
  const courseUrl = normalizePortalTargetUrl(course?.sourceUrl)

  if (mode === 'chapter_only') {
    if (chapterUrl) return { kind: 'chapter', url: chapterUrl, section: null }
    if (courseUrl) return { kind: 'course', url: courseUrl, section: null }
    return { kind: 'none', url: null, section: null }
  }

  if (mode === 'resume') {
    const { sectionTodoCount } = associateChapterPointsWithSections(
      chapter,
      options?.chapterPoints ?? []
    )
    const hasExplicitActionable = chapter.sections.some((section) =>
      isSectionActionablyUnfinished(section, sectionTodoCount)
    )

    if (preferredNumber) {
      const preferred = chapter.sections.find(
        (section) => !section.locked && section.number.trim() === preferredNumber
      )
      if (
        preferred &&
        (isSectionActionablyUnfinished(preferred, sectionTodoCount) ||
          (!hasExplicitActionable && !preferred.completed))
      ) {
        const preferredUrl = normalizePortalTargetUrl(preferred.sourceUrl)
        if (preferredUrl) {
          return { kind: 'section', url: preferredUrl, section: preferred }
        }
      }
    }

    for (const section of chapter.sections) {
      if (!isSectionActionablyUnfinished(section, sectionTodoCount)) continue
      const sectionUrl = normalizePortalTargetUrl(section.sourceUrl)
      if (sectionUrl) {
        return { kind: 'section', url: sectionUrl, section }
      }
    }

    // No eligible allowlisted unfinished section URL: explicitly degrade to chapter or course entry
    // instead of silently jumping to an unrelated completed, outline-only, or locked section.
    if (chapterUrl) return { kind: 'chapter', url: chapterUrl, section: null }
    if (courseUrl) return { kind: 'course', url: courseUrl, section: null }
    return { kind: 'none', url: null, section: null }
  }

  // Review / browse mode: allow preferred unlocked section -> chapter -> first unlocked section -> course.
  if (preferredNumber) {
    const preferred = chapter.sections.find(
      (section) => !section.locked && section.number.trim() === preferredNumber
    )
    const preferredUrl = normalizePortalTargetUrl(preferred?.sourceUrl)
    if (preferred && preferredUrl) {
      return { kind: 'section', url: preferredUrl, section: preferred }
    }
  }

  if (chapterUrl) return { kind: 'chapter', url: chapterUrl, section: null }

  for (const section of chapter.sections) {
    if (section.locked) continue
    const sectionUrl = normalizePortalTargetUrl(section.sourceUrl)
    if (sectionUrl) {
      return { kind: 'section', url: sectionUrl, section }
    }
  }

  if (courseUrl) return { kind: 'course', url: courseUrl, section: null }
  return { kind: 'none', url: null, section: null }
}

/**
 * Convenience helper returning only the allowlisted official URL for continuing a chapter.
 * Uses the same unified destination resolver as the UI and local resume persistence.
 */
export function getChapterResumeOfficialUrl(
  course: Pick<Course, 'sourceUrl'> | null | undefined,
  chapter: Pick<Chapter, 'sourceUrl' | 'sections'> & { externalId?: string | null | undefined },
  preferredSectionNumber?: string | null,
  chapterPoints?: readonly StudyPoint[]
): string | null {
  return resolveChapterOfficialDestination(course, chapter, {
    preferredSectionNumber,
    chapterPoints,
    mode: 'resume'
  }).url
}

export function resolveCourseResumeTarget(
  course: Course,
  courseChapters: readonly Chapter[],
  pointsByChapter: ReadonlyMap<string, readonly StudyPoint[]>,
  resumeRecord: StudyResumeRecord | null | undefined
): CourseResumeTarget {
  if (courseChapters.length === 0) {
    const courseUrl = normalizePortalTargetUrl(course.sourceUrl)
    const destination: ChapterOfficialDestination = courseUrl
      ? { kind: 'course', url: courseUrl, section: null }
      : { kind: 'none', url: null, section: null }
    return {
      kind: 'empty',
      chapter: null,
      chapterIndex: null,
      section: null,
      officialUrl: destination.url,
      destination,
      lastActivityAt: null,
      remainingPoints: 0,
      remainingMinutes: 0,
      unfinishedChapterCount: 0,
      sectionPendingCount: 0,
      lockedChapterCount: 0,
      lockedPendingCount: 0
    }
  }

  const summaries = new Map<string, ChapterWorkflowSummary>()
  const indexById = new Map<string, number>()
  let totalRemainingPoints = 0
  let totalRemainingMinutes = 0
  let totalSectionPendingCount = 0
  let unfinishedChapterCount = 0
  let lockedChapterCount = 0
  let totalLockedPendingCount = 0
  let completedChapterCount = 0

  courseChapters.forEach((chapter, index) => {
    const summary = getChapterWorkflowSummary(chapter, pointsByChapter.get(chapter.id) ?? [])
    summaries.set(chapter.id, summary)
    indexById.set(chapter.id, index + 1)
    if (summary.status === 'incomplete') {
      unfinishedChapterCount += 1
      totalRemainingPoints += summary.remainingPoints
      totalRemainingMinutes += summary.remainingMinutes
      totalSectionPendingCount += summary.sectionPendingCount
    } else if (summary.status === 'locked') {
      lockedChapterCount += 1
    } else if (summary.status === 'completed') {
      completedChapterCount += 1
    }
    if (summary.lockedPendingCount > 0) {
      totalLockedPendingCount += summary.lockedPendingCount
    }
  })

  const buildResult = (
    kind: CourseResumeKind,
    chapter: Chapter,
    preferredSectionNumber: string | null,
    lastActivityAt: string | null
  ): CourseResumeTarget => {
    const mode: ResolveDestinationOptions['mode'] =
      kind === 'locked_only'
        ? 'chapter_only'
        : kind === 'all_done' || kind === 'browse_only'
          ? 'review'
          : 'resume'

    const destination = resolveChapterOfficialDestination(course, chapter, {
      preferredSectionNumber,
      chapterPoints: pointsByChapter.get(chapter.id) ?? [],
      mode
    })

    return {
      kind,
      chapter,
      chapterIndex: indexById.get(chapter.id) ?? null,
      section: destination.section,
      officialUrl: destination.url,
      destination,
      lastActivityAt,
      remainingPoints: totalRemainingPoints,
      remainingMinutes: totalRemainingMinutes,
      unfinishedChapterCount,
      sectionPendingCount: totalSectionPendingCount,
      lockedChapterCount,
      lockedPendingCount: totalLockedPendingCount
    }
  }

  const matchedRecentChapter =
    resumeRecord && resumeRecord.courseId === course.id
      ? (courseChapters.find((chapter) => chapter.id === resumeRecord.chapterId) ?? null)
      : null

  // 1. Local resume record pointing to a currently actionable unfinished chapter in this course
  if (matchedRecentChapter && summaries.get(matchedRecentChapter.id)?.status === 'incomplete') {
    return buildResult(
      'resume_recent',
      matchedRecentChapter,
      resumeRecord?.sectionNumber ?? null,
      resumeRecord?.updatedAt ?? matchedRecentChapter.lastStudiedAt
    )
  }

  // 2. Most recently studied unfinished chapter reported by platform/local timestamp
  const incompleteChapters = courseChapters.filter(
    (chapter) => summaries.get(chapter.id)?.status === 'incomplete'
  )
  const platformRecent = [...incompleteChapters]
    .filter((chapter) =>
      Boolean(chapter.lastStudiedAt && Number.isFinite(Date.parse(chapter.lastStudiedAt)))
    )
    .sort((a, b) => Date.parse(b.lastStudiedAt!) - Date.parse(a.lastStudiedAt!))[0]
  if (platformRecent) {
    return buildResult('resume_platform', platformRecent, null, platformRecent.lastStudiedAt)
  }

  // 3. First truly playable unfinished chapter in chapter order
  const firstIncomplete = incompleteChapters[0]
  if (firstIncomplete) {
    return buildResult('next_unfinished', firstIncomplete, null, firstIncomplete.lastStudiedAt)
  }

  // 4. Locked chapters still exist (having no unlocked unfinished chapters does NOT equal all_done)
  const lockedChapters = courseChapters.filter(
    (chapter) => summaries.get(chapter.id)?.status === 'locked'
  )
  if (lockedChapters.length > 0) {
    const firstLocked = lockedChapters[0]!
    return buildResult('locked_only', firstLocked, null, firstLocked.lastStudiedAt)
  }

  // 5. Every synced chapter is confirmed completed (zero incomplete, zero locked, zero unknown)
  if (completedChapterCount === courseChapters.length) {
    const reviewChapter = matchedRecentChapter ?? courseChapters[courseChapters.length - 1]!
    return buildResult(
      'all_done',
      reviewChapter,
      matchedRecentChapter ? (resumeRecord?.sectionNumber ?? null) : null,
      matchedRecentChapter
        ? (resumeRecord?.updatedAt ?? reviewChapter.lastStudiedAt)
        : reviewChapter.lastStudiedAt
    )
  }

  // 6. Directory/outline chapters without measurable completion signals -> honest browse-only
  const fallbackChapter = matchedRecentChapter ?? courseChapters[0]!
  return buildResult(
    'browse_only',
    fallbackChapter,
    matchedRecentChapter ? (resumeRecord?.sectionNumber ?? null) : null,
    matchedRecentChapter
      ? (resumeRecord?.updatedAt ?? fallbackChapter.lastStudiedAt)
      : fallbackChapter.lastStudiedAt
  )
}

export function resolveGlobalLastStudiedCourse(
  courses: readonly Course[],
  chapters: readonly Chapter[],
  resumeMap: StudyResumeMap
): { course: Course; chapter: Chapter; record: StudyResumeRecord } | null {
  const courseById = new Map(courses.map((course) => [course.id, course]))
  const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]))
  let best: { course: Course; chapter: Chapter; record: StudyResumeRecord; ts: number } | null =
    null

  for (const record of Object.values(resumeMap)) {
    const course = courseById.get(record.courseId)
    if (!course) continue
    const chapter = chapterById.get(record.chapterId)
    if (!chapter || chapter.courseId !== record.courseId) continue
    const ts = Date.parse(record.updatedAt)
    if (!Number.isFinite(ts)) continue
    if (!best || ts > best.ts) {
      best = { course, chapter, record, ts }
    }
  }

  return best ? { course: best.course, chapter: best.chapter, record: best.record } : null
}

export function courseNeedsAttention(
  courseId: string,
  chapters: readonly Chapter[],
  points: readonly StudyPoint[],
  tasks: readonly Task[]
): boolean {
  if (tasks.some((task) => task.courseId === courseId && isTaskActionable(task))) {
    return true
  }
  const courseChapters = chapters.filter((chapter) => chapter.courseId === courseId)
  if (courseChapters.length === 0) return false
  const pointsByChapter = new Map<string, StudyPoint[]>()
  for (const point of points) {
    if (point.courseId !== courseId) continue
    const list = pointsByChapter.get(point.chapterId) ?? []
    list.push(point)
    pointsByChapter.set(point.chapterId, list)
  }
  return courseChapters.some(
    (chapter) =>
      getChapterWorkflowSummary(chapter, pointsByChapter.get(chapter.id) ?? []).status ===
      'incomplete'
  )
}
