import type {
  CourseSession,
  PlatformStatusKind,
  SyncProgressEvent,
  TaskAttachment
} from '@shared/types'
import {
  ChaoxingParseError,
  classifyHomeworkStatus,
  detectLoginState,
  parseCourseFrameUrl,
  parseCourseList,
  parseExamList,
  parseChapterList,
  parseMaterialList,
  parseNoticeList,
  parseHomeworkDetail,
  parseHomeworkList,
  parseProfile,
  readHiddenValue,
  resolveDeadline
} from './parsers'
import type {
  ChaoxingCourseRecord,
  ChaoxingExamRecord,
  ChaoxingMaterialRecord,
  ChaoxingNoticeRecord,
  ChaoxingProfile
} from './parsers'
import { PortalSessionHttpClient } from './session-client'
import type { SessionHttpClient, SessionTransport } from './session-client'
import {
  compressWeeks,
  lessonToSession,
  normalizeCourseName,
  parseSchedulePayload,
  parseScheduleWeeksPayload
} from './schedule'
import type { AggregatedScheduleLesson, ChaoxingSchedule, RawScheduleLesson } from './schedule'

import { UNKNOWN_DUE_AT } from '@shared/constants'

export const CHAOXING_UNKNOWN_DUE_AT = UNKNOWN_DUE_AT

const BASE_URL = 'https://i.chaoxing.com/base'
const COURSE_MIDDLE_URL = 'https://mooc1.chaoxing.com/visit/stucoursemiddle'
const WORK_LIST_URL = 'https://mooc1.chaoxing.com/mooc2/work/list'
const SCHEDULE_URL = 'https://kb.chaoxing.com/pc/curriculum/getMyLessons'
const EXAM_LIST_URL = 'https://mooc1-api.chaoxing.com/exam-ans/exam/test/examcode/examlist'
const MAX_COURSES = 60
const MAX_DETAILS_PER_COURSE = 20
const MAX_SCHEDULE_WEEKS = 30
const SCHEDULE_GAP_MS = 80
const REQUEST_GAP_MS = 120

export type ChaoxingAccessCode =
  | 'NOT_LOGGED_IN'
  | 'EXPIRED'
  | 'BLOCKED'
  | 'NETWORK'
  | 'PARSE'
  | 'UNEXPECTED'
  | 'CANCELLED'

export class ChaoxingAccessError extends Error {
  constructor(
    readonly code: ChaoxingAccessCode,
    message: string
  ) {
    super(message)
    this.name = 'ChaoxingAccessError'
  }
}

export interface ChaoxingCheckResult {
  authState: 'authenticated' | 'logged_out' | 'unknown'
  message: string
  profile: ChaoxingProfile
  httpStatus: number | null
  transport: SessionTransport
  cookieDomainCount: number
}

export interface ChaoxingCourseBundle {
  externalId: string
  courseId: string
  clazzId: string
  cpi: string
  name: string
  teacher: string
  sourceUrl: string
  schedule: CourseSession[]
}

export interface ChaoxingTaskRecord {
  externalId: string
  title: string
  description: string
  courseExternalId: string
  dueAt: string
  platformStatus: string
  platformStatusKind: PlatformStatusKind
  sourceUrl: string | null
  submittedAt: string | null
  score: string | null
  fullScore: string | null
  teacherFeedback: string | null
  attachments: TaskAttachment[]
}

export interface ChaoxingCourseChapters {
  courseExternalId: string
  chapters: Array<{
    externalId: string
    title: string
    sortOrder: number
    progress: number
    sections: Array<{
      externalId: string
      title: string
      sortOrder: number
      completed: boolean
      kind: 'video' | 'reading' | 'quiz' | 'discussion' | 'assignment' | 'other'
    }>
  }>
  done: number
  total: number
}

export interface ChaoxingPullResult {
  courses: ChaoxingCourseBundle[]
  tasks: ChaoxingTaskRecord[]
  exams?: ChaoxingExamRecord[]
  notices?: ChaoxingNoticeRecord[]
  chapters?: ChaoxingCourseChapters[]
  materials?: Array<{ courseExternalId: string; items: ChaoxingMaterialRecord[] }>
  schedule?: ChaoxingSchedule | null
  errors: string[]
  warnings: string[]
  checkedAt: string
}

/**
 * 学习通 Web Session 只读适配器。
 *
 * 与 ChaoxingAuthorizedAdapter（OAuth/机构接口）不同，这里完全依赖用户本人
 * 在 Portal 中建立的登录会话，只发 GET/受控 POST 查询，不接触账号密码。
 */
