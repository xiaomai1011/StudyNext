import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

describe('SQLite 持久化', () => {
  it('首次启动写入 5 门演示课程与 15 项演示任务', () => {
    expect(store.listCourses()).toHaveLength(5)
    expect(store.listTasks()).toHaveLength(15)
  })

  it('任务新增、读取、修改、完成与删除形成闭环', () => {
    const created = store.createTask({
      title: '数据库课程设计',
      description: '完成概念模型与关系模式',
      courseId: null,
      priority: 'high',
      kind: 'homework',
      dueAt: dueIn(48),
      reminderOffsets: [1440, 180]
    })
    expect(created.reminders.map((rule) => rule.offsetMinutes)).toEqual([1440, 180])
    expect(store.getTask(created.id)?.title).toBe('数据库课程设计')

    const updated = store.updateTask(created.id, {
      title: '数据库课程设计（修订）',
      description: '补充物理设计',
      courseId: null,
      priority: 'medium',
      kind: 'homework',
      dueAt: dueIn(72),
      reminderOffsets: [60]
    })
    expect(updated.title).toBe('数据库课程设计（修订）')
    expect(updated.reminders.map((rule) => rule.offsetMinutes)).toEqual([60])

    const completed = store.setTaskCompleted(created.id, true)
    expect(completed.status).toBe('done')
    expect(completed.completedAt).not.toBeNull()
    expect(store.setTaskCompleted(created.id, false).completedAt).toBeNull()

    store.deleteTask(created.id)
    expect(store.getTask(created.id)).toBeNull()
  })

  it('修改截止时间会清除旧提醒投递记录，使新 DDL 可以重新提醒', () => {
    const created = store.createTask({
      title: '提醒重排测试',
      description: '',
      courseId: null,
      priority: 'medium',
      kind: 'other',
      dueAt: dueIn(24),
      reminderOffsets: [60]
    })
    const rule = created.reminders[0]
    expect(rule).toBeDefined()
    const key = store.claimDelivery({
      taskId: created.id,
      ruleId: rule!.id,
      dueAt: created.dueAt,
      scheduledFor: dueIn(23)
    })
    expect(key).not.toBeNull()
    expect(store.hasDelivery(created.id, rule!.id, created.dueAt)).toBe(true)

    const updated = store.updateTask(created.id, {
      title: created.title,
      description: '',
      courseId: null,
      priority: 'medium',
      kind: 'other',
      dueAt: dueIn(48),
      reminderOffsets: [60]
    })
    const nextRule = updated.reminders[0]!
    expect(store.hasDelivery(updated.id, nextRule.id, updated.dueAt)).toBe(false)
  })

  it('相同任务、规则与截止时间的通知只投递一次', () => {
    const created = store.createTask({
      title: '通知去重测试',
      description: '',
      courseId: null,
      priority: 'medium',
      kind: 'other',
      dueAt: dueIn(10),
      reminderOffsets: [60]
    })
    const rule = created.reminders[0]!
    const input = {
      taskId: created.id,
      ruleId: rule.id,
      dueAt: created.dueAt,
      scheduledFor: dueIn(9)
    }
    expect(store.claimDelivery(input)).not.toBeNull()
    expect(store.claimDelivery(input)).toBeNull()

    const nextDueAt = new Date(new Date(created.dueAt).getTime() + 60_000).toISOString()
    const key = store.claimDelivery({ ...input, dueAt: nextDueAt })
    expect(key).not.toBeNull()
    store.releaseDelivery(key!)
    expect(store.hasDelivery(created.id, rule.id, nextDueAt)).toBe(false)
  })

  it('课程收藏与设置修改会写入数据库', () => {
    const course = store.listCourses()[0]!
    expect(store.setCourseFavorite(course.id, true).favorite).toBe(true)
    const settings = store.updateSettings({
      theme: 'dark',
      notificationsEnabled: false,
      defaultReminderOffsets: [1440, 60]
    })
    expect(settings.theme).toBe('dark')
    expect(settings.notificationsEnabled).toBe(false)
    expect(store.getSettings().defaultReminderOffsets).toEqual([1440, 60])
  })

  it('关闭并重新打开数据库后任务与设置仍然存在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studynext-store-'))
    const file = join(dir, 'studynext.sqlite')
    const first = new StudyNextStore(file)
    try {
      first.updateSettings({ theme: 'light', calendarWeekStartsOn: 0 })
      first.createTask({
        title: '重启后仍然存在的任务',
        description: '持久化验证',
        courseId: null,
        priority: 'low',
        kind: 'reading',
        dueAt: dueIn(30),
        reminderOffsets: [180]
      })
    } finally {
      first.close()
    }

    const second = new StudyNextStore(file)
    try {
      expect(second.listTasks()).toHaveLength(16)
      expect(second.listTasks().some((task) => task.title === '重启后仍然存在的任务')).toBe(true)
      expect(second.getSettings().theme).toBe('light')
      expect(second.getSettings().calendarWeekStartsOn).toBe(0)
    } finally {
      second.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('从 v2 数据库迁移到 v3，新增任务字段与变更日志且保留旧任务', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studynext-migrate-'))
    const file = join(dir, 'studynext.sqlite')
    const first = new StudyNextStore(file)
    let taskId = ''
    try {
      const task = first.createTask({
        title: '迁移前任务',
        description: '',
        courseId: null,
        priority: 'medium',
        kind: 'other',
        dueAt: dueIn(24),
        reminderOffsets: [60]
      })
      taskId = task.id
    } finally {
      first.close()
    }

    const raw = new DatabaseSync(file)
    raw.exec('DROP TABLE IF EXISTS task_change_log')
    for (const column of [
      'completion_source',
      'source_updated_at',
      'source_url',
      'platform_status',
      'platform_status_kind',
      'manual_fields_json',
      'field_sources_json'
    ]) {
      raw.exec(`ALTER TABLE tasks DROP COLUMN ${column}`)
    }
    raw.prepare("UPDATE app_meta SET value = '2' WHERE key = 'schema_version'").run()
    raw.close()

    const migrated = new StudyNextStore(file)
    try {
      const columns = (
        migrated.db.prepare('PRAGMA table_info(tasks)').all() as unknown as Array<{ name: string }>
      ).map((column) => column.name)
      expect(columns).toEqual(
        expect.arrayContaining([
          'completion_source',
          'source_updated_at',
          'source_url',
          'platform_status',
          'platform_status_kind',
          'manual_fields_json',
          'field_sources_json'
        ])
      )
      expect(migrated.getTask(taskId)?.title).toBe('迁移前任务')
      expect(migrated.getTask(taskId)?.sourceUrl).toBeNull()
      expect(migrated.getTask(taskId)?.platformStatusKind).toBe('unknown')
      expect(migrated.listTaskHistory(taskId)).toEqual([])
      expect(migrated.getMeta('schema_version')).toBe('3')
    } finally {
      migrated.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('一键恢复演示数据会移除手工数据并重建 15 项任务', () => {
    store.createTask({
      title: '将被清理',
      description: '',
      courseId: null,
      priority: 'medium',
      kind: 'other',
      dueAt: dueIn(12),
      reminderOffsets: []
    })
    expect(store.listTasks()).toHaveLength(16)
    store.resetDemoData()
    expect(store.listCourses()).toHaveLength(5)
    expect(store.listTasks()).toHaveLength(15)
    expect(store.listTasks().some((task) => task.title === '将被清理')).toBe(false)
  })

  it('增量导入按外部 ID 更新，保留手动字段并记录截止变化', () => {
    const first = store.upsertImportedTask(
      {
        title: '平台作业',
        description: '第一版',
        courseId: null,
        priority: 'medium',
        kind: 'homework',
        dueAt: dueIn(24),
        reminderOffsets: [60]
      },
      { externalId: 'homework-1', source: 'import' }
    )
    expect(first.action).toBe('created')

    const edited = store.updateTask(first.task.id, {
      title: '我改过的标题',
      description: first.task.description,
      courseId: first.task.courseId,
      priority: first.task.priority,
      kind: first.task.kind,
      dueAt: first.task.dueAt,
      reminderOffsets: [60]
    })
    expect(edited.manualFields).toContain('title')

    const second = store.upsertImportedTask(
      {
        title: '平台新标题',
        description: '第二版说明',
        courseId: null,
        priority: 'high',
        kind: 'homework',
        dueAt: dueIn(72),
        reminderOffsets: [60]
      },
      { externalId: 'homework-1', source: 'import', sourceUpdatedAt: dueIn(1) }
    )
    expect(second.action).toBe('updated')
    expect(second.task.title).toBe('我改过的标题')
    expect(second.task.description).toBe('第二版说明')
    expect(second.conflicts).toContain('title')
    expect(second.deadlineChanged).toBe(true)
    expect(store.listTaskHistory(first.task.id).length).toBeGreaterThan(1)

    store.setTaskCompleted(first.task.id, true)
    const third = store.upsertImportedTask(
      {
        title: '平台新标题',
        description: '第二版说明',
        courseId: null,
        priority: 'high',
        kind: 'homework',
        dueAt: dueIn(72),
        reminderOffsets: [60],
        status: 'todo'
      },
      { externalId: 'homework-1', source: 'import' }
    )
    expect(third.task.status).toBe('done')
    expect(third.task.completionSource).toBe('local')
    expect(third.conflicts).toContain('status')
  })
})
