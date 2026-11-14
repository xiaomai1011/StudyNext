import type { ChaoxingSessionStatus, SyncProgressEvent, SyncState } from '@shared/types'
import { isPlatformTaskDone } from '@shared/domain'
import type { StudyNextStore } from '../../storage/store'
import {
  ChaoxingAccessError,
  ChaoxingSessionAdapter
} from './adapter'
import type { ChaoxingAdapterLike, ChaoxingPullResult } from './adapter'

const STATUS_META_KEY = 'chaoxing_session_status'
const STATUS_MAX_AGE_MS = 12 * 60 * 60 * 1000
const SHORT_CACHE_MS = 5 * 60 * 1000

export interface SessionSyncOutcome {
  state: Extract<SyncState, 'not_configured' | 'success' | 'partial' | 'failure'>
  message: string
  detail: string | null
  lastSuccessAt: string | null
}

/**
 * 管理“用户本人 Web Session”的连接状态与手动同步。
 *
 * - 状态只保存非敏感摘要（昵称、学校、时间、计数），不保存 Cookie/Token。
 * - authenticated 的唯一依据是受保护资源请求成功，而不是 URL 路径。
 * - 401/403/登录页/安全验证页都会终止同步，不重试、不绕过。
 */
export class ChaoxingSessionService {
  private status: ChaoxingSessionStatus
  private syncing = false
  private lastPullAt = 0

  constructor(
    private readonly store: StudyNextStore,
    private readonly adapter: ChaoxingAdapterLike = new ChaoxingSessionAdapter(),
    private readonly onSyncOutcome: (outcome: SessionSyncOutcome) => void = () => undefined,
    private readonly onProgress: (event: SyncProgressEvent) => void = () => undefined
  ) {
    this.status = this.readStatus()
    this.adapter.onProgress = onProgress
  }

  cancel(): ChaoxingSessionStatus {
    this.adapter.cancel?.()
    return this.getStatus()
  }

  getStatus(): ChaoxingSessionStatus {
    return { ...this.status }
  }

  async check(): Promise<ChaoxingSessionStatus> {
    const previous = this.status
    try {
      const result = await this.adapter.checkSession()
      const authState =
        result.authState === 'authenticated'
          ? 'authenticated'
          : result.authState === 'logged_out'
            ? previous.authState === 'authenticated'
              ? 'expired'
              : 'logged_out'
            : 'unknown'
      this.status = {
        ...previous,
        authState,
        message:
          authState === 'expired'
            ? '学习通登录态已失效，请本人在 Portal 重新登录'
            : result.message,
        displayName: result.profile.name ?? previous.displayName,
        school: result.profile.school ?? previous.school,
        checkedAt: new Date().toISOString(),
        transport: result.transport,
        httpStatus: result.httpStatus,
        cookieDomainCount: result.cookieDomainCount,
        detail:
          authState === 'authenticated'
            ? null
            : '仅当受保护页面请求成功时才会显示已登录；不会依据 URL 猜测。'
      }
    } catch (error) {
      this.status = {
        ...previous,
        authState: 'unknown',
        message: '无法确认学习通登录状态',
        checkedAt: new Date().toISOString(),
        transport: 'none',
        httpStatus: null,
        detail: error instanceof Error ? error.message : '未知错误'
      }
    }
    this.persist()
    return this.getStatus()
  }