export type ChaoxingAdapterLike = Pick<ChaoxingSessionAdapter, 'checkSession' | 'pull'> & {
  pullCourse?: (courseExternalId: string) => Promise<ChaoxingPullResult>
  cancel?: () => void
  onProgress?: (event: SyncProgressEvent) => void
}

export class ChaoxingSessionAdapter {
  constructor(
    private readonly client: SessionHttpClient = new PortalSessionHttpClient(),
    private readonly coursePageProvider?: () => Promise<string | null>,
    private readonly scheduleProvider?: () => Promise<string | null>,
    private readonly examPageProvider?: () => Promise<string | null>,
    private readonly chapterPageProvider?: (courseUrl: string) => Promise<string | null>,
    private readonly noticePageProvider?: () => Promise<string | null>,
    private readonly materialPageProvider?: (courseUrl: string) => Promise<string | null>
  ) {}

  onProgress?: (event: SyncProgressEvent) => void
  private cancelled = false

  cancel(): void {
    this.cancelled = true
  }

  private checkCancelled(): void {
    if (this.cancelled) {
      throw new ChaoxingAccessError('CANCELLED', '同步已取消')
    }
  }

  private emit(event: SyncProgressEvent): void {
    this.onProgress?.(event)
  }

  async checkSession(): Promise<ChaoxingCheckResult> {
    const cookieDomainCount = await this.client.countCookieDomains().catch(() => 0)
    const attempts: SessionTransport[] = ['session_fetch', 'net_request']
    let lastError: unknown = null
    for (const transport of attempts) {
      try {
        const response = await this.client.request({ url: BASE_URL, transport })
        if (isBlockedBody(response.body)) {
          throw new ChaoxingAccessError('BLOCKED', '学习通返回安全验证页，请本人在 Portal 完成验证')
        }
        const probe = detectLoginState(response.finalUrl, response.body)
        const profile = parseProfile(response.body)
        return {
          authState: probe.state,
          message: probe.reason,
          profile,
          httpStatus: response.status,
          transport: response.transport,
          cookieDomainCount
        }
      } catch (error) {
        if (error instanceof ChaoxingAccessError) throw error
        lastError = error
      }
    }
    throw new ChaoxingAccessError(
      'NETWORK',
      lastError instanceof Error ? lastError.message : '无法连接学习通'
    )
  }

  async pull(): Promise<ChaoxingPullResult> {
    this.cancelled = false
    this.emit({ phase: 'start', message: '正在检查学习通登录状态…', current: 0, total: 0 })
    const check = await this.checkSession()
    if (check.authState === 'logged_out') {
      throw new ChaoxingAccessError('NOT_LOGGED_IN', '尚未在 Portal 登录学习通')
    }
    if (check.authState !== 'authenticated') {
      throw new ChaoxingAccessError('UNEXPECTED', '无法确认学习通登录状态，请先打开 Portal 检查')
    }
    const courses = await this.loadCourses()
    this.checkCancelled()
    this.emit({
      phase: 'courses',
      message: `已获取 ${courses.length} 门课程`,
      current: courses.length,
      total: courses.length
    })
    const bundles: ChaoxingCourseBundle[] = []
    const tasks: ChaoxingTaskRecord[] = []
    const errors: string[] = []
    const warnings: string[] = []
    this.emit({ phase: 'schedule', message: '正在读取课表…', current: 0, total: 1 })
    const schedule = await this.fetchSchedule(warnings)
    this.checkCancelled()
    this.emit({ phase: 'exams', message: '正在读取考试列表…', current: 0, total: 1 })
    const exams = await this.fetchExams(warnings)
    this.checkCancelled()
    this.emit({ phase: 'notices', message: '正在读取通知…', current: 0, total: 1 })
    const notices = await this.fetchNotices(warnings)
    this.checkCancelled()

    for (let index = 0; index < courses.length; index += 1) {
      this.checkCancelled()
      const course = courses[index]
      if (!course) continue
      const bundle = toBundle(course)
      bundle.schedule = schedule ? sessionsForCourse(schedule, bundle) : []
      bundles.push(bundle)
      this.emit({
        phase: 'homework',
        message: `正在读取作业：${bundle.name}`,
        current: index + 1,
        total: courses.length
      })
      const courseTasks = await this.fetchCourseTasks(bundle, errors, warnings)
      tasks.push(...courseTasks)
      await delay(REQUEST_GAP_MS)
    }
    this.emit({ phase: 'chapters', message: '正在读取章节目录…', current: 0, total: bundles.length })
    const chapters = await this.fetchChapters(bundles, warnings)
    this.checkCancelled()
    this.emit({ phase: 'materials', message: '正在读取课程资料…', current: 0, total: bundles.length })
    const materials = await this.fetchMaterials(bundles, warnings)
    this.checkCancelled()
    this.emit({ phase: 'done', message: '学习通数据读取完成', current: 1, total: 1 })
    return {
      courses: bundles,
      tasks,
      exams,
      notices,
      chapters,
      materials,
      schedule,
      errors,
      warnings,
      checkedAt: new Date().toISOString()
    }
  }

