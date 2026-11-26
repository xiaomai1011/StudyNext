import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChaoxingPullResult } from '../../src/main/integrations/chaoxing/adapter'
import { ChaoxingSessionService } from '../../src/main/integrations/chaoxing/service'
import { StudyNextStore } from '../../src/main/storage/store'

const stores: StudyNextStore[] = []

function openStore(): StudyNextStore {
  const store = new StudyNextStore(':memory:')
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe('D-006 transaction boundary', () => {
  it('rolls back every write when a sync batch fails before commit', () => {
    const store = openStore()
    store.clearDemoData()
    expect(store.listCourses()).toHaveLength(0)

    expect(() =>
      store.runInTransaction(() => {
        store.upsertProviderCourse(
          {
            externalId: '900:901',
            name: '事务回滚测试',
            teacher: '测试老师',
            clazzId: '901',
            className: '901班',
            sourceUrl: 'https://mooc1.chaoxing.com/course?courseid=900&clazzid=901&cpi=1'
          },
          'chaoxing'
        )
        throw new Error('simulated write failure')
      })
    ).toThrow('simulated write failure')

    expect(store.listCourses()).toHaveLength(0)
  })

  it('commits the whole batch only after nested DAO transactions succeed', () => {
    const store = openStore()

    store.runInTransaction(() => {
      store.upsertProviderCourse(
        {
          externalId: '910:911',
          name: '事务提交测试',
          teacher: '测试老师',
          clazzId: '911',
          className: '911班',
          sourceUrl: 'https://mooc1.chaoxing.com/course?courseid=910&clazzid=911&cpi=1'
        },
        'chaoxing'
      )
    })

    expect(store.listCourses().map((course) => course.name)).toContain('事务提交测试')
  })

  it('keeps the previous success state and rolls back business rows when status metadata write fails', async () => {
    const store = openStore()
    let pull = emptyPull()
    const service = new ChaoxingSessionService(store, {
      checkSession: async () => ({
        authState: 'authenticated',
        message: '已登录',
        profile: { name: '测试同学', school: '示例大学', uid: '10001', fid: null },
        httpStatus: 200,
        transport: 'session_fetch',
        cookieDomainCount: 2
      }),
      pull: async () => pull
    })

    await service.sync(true, { operationId: 'd006-baseline' })
    const before = service.getStatus()
    const originalSetMeta = store.setMeta.bind(store)
    vi.spyOn(store, 'setMeta').mockImplementation((key, value) => {
      if (key === 'chaoxing_session_status' && value.includes('"lastRunCommitted":true')) {
        throw new Error('simulated metadata write failure')
      }
      originalSetMeta(key, value)
    })

    pull = emptyPull({
      courses: [
        {
          externalId: '920:921',
          courseId: '920',
          cpi: '1',
          name: '不应落库的课程',
          teacher: '测试老师',
          clazzId: '921',
          sourceUrl: 'https://mooc1.chaoxing.com/course?courseid=920&clazzid=921&cpi=1',
          schedule: []
        }
      ]
    })

    const after = await service.sync(true, { operationId: 'd006-rollback' })
    expect(store.listCourses().map((course) => course.name)).not.toContain('不应落库的课程')
    expect(after.lastSyncAt).toBe(before.lastSyncAt)
    expect(after.lastCompleteSyncAt).toBe(before.lastCompleteSyncAt)
    expect(after.lastOutcome).toBe('failure')
  })
})

function emptyPull(overrides: Partial<ChaoxingPullResult> = {}): ChaoxingPullResult {
  return {
    courses: [],
    tasks: [],
    errors: [],
    warnings: [],
    checkedAt: new Date().toISOString(),
    ...overrides
  }
}