  async sync(force = false): Promise<ChaoxingSessionStatus> {
    if (this.syncing) return this.getStatus()
    if (
      !force &&
      this.lastPullAt > 0 &&
      Date.now() - this.lastPullAt < SHORT_CACHE_MS &&
      this.status.authState === 'authenticated' &&
      this.status.lastSyncAt
    ) {
      this.status = {
        ...this.status,
        message: '最近 5 分钟内已同步，本次使用短期缓存；如需强制刷新请在设置页点击“仅同步学习通”。'
      }
      this.persist()
      this.onProgress({ phase: 'done', message: this.status.message, current: 0, total: 0 })
      return this.getStatus()
    }
    this.syncing = true
    const startedAt = new Date().toISOString()
    this.status = {
      ...this.status,
      lastAttemptAt: startedAt,
      message: '正在通过 Web Session 读取学习通数据…'
    }
    this.persist()
    this.onProgress({ phase: 'start', message: '正在通过 Web Session 读取学习通数据…', current: 0, total: 0 })
    try {
      const result = await this.adapter.pull()
      this.lastPullAt = Date.now()
      const counts = this.persistResult(result)
      const now = new Date().toISOString()
      const partial = result.errors.length > 0 || result.warnings.length > 0
      this.status = {
        ...this.status,
        authState: 'authenticated',
        message: partial
          ? `同步完成，${counts.courses} 门课程、${counts.tasks} 项作业、${counts.chapters} 个章节、${counts.exams} 场考试、${counts.notices} 条通知、${counts.materials} 个资料；部分数据读取失败`
          : `同步完成，${counts.courses} 门课程、${counts.tasks} 项作业、${counts.chapters} 个章节、${counts.exams} 场考试、${counts.notices} 条通知、${counts.materials} 个资料`,
        checkedAt: now,
        lastSyncAt: now,
        syncedCourses: counts.courses,
        syncedTasks: counts.tasks,
        syncedChapters: counts.chapters,
        syncedExams: counts.exams,
        syncedNotices: counts.notices,
        syncedMaterials: counts.materials,
        detail: buildDetail(result)
      }
      this.onSyncOutcome({
        state: partial ? 'partial' : 'success',
        message: this.status.message,
        detail: this.status.detail,
        lastSuccessAt: now
      })
    } catch (error) {
      const access = error instanceof ChaoxingAccessError ? error : null
      const authState =
        access?.code === 'NOT_LOGGED_IN' || access?.code === 'EXPIRED'
          ? this.status.authState === 'authenticated'
            ? 'expired'
            : 'logged_out'
          : this.status.authState
      this.status = {
        ...this.status,
        authState,
        message:
          access?.code === 'BLOCKED'
            ? '学习通要求安全验证，自动同步已停止，请本人在 Portal 处理'
            : access?.code === 'NOT_LOGGED_IN'
              ? '尚未在 Portal 登录学习通'
              : access?.code === 'CANCELLED'
                ? '同步已取消，本地数据未受影响'
                : '同步失败，本地数据未受影响',
        checkedAt: new Date().toISOString(),
        detail: error instanceof Error ? error.message : '未知错误'
      }
      this.onSyncOutcome({
        state: access?.code === 'NOT_LOGGED_IN' ? 'not_configured' : 'failure',
        message: this.status.message,
        detail: this.status.detail,
        lastSuccessAt: this.status.lastSyncAt
      })
    } finally {
      this.syncing = false
      this.persist()
    }
    return this.getStatus()
  }

  async retryCourse(courseId: string): Promise<ChaoxingSessionStatus> {
    if (this.syncing) return this.getStatus()
    const course = this.store.getCourse(courseId)
    if (!course || course.source !== 'chaoxing' || !course.externalId) {
      this.status = { ...this.status, message: '该课程不是学习通同步课程，无法重试' }
      this.persist()
      return this.getStatus()
    }
    if (!this.adapter.pullCourse) {
      this.status = { ...this.status, message: '当前适配器不支持单课程重试' }
      this.persist()
      return this.getStatus()
    }
    this.syncing = true
    const startedAt = new Date().toISOString()
    this.status = {
      ...this.status,
      lastAttemptAt: startedAt,
      message: `正在重试课程：${course.name}…`
    }
    this.persist()
    this.onProgress({ phase: 'start', message: this.status.message, current: 0, total: 0 })
    try {
      const result = await this.adapter.pullCourse(course.externalId)
      const counts = this.persistResult(result)
      const materialCount = (result.materials ?? []).reduce((sum, group) => sum + group.items.length, 0)
      const now = new Date().toISOString()
      const partial = result.errors.length > 0 || result.warnings.length > 0
      this.status = {
        ...this.status,
        authState: 'authenticated',
        message: partial
          ? `课程重试完成：${course.name}，${counts.tasks} 项作业、${counts.chapters} 个章节、${materialCount} 个资料；部分数据读取失败`
          : `课程重试完成：${course.name}，${counts.tasks} 项作业、${counts.chapters} 个章节、${materialCount} 个资料`,
        checkedAt: now,
        lastSyncAt: now,
        detail: buildDetail(result)
      }
      this.onSyncOutcome({
        state: partial ? 'partial' : 'success',
        message: this.status.message,
        detail: this.status.detail,
        lastSuccessAt: now
      })
    } catch (error) {
      const access = error instanceof ChaoxingAccessError ? error : null
      this.status = {
        ...this.status,
        message:
          access?.code === 'BLOCKED'
            ? '学习通要求安全验证，自动同步已停止，请本人在 Portal 处理'
            : access?.code === 'CANCELLED'
              ? '同步已取消，本地数据未受影响'
              : '课程重试失败，本地数据未受影响',
        checkedAt: new Date().toISOString(),
        detail: error instanceof Error ? error.message : '未知错误'
      }
      this.onSyncOutcome({
        state: access?.code === 'NOT_LOGGED_IN' ? 'not_configured' : 'failure',
        message: this.status.message,
        detail: this.status.detail,
        lastSuccessAt: this.status.lastSyncAt
      })
    } finally {
      this.syncing = false
      this.persist()
    }
    return this.getStatus()
  }