  /** 仅重试一门课程的作业、章节与资料，用于失败后的局部恢复。 */
  async pullCourse(courseExternalId: string): Promise<ChaoxingPullResult> {
    this.cancelled = false
    this.emit({ phase: 'start', message: '正在检查学习通登录状态…', current: 0, total: 0 })
    const check = await this.checkSession()
    if (check.authState === 'logged_out') {
      throw new ChaoxingAccessError('NOT_LOGGED_IN', '尚未在 Portal 登录学习通')
    }
    if (check.authState !== 'authenticated') {
      throw new ChaoxingAccessError('UNEXPECTED', '无法确认学习通登录状态，请先打开 Portal 检查')
    }
    const courses = await this.loadCourses()
    const course = courses.find((item) => item.externalId === courseExternalId)
    if (!course) {
      throw new ChaoxingAccessError('PARSE', '课程列表中未找到该课程，请先完整同步一次')
    }
    const errors: string[] = []
    const warnings: string[] = []
    this.emit({ phase: 'homework', message: `正在重试课程：${course.name}`, current: 1, total: 1 })
    const tasks = await this.fetchCourseTasks(course, errors, warnings)
    this.emit({ phase: 'chapters', message: '正在重试章节…', current: 1, total: 1 })
    const chapters = await this.fetchChapters([course], warnings)
    this.checkCancelled()
    this.emit({ phase: 'materials', message: '正在重试资料…', current: 1, total: 1 })
    const materials = await this.fetchMaterials([course], warnings)
    this.emit({ phase: 'done', message: '单课程重试完成', current: 1, total: 1 })
    return {
      courses: [course],
      tasks,
      exams: [],
      notices: [],
      chapters,
      materials,
      schedule: null,
      errors,
      warnings,
      checkedAt: new Date().toISOString()
    }
  }

  /** 从个人空间 / Portal 已渲染课程网格解析课程列表。 */
  private async loadCourses(): Promise<ChaoxingCourseBundle[]> {
    const response = await this.get(BASE_URL)
    let parsedCourses = parseCourseList(response.body)
    if (parsedCourses.length === 0 && this.coursePageProvider) {
      const portalHtml = await this.coursePageProvider().catch(() => null)
      if (portalHtml) parsedCourses = parseCourseList(portalHtml)
    }
    if (parsedCourses.length === 0) {
      const frameUrl = parseCourseFrameUrl(response.body)
      if (frameUrl) {
        const frame = await this.get(frameUrl, BASE_URL)
        parsedCourses = parseCourseList(frame.body)
      }
    }
    if (parsedCourses.length === 0) {
      throw new ChaoxingAccessError(
        'PARSE',
        '个人空间未解析到课程，请确认 Portal 已打开“个人空间”页面'
      )
    }
    return parsedCourses.slice(0, MAX_COURSES).map(toBundle)
  }

  private async fetchNotices(warnings: string[]): Promise<ChaoxingNoticeRecord[]> {
    if (!this.noticePageProvider) return []
    try {
      const raw = await this.noticePageProvider()
      if (!raw) return []
      return parseNoticeList(raw)
    } catch (error) {
      warnings.push(`通知：${error instanceof Error ? error.message : '读取失败'}`)
      return []
    }
  }

