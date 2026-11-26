import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StudyNextStore } from '../../src/main/storage/store'

let store: StudyNextStore

beforeEach(() => {
  store = new StudyNextStore(':memory:')
})

afterEach(() => {
  store.close()
})

function dueIn(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
}

function createPlatformTask(): ReturnType<StudyNextStore['getTask']> {
  return store.createTask(
    {
      title: '平台作业',
      description: '学习通同步任务',
      courseId: null,
      priority: 'medium',
      kind: 'homework',
      dueAt: dueIn(24),
      reminderOffsets: [],
      status: 'done'
    },
    {
      source: 'chaoxing',
      externalId: 'chaoxing:test:platform',
      completionSource: 'local',
      manualFields: ['status'],
      fieldSources: { status: 'manual' },
      platformStatus: '待批阅',
      platformStatusKind: 'pending_review'
    }
  )
}

describe('平台任务本地变更保护', () => {
  it('setTaskCompleted 对平台任务 true/false 都拒绝，且不写库', () => {
    const task = createPlatformTask()
    if (!task) throw new Error('平台任务创建失败')
    const before = store.getTask(task.id)

    expect(() => store.setTaskCompleted(task.id, true)).toThrow('学习通任务')
    expect(() => store.setTaskCompleted(task.id, false)).toThrow('学习通任务')
    expect(store.getTask(task.id)).toEqual(before)
  })

  it('deleteTask 拒绝删除平台任务，任务仍存在', () => {
    const task = createPlatformTask()
    if (!task) throw new Error('平台任务创建失败')

    expect(() => store.deleteTask(task.id)).toThrow('学习通任务')
    expect(store.getTask(task.id)).not.toBeNull()
  })

  it('updateTask 拒绝修改平台任务完成状态，且不写库', () => {
    const task = createPlatformTask()
    if (!task) throw new Error('平台任务创建失败')
    const before = store.getTask(task.id)

    expect(() =>
      store.updateTask(task.id, {
        title: task.title,
        description: task.description,
        courseId: task.courseId,
        priority: task.priority,
        kind: task.kind,
        dueAt: task.dueAt,
        reminderOffsets: [],
        status: 'todo'
      })
    ).toThrow('学习通任务')
    expect(store.getTask(task.id)).toEqual(before)
  })

  it('updateTask 仍允许修改平台任务的普通字段', () => {
    const task = createPlatformTask()
    if (!task) throw new Error('平台任务创建失败')

    const updated = store.updateTask(task.id, {
      title: '平台作业（仅改标题）',
      description: task.description,
      courseId: task.courseId,
      priority: task.priority,
      kind: task.kind,
      dueAt: task.dueAt,
      reminderOffsets: []
    })

    expect(updated.title).toBe('平台作业（仅改标题）')
    expect(updated.status).toBe('done')
  })

  it('平台同步可清除旧的 status 手动保护并恢复平台状态', () => {
    const task = createPlatformTask()
    if (!task) throw new Error('平台任务创建失败')

    const result = store.upsertImportedTask(
      {
        title: task.title,
        description: task.description,
        courseId: task.courseId,
        priority: task.priority,
        kind: task.kind,
        dueAt: task.dueAt,
        reminderOffsets: [],
        status: 'todo'
      },
      {
        source: 'chaoxing',
        externalId: 'chaoxing:test:platform',
        platformStatus: '待提交',
        platformStatusKind: 'not_submitted'
      }
    )

    expect(result.action).toBe('updated')
    expect(result.conflicts).not.toContain('status')
    expect(result.task.status).toBe('todo')
    expect(result.task.completionSource).toBeNull()
    expect(result.task.manualFields).not.toContain('status')
    expect(result.task.platformStatusKind).toBe('not_submitted')
  })

  it('本地任务保持完成、取消完成、删除能力，提醒不受影响', () => {
    const task = store.createTask({
      title: '本地任务',
      description: '',
      courseId: null,
      priority: 'low',
      kind: 'other',
      dueAt: dueIn(48),
      reminderOffsets: [60]
    })

    expect(task.reminders.map((rule) => rule.offsetMinutes)).toEqual([60])
    expect(store.setTaskCompleted(task.id, true).status).toBe('done')
    expect(store.getTask(task.id)?.reminders.map((rule) => rule.offsetMinutes)).toEqual([60])
    expect(store.setTaskCompleted(task.id, false).status).toBe('todo')
    store.deleteTask(task.id)
    expect(store.getTask(task.id)).toBeNull()
  })
})
