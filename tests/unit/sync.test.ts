import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StudyNextStore } from '../../src/main/storage/store'
import {
  ChaoxingAuthorizedAdapter,
  SyncService,
  type AuthorizedDataAdapter,
  type CourseBundle
} from '../../src/main/integrations/sync'

const cleanups: Array<() => void> = []

function createStore(): StudyNextStore {
  const dir = mkdtempSync(join(tmpdir(), 'studynext-sync-'))
  const store = new StudyNextStore(join(dir, 'studynext.sqlite'))
  cleanups.push(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('SyncService', () => {
  it('未配置学习通授权数据源时返回 not_configured，绝不伪造成功', async () => {
    const store = createStore()
    const service = new SyncService(store, new ChaoxingAuthorizedAdapter())

    expect(service.getStatus()).toMatchObject({ state: 'not_configured', source: null })

    const result = await service.run()
    expect(result.state).toBe('not_configured')
    expect(result.lastSuccessAt).toBeNull()
    expect(result.message).toContain('尚未连接')
  })

  it('授权适配器失败时返回 failure 且保留本地数据', async () => {
    const store = createStore()
    const before = store.listTasks().length
    const failingAdapter: AuthorizedDataAdapter = {
      id: 'test-failure',
      source: 'chaoxing',
      label: '测试授权源',
      isConfigured: () => true,
      pull: () => Promise.reject(new Error('network denied'))
    }
    const service = new SyncService(store, failingAdapter)

    const result = await service.run()
    expect(result.state).toBe('failure')
    expect(result.detail).toContain('network denied')
    expect(store.listTasks()).toHaveLength(before)
  })

  it('授权适配器成功时导入任务并报告 success', async () => {
    const store = createStore()
    const bundle: CourseBundle = {
      courses: [],
      tasks: [
        {
          externalId: 'authorized-task-1',
          title: '授权同步任务',
          dueAt: '2031-01-01T12:00:00.000Z'
        }
      ]
    }
    const adapter: AuthorizedDataAdapter = {
      id: 'test-success',
      source: 'chaoxing',
      label: '测试授权源',
      isConfigured: () => true,
      pull: () => Promise.resolve(bundle)
    }
    const service = new SyncService(store, adapter)

    const result = await service.run()
    expect(result.state).toBe('success')
    expect(result.lastSuccessAt).not.toBeNull()
    expect(store.listTasks().some((task) => task.title === '授权同步任务')).toBe(true)
  })

  it('快照导入标记为本地导入来源，而不是学习通实时同步', () => {
    const store = createStore()
    const service = new SyncService(store)
    const status = service.recordSnapshotImport({
      state: 'success',
      importedCourses: 1,
      updatedCourses: 0,
      importedChapters: 1,
      importedPoints: 2,
      importedTasks: 1,
      updatedTasks: 0,
      deadlineChanges: 0,
      conflicts: 0,
      skipped: 0,
      warnings: [],
      message: '学习快照已导入',
      snapshot: {
        importedAt: '2031-01-01T00:00:00.000Z',
        fileName: 'snapshot.json',
        courses: 1,
        chapters: 1,
        points: 2,
        tasks: 1
      }
    })

    expect(status.state).toBe('success')
    expect(status.source).toBe('import')
    expect(status.message).toContain('学习快照')
    expect(status.detail).toContain('不是实时授权同步')
    expect(status.snapshot?.fileName).toBe('snapshot.json')

    const reopened = new SyncService(store).getStatus()
    expect(reopened.source).toBe('import')
    expect(reopened.lastSuccessAt).toBe('2031-01-01T00:00:00.000Z')
    expect(reopened.message).toContain('快照')
  })
})