  private async fetchChapters(
    bundles: ChaoxingCourseBundle[],
    warnings: string[]
  ): Promise<ChaoxingCourseChapters[]> {
    if (!this.chapterPageProvider) return []
    const result: ChaoxingCourseChapters[] = []
    for (let index = 0; index < bundles.length; index += 1) {
      this.checkCancelled()
      const bundle = bundles[index]
      if (!bundle) continue
      this.emit({
        phase: 'chapters',
        message: `正在读取章节：${bundle.name}`,
        current: index + 1,
        total: bundles.length
      })
      try {
        const html = await this.chapterPageProvider(bundle.sourceUrl)
        if (!html) continue
        const parsed = parseChapterList(html)
        if (parsed.chapters.length === 0) continue
        result.push({
          courseExternalId: bundle.externalId,
          done: parsed.done,
          total: parsed.total,
          chapters: parsed.chapters.map((chapter, chapterIndex) => {
            const sections = chapter.sections.map((section, sectionIndex) => ({
              externalId: `${bundle.externalId}:sec:${section.number}`,
              title: section.title,
              sortOrder: sectionIndex,
              completed: section.completed,
              kind: inferStudyPointKind(section.title)
            }))
            const completed = sections.filter((section) => section.completed).length
            return {
              externalId: `${bundle.externalId}:ch:${chapter.number}`,
              title: chapter.title,
              sortOrder: chapterIndex,
              progress: sections.length === 0 ? 0 : Math.round((completed / sections.length) * 100),
              sections
            }
          })
        })
      } catch (error) {
        warnings.push(`章节 ${bundle.name}：${error instanceof Error ? error.message : '读取失败'}`)
      }
      await delay(100)
    }
    return result
  }

  private async fetchMaterials(
    bundles: ChaoxingCourseBundle[],
    warnings: string[]
  ): Promise<Array<{ courseExternalId: string; items: ChaoxingMaterialRecord[] }>> {
    if (!this.materialPageProvider) return []
    const result: Array<{ courseExternalId: string; items: ChaoxingMaterialRecord[] }> = []
    for (let index = 0; index < bundles.length; index += 1) {
      this.checkCancelled()
      const bundle = bundles[index]
      if (!bundle) continue
      this.emit({
        phase: 'materials',
        message: `正在读取资料：${bundle.name}`,
        current: index + 1,
        total: bundles.length
      })
      try {
        const html = await this.materialPageProvider(bundle.sourceUrl)
        if (!html) continue
        const items = parseMaterialList(html)
        if (items.length === 0) continue
        result.push({
          courseExternalId: bundle.externalId,
          items: items.map((item) => ({
            ...item,
            sourceUrl: item.sourceUrl ?? bundle.sourceUrl
          }))
        })
      } catch (error) {
        warnings.push(`资料 ${bundle.name}：${error instanceof Error ? error.message : '读取失败'}`)
      }
      await delay(100)
    }
    return result
  }

  private async fetchExams(warnings: string[]): Promise<ChaoxingExamRecord[]> {
    try {
      const response = await this.client.request({
        url: `${EXAM_LIST_URL}?status=-1`,
        referer: BASE_URL,
        accept: 'text/html,*/*;q=0.8'
      })
      if (!isBlockedBody(response.body) && response.status < 400) {
        const parsed = parseExamList(response.body)
        if (parsed.length > 0) return parsed
      }
      if (this.examPageProvider) {
        const html = await this.examPageProvider().catch(() => null)
        if (html) return parseExamList(html)
      }
      return []
    } catch (error) {
      if (this.examPageProvider) {
        const html = await this.examPageProvider().catch(() => null)
        if (html) return parseExamList(html)
      }
      warnings.push(`考试：${error instanceof Error ? error.message : '读取失败'}`)
      return []
    }
  }

  private async fetchSchedule(warnings: string[]): Promise<ChaoxingSchedule | null> {
    try {
      if (this.scheduleProvider) {
        const raw = await this.scheduleProvider().catch(() => null)
        if (raw) return parseScheduleWeeksPayload(raw)
        throw new ChaoxingAccessError('NETWORK', '课表页未返回数据')
      }
      const first = await this.postSchedule({})
      const merged = new Map<string, { lesson: RawScheduleLesson; weeks: number[] }>()
      let emptyStreak = 0
      for (let week = 1; week <= first.maxWeek; week += 1) {
        const payload = await this.postSchedule({ week: String(week) })
        if (payload.lessons.length === 0) {
          emptyStreak += 1
          if (emptyStreak >= 4) break
          continue
        }
        emptyStreak = 0
        for (const lesson of payload.lessons) {
          const key = [
            lesson.lessonId,
            lesson.dayOfWeek,
            lesson.beginNumber,
            lesson.length,
            lesson.location,
            lesson.teacherName,
            lesson.name
          ].join('|')
          const existing = merged.get(key)
          if (existing) {
            existing.weeks.push(week)
          } else {
            merged.set(key, { lesson, weeks: [week] })
          }
        }
        await delay(SCHEDULE_GAP_MS)
      }
      const lessons: AggregatedScheduleLesson[] = [...merged.values()].map(({ lesson, weeks }) => ({
        ...lesson,
        weeks: compressWeeks(weeks),
        weekNumbers: weeks
      }))
      return {
        semesterStart: first.semesterStart,
        maxWeek: Math.min(first.maxWeek, MAX_SCHEDULE_WEEKS),
        currentWeek: first.currentWeek,
        sections: first.sections,
        lessons
      }
    } catch (error) {
      warnings.push(`课表：${error instanceof Error ? error.message : '读取失败'}`)
      return null
    }
  }