  private persistResult(result: ChaoxingPullResult): {
    courses: number
    tasks: number
    exams: number
    chapters: number
    notices: number
    materials: number
  } {
    const reminderOffsets = this.store.getSettings().defaultReminderOffsets
    if (result.courses.length > 0) {
      // 真实数据到达后移除演示种子，避免“同步成功但界面仍显示演示课程”。
      this.store.clearDemoData()
    }
    let courses = 0
    const courseIdMap = new Map<string, string>()
    for (const bundle of result.courses) {
      const { course } = this.store.upsertProviderCourse(
        {
          externalId: bundle.externalId,
          name: bundle.name,
          teacher: bundle.teacher,
          sourceUrl: bundle.sourceUrl,
          clazzId: bundle.clazzId,
          className: null,
          ...(result.schedule
            ? {
                schedule: bundle.schedule,
                semesterStart: result.schedule.semesterStart,
                maxWeek: result.schedule.maxWeek
              }
            : {})
        },
        'chaoxing'
      )
      courseIdMap.set(bundle.externalId, course.id)
      courses += 1
    }
    let tasks = 0
    // 同一作业可能在列表页出现多次（桌面/移动两套 DOM），按 externalId 去重后再落库，
    // 避免“提示 13 项、数据库只有 12 项”的计数不一致。
    const uniqueTasks = new Map(result.tasks.map((task) => [task.externalId, task]))
    for (const record of uniqueTasks.values()) {
      this.store.upsertImportedTask(
        {
          title: record.title,
          description: record.description,
          courseId: courseIdMap.get(record.courseExternalId) ?? null,
          priority: 'medium',
          kind: 'homework',
          status: isPlatformTaskDone(record.platformStatusKind) ? 'done' : 'todo',
          dueAt: record.dueAt,
          reminderOffsets,
          sourceUrl: record.sourceUrl
        },
        {
          externalId: record.externalId,
          source: 'chaoxing',
          sourceUpdatedAt: result.checkedAt,
          platformStatus: record.platformStatus,
          platformStatusKind: record.platformStatusKind,
          submittedAt: record.submittedAt,
          score: record.score,
          fullScore: record.fullScore,
          teacherFeedback: record.teacherFeedback,
          attachments: record.attachments
        }
      )
      tasks += 1
    }
    return {
      courses,
      tasks,
      exams: this.persistExams(result),
      chapters: this.persistChapters(result, courseIdMap),
      notices: this.persistNotices(result),
      materials: this.persistMaterials(result, courseIdMap)
    }
  }

  private persistMaterials(
    result: ChaoxingPullResult,
    courseIdMap: Map<string, string>
  ): number {
    let count = 0
    for (const group of result.materials ?? []) {
      const courseId = courseIdMap.get(group.courseExternalId)
      if (!courseId) continue
      count += this.store.replaceProviderMaterials(courseId, group.items, 'chaoxing')
    }
    return Math.max(count, this.store.listMaterials().length)
  }

  private persistNotices(result: ChaoxingPullResult): number {
    let count = 0
    for (const notice of result.notices ?? []) {
      this.store.upsertProviderNotice(notice, 'chaoxing')
      count += 1
    }
    return Math.max(count, this.store.listNotices().length)
  }

