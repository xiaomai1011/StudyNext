import type {
  DataSource,
  SnapshotImportResult,
  SnapshotInfo,
  SyncStatus,
  Task
} from '@shared/types'
import type { StudyNextStore } from '../storage/store'

export interface CourseBundle {
  courses: Array<{
    externalId: string
    name: string
    teacher?: string
    category?: string
    sourceUrl?: string
  }>
  tasks: Array<{
    externalId: string
    title: string
    description?: string
    courseExternalId?: string | null
    dueAt: string
    kind?: Task['kind']
  }>
}

export interface AuthorizedDataAdapter {
  readonly id: string
  readonly source: DataSource
  readonly label: string
  isConfigured(): boolean
  pull(): Promise<CourseBundle>
}

/**
 * Placeholder for a future authorized integration. It is intentionally
 * unconfigured: no public personal-developer OAuth program has been confirmed,
 * so the app must not pretend that Chaoxing data can already be synchronized.
 */
export class ChaoxingAuthorizedAdapter implements AuthorizedDataAdapter {
  readonly id = 'chaoxing-authorized'
  readonly source: DataSource = 'chaoxing'
  readonly label = '学习通授权数据'

  isConfigured(): boolean {
    return false
  }

  pull(): Promise<CourseBundle> {
    return Promise.reject(new Error('学习通授权数据源尚未配置：需要机构合作或正式授权后才能接入'))
  }
}

const SNAPSHOT_META_KEY = 'snapshot_import'

export class SyncService {
  private readonly adapter: AuthorizedDataAdapter
  private status: SyncStatus

  constructor(
    private readonly store: StudyNextStore,
    adapter: AuthorizedDataAdapter = new ChaoxingAuthorizedAdapter()
  ) {
    this.adapter = adapter
    this.status = this.buildBaseStatus()
  }

  getStatus(): SyncStatus {
    return { ...this.status, snapshot: this.readSnapshotInfo() }
  }

  recordSnapshotImport(result: SnapshotImportResult): SyncStatus {
    if (result.snapshot) {
      this.store.setMeta(SNAPSHOT_META_KEY, JSON.stringify(result.snapshot))
    }
    const snapshot = this.readSnapshotInfo()
    this.status = {
      ...this.status,
      state:
        result.state === 'failure' ? 'failure' : result.state === 'partial' ? 'partial' : 'success',
      message:
        result.state === 'failure'
          ? '学习快照导入失败，本地数据未受影响'
          : `学习快照已导入：${result.importedCourses + result.updatedCourses} 门课程、${result.importedChapters} 个章节、${result.importedTasks} 个任务`,
      source: 'import',
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt:
        result.state === 'failure' ? this.status.lastSuccessAt : new Date().toISOString(),
      detail: '数据来自用户主动导入的本地 JSON 快照，不是实时授权同步。',
      snapshot
    }
    return this.getStatus()
  }

  async run(): Promise<SyncStatus> {
    if (!this.adapter.isConfigured()) {
      const snapshot = this.readSnapshotInfo()
      this.status = {
        ...this.buildBaseStatus(),
        state: 'not_configured',
        message: snapshot
          ? `实时授权同步尚未配置；当前使用 ${snapshot.importedAt.slice(0, 10)} 导入的学习快照。`
          : '学习通授权数据同步尚未配置。当前可使用本地任务、CSV、ICS 或学习快照导入。',
        lastAttemptAt: new Date().toISOString(),
        detail: '未发现可用的个人开发者授权凭据；不会伪造同步结果。',
        snapshot
      }
      return this.getStatus()
    }
    this.status = {
      ...this.status,
      state: 'syncing',
      message: '正在通过授权适配器同步…',
      lastAttemptAt: new Date().toISOString()
    }
    try {
      const bundle = await this.adapter.pull()
      let imported = 0
      for (const task of bundle.tasks) {
        if (this.store.findTaskByExternalId('chaoxing', task.externalId)) continue
        const course = task.courseExternalId
          ? bundle.courses.find((item) => item.externalId === task.courseExternalId)
          : null
        const importedCourse = course ? this.store.findCourseByName(course.name) : null
        this.store.createTask(
          {
            title: task.title,
            description: task.description ?? '',
            courseId: importedCourse?.id ?? null,
            priority: 'medium',
            kind: task.kind ?? 'other',
            dueAt: task.dueAt,
            reminderOffsets: this.store.getSettings().defaultReminderOffsets
          },
          { source: 'chaoxing', externalId: task.externalId }
        )
        imported += 1
      }
      this.status = {
        ...this.status,
        state: imported < bundle.tasks.length ? 'partial' : 'success',
        message: `授权数据同步完成，新增 ${imported} 项任务`,
        lastSuccessAt: new Date().toISOString(),
        detail: null
      }
    } catch (error) {
      this.status = {
        ...this.status,
        state: 'failure',
        message: '授权数据同步失败，本地数据未受影响',
        detail: error instanceof Error ? error.message : '未知错误'
      }
    }
    return this.getStatus()
  }

  private buildBaseStatus(): SyncStatus {
    const snapshot = this.readSnapshotInfo()
    return {
      state: 'not_configured',
      message: snapshot
        ? `实时授权同步尚未配置；当前使用 ${snapshot.importedAt.slice(0, 10)} 导入的本地学习快照。`
        : '未配置学习通授权数据源，当前使用本地数据。',
      source: snapshot ? 'import' : null,
      lastAttemptAt: snapshot?.importedAt ?? null,
      lastSuccessAt: snapshot?.importedAt ?? null,
      detail: snapshot
        ? '学习快照由用户主动导入，只保存在本机，不是学习通实时同步。'
        : '需要机构合作或正式授权接口；本应用不访问学习通私有接口。',
      snapshot
    }
  }

  private readSnapshotInfo(): SnapshotInfo | null {
    const raw = this.store.getMeta(SNAPSHOT_META_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Partial<SnapshotInfo>
      if (
        typeof parsed.importedAt === 'string' &&
        typeof parsed.fileName === 'string' &&
        typeof parsed.courses === 'number' &&
        typeof parsed.chapters === 'number' &&
        typeof parsed.points === 'number' &&
        typeof parsed.tasks === 'number'
      ) {
        return parsed as SnapshotInfo
      }
    } catch {
      return null
    }
    return null
  }
}