  private async postSchedule(form: Record<string, string>) {
    const response = await this.client.request({
      url: SCHEDULE_URL,
      method: 'POST',
      form,
      referer: BASE_URL,
      accept: 'application/json,text/plain,*/*'
    })
    if (isBlockedBody(response.body)) {
      throw new ChaoxingAccessError('BLOCKED', '学习通课表返回安全验证页，请本人在 Portal 完成验证')
    }
    if (response.status === 401 || response.status === 403) {
      throw new ChaoxingAccessError('EXPIRED', '登录态可能已过期，请重新登录')
    }
    return parseSchedulePayload(JSON.parse(response.body) as unknown)
  }

  private async fetchCourseTasks(
    course: ChaoxingCourseBundle,
    errors: string[],
    warnings: string[]
  ): Promise<ChaoxingTaskRecord[]> {
    let middle: Awaited<ReturnType<ChaoxingSessionAdapter['get']>>
    try {
      middle = await this.get(course.sourceUrl)
    } catch (error) {
      errors.push(describeCourseError(course, error))
      return []
    }
    const enc = readHiddenValue(middle.body, 'enc')
    const openc = readHiddenValue(middle.body, 'openc') ?? ''
    const workEnc =
      readHiddenValue(middle.body, 'workEnc') ??
      matchJsValue(middle.body, 'workEnc') ??
      ''
    if (!enc) {
      errors.push(`${course.name}：课程页缺少访问签名`)
      return []
    }
    // enc 存在但没有 workEnc，通常表示该课程未开放作业，不应让整批同步变成 partial。
    if (!workEnc) return []
    const listUrl = buildWorkListUrl(course, enc, openc, workEnc)
    let list: Awaited<ReturnType<ChaoxingSessionAdapter['get']>>
    try {
      list = await this.get(listUrl, course.sourceUrl)
    } catch (error) {
      errors.push(describeCourseError(course, error))
      return []
    }
    let parsed: ReturnType<typeof parseHomeworkList>
    try {
      parsed = parseHomeworkList(list.body)
    } catch (error) {
      if (error instanceof ChaoxingParseError) {
        errors.push(`${course.name}：${error.message}`)
        return []
      }
      throw error
    }
    const result: ChaoxingTaskRecord[] = []
    const detailCandidates = parsed.items
      .filter((item) => item.url)
      .slice(0, MAX_DETAILS_PER_COURSE)
    const detailMap = new Map<string, ReturnType<typeof parseHomeworkDetail>>()
    for (const item of detailCandidates) {
      try {
        const detail = await this.get(item.url, listUrl)
        detailMap.set(item.title, parseHomeworkDetail(detail.body))
        await delay(REQUEST_GAP_MS)
      } catch (error) {
        if (error instanceof ChaoxingAccessError && error.code === 'BLOCKED') throw error
        warnings.push(`${course.name} / ${item.title}：截止时间读取失败`)
      }
    }
    for (const item of parsed.items) {
      const detail = detailMap.get(item.title)
      const dueAt = resolveDeadline(detail?.deadlineText ?? null) ?? CHAOXING_UNKNOWN_DUE_AT
      result.push({
        externalId: buildTaskExternalId(course.externalId, item.externalId, item.title),
        title: item.title || '未命名作业',
        description: detail?.deadlineText
          ? `学习通作业 · 截止 ${detail.deadlineText}`
          : '学习通作业 · 截止时间待确认',
        courseExternalId: course.externalId,
        dueAt,
        platformStatus: item.status,
        platformStatusKind: classifyHomeworkStatus(item.status),
        sourceUrl: item.url || null,
        submittedAt: resolveDeadline(detail?.submittedAtText ?? null),
        score: detail?.score ?? null,
        fullScore: detail?.fullScore != null ? String(detail.fullScore) : null,
        teacherFeedback: detail?.teacherFeedback ?? null,
        attachments: detail?.attachments ?? []
      })
    }
    return result
  }