  private persistChapters(
    result: ChaoxingPullResult,
    courseIdMap: Map<string, string>
  ): number {
    let chapters = 0
    for (const bundle of result.chapters ?? []) {
      const courseId = courseIdMap.get(bundle.courseExternalId)
      if (!courseId) continue
      for (const chapter of bundle.chapters) {
        const { chapter: stored } = this.store.upsertSnapshotChapter(
          {
            courseId,
            externalId: chapter.externalId,
            title: chapter.title,
            sortOrder: chapter.sortOrder,
            progress: chapter.progress
          },
          'chaoxing'
        )
        for (const section of chapter.sections) {
          this.store.upsertSnapshotPoint(
            {
              chapterId: stored.id,
              courseId,
              externalId: section.externalId,
              title: section.title,
              kind: section.kind,
              completed: section.completed,
              durationMinutes: null,
              sortOrder: section.sortOrder
            },
            'chaoxing'
          )
        }
        chapters += 1
      }
    }
    return chapters
  }

  private persistExams(result: ChaoxingPullResult): number {
    let exams = 0
    for (const record of result.exams ?? []) {
      this.store.upsertProviderExam(
        {
          externalId: record.externalId,
          title: record.title,
          courseName: record.courseName,
          startAt: record.startAt,
          endAt: record.endAt,
          durationMinutes: record.durationMinutes,
          examStatus: record.examStatus,
          answerStatus: record.answerStatus,
          score: record.score,
          mode: record.mode,
          sourceUrl: record.sourceUrl
        },
        'chaoxing'
      )
      exams += 1
    }
    return exams
  }

  private readStatus(): ChaoxingSessionStatus {
    const raw = this.store.getMeta(STATUS_META_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<ChaoxingSessionStatus>
        if (
          parsed.authState === 'unknown' ||
          parsed.authState === 'logged_out' ||
          parsed.authState === 'authenticated' ||
          parsed.authState === 'expired'
        ) {
          const checkedAt = typeof parsed.checkedAt === 'string' ? parsed.checkedAt : null
          const stale =
            checkedAt !== null && Date.now() - Date.parse(checkedAt) > STATUS_MAX_AGE_MS
          return {
            authState: stale && parsed.authState === 'authenticated' ? 'expired' : parsed.authState,
            connection: 'web_session',
            message: stale
              ? '上次登录检查已超过 12 小时，请重新检查'
              : (parsed.message ?? '尚未检查学习通连接'),
            displayName: parsed.displayName ?? null,
            school: parsed.school ?? null,
            checkedAt,
            lastSyncAt: parsed.lastSyncAt ?? null,
            lastAttemptAt: parsed.lastAttemptAt ?? null,
            syncedCourses: parsed.syncedCourses ?? 0,
            syncedTasks: parsed.syncedTasks ?? 0,
            syncedChapters: parsed.syncedChapters ?? 0,
            syncedExams: parsed.syncedExams ?? 0,
            syncedNotices: parsed.syncedNotices ?? 0,
            syncedMaterials: parsed.syncedMaterials ?? 0,
            transport: parsed.transport ?? 'none',
            httpStatus: parsed.httpStatus ?? null,
            cookieDomainCount: parsed.cookieDomainCount ?? 0,
            detail: parsed.detail ?? null
          }
        }
      } catch {
        // 损坏的状态按未知处理，不影响本地数据。
      }
    }
    return {
      authState: 'unknown',
      connection: 'web_session',
      message: '尚未检查学习通连接',
      displayName: null,
      school: null,
      checkedAt: null,
      lastSyncAt: null,
      lastAttemptAt: null,
      syncedCourses: 0,
      syncedTasks: 0,
      syncedChapters: 0,
      syncedExams: 0,
      syncedNotices: 0,
      syncedMaterials: 0,
      transport: 'none',
      httpStatus: null,
      cookieDomainCount: 0,
      detail: null
    }
  }

  private persist(): void {
    this.store.setMeta(STATUS_META_KEY, JSON.stringify(this.status))
  }
}

function buildDetail(result: ChaoxingPullResult): string | null {
  const parts: string[] = []
  if (result.errors.length > 0) parts.push(`失败：${result.errors.slice(0, 5).join('；')}`)
  if (result.warnings.length > 0) parts.push(`提示：${result.warnings.slice(0, 5).join('；')}`)
  return parts.length > 0 ? parts.join('。') : null
}