  private get(
    url: string,
    referer?: string
  ): Promise<{ status: number; finalUrl: string; body: string; transport: SessionTransport }> {
    return this.client
      .request({ url, ...(referer ? { referer } : {}), accept: 'text/html,*/*;q=0.8' })
      .then((response) => {
        if (isBlockedBody(response.body)) {
          throw new ChaoxingAccessError(
            'BLOCKED',
            '学习通返回安全验证页，请本人在 Portal 完成验证后重试'
          )
        }
        if (response.status === 401 || response.status === 403) {
          throw new ChaoxingAccessError('EXPIRED', '登录态可能已过期，请重新登录')
        }
        if (response.status >= 500) {
          throw new ChaoxingAccessError('NETWORK', `学习通服务返回 ${response.status}`)
        }
        return response
      })
  }
}

function toBundle(course: ChaoxingCourseRecord): ChaoxingCourseBundle {
  const externalId = `${course.courseId}:${course.clazzId}`
  return {
    externalId,
    courseId: course.courseId,
    clazzId: course.clazzId,
    cpi: course.cpi,
    name: course.name || '未命名课程',
    teacher: course.teacher,
    schedule: [],
    sourceUrl: `${COURSE_MIDDLE_URL}?courseid=${encodeURIComponent(
      course.courseId
    )}&clazzid=${encodeURIComponent(course.clazzId)}&cpi=${encodeURIComponent(
      course.cpi
    )}&vc=1&ismooc2=1&v=2`
  }
}

function inferStudyPointKind(
  title: string
): 'video' | 'reading' | 'quiz' | 'discussion' | 'assignment' | 'other' {
  if (/视频|讲解|录播|微课/.test(title)) return 'video'
  if (/讨论/.test(title)) return 'discussion'
  if (/测验|练习|测试/.test(title)) return 'quiz'
  if (/作业|任务/.test(title)) return 'assignment'
  if (/阅读|文档|资料|课件/.test(title)) return 'reading'
  return 'other'
}

function sessionsForCourse(
  schedule: ChaoxingSchedule,
  course: ChaoxingCourseBundle
): CourseSession[] {
  const target = normalizeCourseName(course.name)
  let matches = schedule.lessons.filter(
    (lesson) =>
      (lesson.courseId && lesson.courseId === course.courseId) ||
      normalizeCourseName(lesson.name) === target
  )
  if (matches.length === 0) {
    matches = schedule.lessons.filter((lesson) => {
      const name = normalizeCourseName(lesson.name)
      return name.length >= 2 && target.length >= 2 && (name.includes(target) || target.includes(name))
    })
  }
  return matches
    .map((lesson) => lessonToSession(lesson, schedule.sections))
    .filter((session): session is CourseSession => session !== null)
}

function buildWorkListUrl(
  course: ChaoxingCourseBundle,
  enc: string,
  openc: string,
  workEnc: string
): string {
  const params = new URLSearchParams({
    courseId: course.courseId,
    classId: course.clazzId,
    cpi: course.cpi,
    ut: 's',
    openc,
    enc: workEnc,
    t: String(Date.now()),
    stuenc: enc,
    isdisplaytable: '2'
  })
  return `${WORK_LIST_URL}?${params.toString()}`
}

function buildTaskExternalId(
  courseExternalId: string,
  homeworkId: string | null,
  title: string
): string {
  const suffix = homeworkId ?? `t${hashString(title)}`
  return `${courseExternalId}:${suffix}`
}

function hashString(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16)
}

function matchJsValue(html: string, name: string): string | null {
  const pattern = new RegExp(`${name}\\s*[:=]\\s*['"]([^'"]+)['"]`, 'i')
  return pattern.exec(html)?.[1] ?? null
}

function isBlockedBody(body: string): boolean {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1] ?? ''
  return (
    body.includes('antispiderShowVerify') ||
    /id\s*=\s*["']antispider/i.test(body) ||
    /安全验证|请输入验证码/.test(title)
  )
}

function describeCourseError(course: ChaoxingCourseBundle, error: unknown): string {
  if (error instanceof ChaoxingAccessError) {
    return `${course.name}：${error.message}`
  }
  return `${course.name}：${error instanceof Error ? error.message : '请求失败'}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
