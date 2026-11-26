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

  it('清理学习通学习点时不删除其他来源的学习点', () => {
    const course = store.listCourses()[0]
    if (!course) throw new Error('demo course missing')
    const chapter = store.upsertSnapshotChapter(
      {
        courseId: course.id,
        externalId: 'chaoxing:empty-tasks',
        title: '平台暂无任务点',
        sortOrder: 99,
        progress: 0
      },
      'chaoxing'
    ).chapter
    store.upsertSnapshotPoint(
      {
        chapterId: chapter.id,
        courseId: course.id,
        externalId: 'chaoxing:point-to-remove',
        title: '旧解析误生成的学习点',
        kind: 'reading',
        completed: true,
        durationMinutes: null,
        sortOrder: 0
      },
      'chaoxing'
    )
    expect(
      store.listStudyPoints().some((point) => point.externalId === 'chaoxing:point-to-remove')
    ).toBe(true)
    expect(store.deleteProviderStudyPoints(course.id, 'chaoxing')).toBe(1)
    expect(
      store.listStudyPoints().some((point) => point.externalId === 'chaoxing:point-to-remove')
    ).toBe(false)
  })

  it('下载历史可以按单条删除，不影响其他记录', () => {
    const base = {
      filename: '资料.pdf',
      url: 'https://pan-yz.chaoxing.com/file',
      state: 'completed' as const,
      receivedBytes: 1024,
      totalBytes: 1024,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      savePath: 'D:\\Downloads\\StudyNext\\资料.pdf'
    }
    store.upsertDownload({ ...base, id: 'download-a' })
    store.upsertDownload({ ...base, id: 'download-b', filename: '资料-副本.pdf' })
    expect(store.listDownloads().map((item) => item.id)).toContain('download-a')

    store.deleteDownload('download-a')
    const remaining = store.listDownloads()
    expect(remaining.map((item) => item.id)).not.toContain('download-a')
    expect(remaining.map((item) => item.id)).toContain('download-b')
  })

  it('下载记录保留资料关联，重复更新不会丢失 materialId', () => {
    const base = {
      filename: '资料.pdf',
      url: 'https://pan-yz.chaoxing.com/file',
      state: 'progressing' as const,
      receivedBytes: 0,
      totalBytes: 2048,
      startedAt: new Date().toISOString(),
      completedAt: null
    }
    store.upsertDownload({ ...base, id: 'download-material', materialId: 'material-a' })
    store.upsertDownload({
      ...base,
      id: 'download-material',
      state: 'completed',
      receivedBytes: 2048,
      completedAt: new Date().toISOString(),
      materialId: null
    })
    const row = store.listDownloads().find((item) => item.id === 'download-material')
    expect(row?.materialId).toBe('material-a')
    expect(row?.state).toBe('completed')
  })

  it('下载记录保留附件身份，重复更新不会丢失 taskId、objectId 和 index', () => {
    const base = {
      filename: '作业附件.docx',
      url: 'https://d0.cldisk.com/download/example',
      state: 'progressing' as const,
      receivedBytes: 0,
      totalBytes: 1024,
      startedAt: new Date().toISOString(),
      completedAt: null
    }
    store.upsertDownload({
      ...base,
      id: 'download-attachment',
      attachmentTaskId: 'task-a',
      attachmentObjectId: 'a'.repeat(32),
      attachmentFileName: '报告.docx',
      attachmentIndex: 1
    })
    store.upsertDownload({
      ...base,
      id: 'download-attachment',
      state: 'completed',
      receivedBytes: 1024,
      completedAt: new Date().toISOString()
    })
    const row = store.listDownloads().find((item) => item.id === 'download-attachment')
    expect(row?.attachmentTaskId).toBe('task-a')
    expect(row?.attachmentObjectId).toBe('a'.repeat(32))
    expect(row?.attachmentFileName).toBe('报告.docx')
    expect(row?.attachmentIndex).toBe(1)
    expect(row?.state).toBe('completed')
  })

  it('旧下载记录缺少 objectId 时仍可打开并保留为不可验证身份', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studynext-download-migrate-'))
    const file = join(dir, 'studynext.sqlite')
    const first = new StudyNextStore(file)
    try {
      first.upsertDownload({
        id: 'download-old',
        filename: '旧附件.docx',
        url: 'https://d0.cldisk.com/download/old',
        state: 'completed',
        receivedBytes: 10,
        totalBytes: 10,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        attachmentTaskId: 'task-old',
        attachmentIndex: 0
      })
    } finally {
      first.close()
    }
    const raw = new DatabaseSync(file)
    raw.exec('ALTER TABLE downloads DROP COLUMN attachment_object_id')
    raw.exec('ALTER TABLE downloads DROP COLUMN attachment_file_name')
    raw.close()

    const migrated = new StudyNextStore(file)
    try {
      const row = migrated.listDownloads().find((item) => item.id === 'download-old')
      expect(row?.attachmentTaskId).toBe('task-old')
      expect(row?.attachmentObjectId).toBeNull()
      expect(row?.attachmentFileName).toBeNull()
      expect(row?.attachmentIndex).toBe(0)
    } finally {
      migrated.close()
      rmSync(dir, { recursive: true, force: true })
    }
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
      first.updateSettings({ theme: 'light', calendarWeekStartsOn: 0, uiZoom: 0.85 })
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
      expect(second.getSettings().uiZoom).toBe(0.85)
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
      'submitted_at',
      'score',
      'full_score',
      'teacher_feedback',
      'attachments_json',
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
          'submitted_at',
          'score',
          'full_score',
          'teacher_feedback',
          'attachments_json',
          'manual_fields_json',
          'field_sources_json'
        ])
      )
      expect(migrated.getTask(taskId)?.title).toBe('迁移前任务')
      expect(migrated.getTask(taskId)?.sourceUrl).toBeNull()
      expect(migrated.getTask(taskId)?.platformStatusKind).toBe('unknown')
      expect(migrated.getTask(taskId)?.attachments).toEqual([])
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

  it('旧数据库包含历史 questions 表和 ai_config 元数据时可无损打开', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studynext-legacy-q-'))
    const file = join(dir, 'legacy.sqlite')
    const seeded = new StudyNextStore(file)
    seeded.close()

    const rawDb = new DatabaseSync(file)
    try {
      rawDb.exec(`
        CREATE TABLE IF NOT EXISTS questions (
          id TEXT PRIMARY KEY,
          question TEXT NOT NULL,
          answer TEXT NOT NULL DEFAULT '',
          explanation TEXT NOT NULL DEFAULT '',
          course_id TEXT,
          tags_json TEXT NOT NULL DEFAULT '[]',
          source TEXT NOT NULL DEFAULT 'manual',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO questions (id, question, answer, explanation, course_id, tags_json, source, created_at, updated_at)
        VALUES ('legacy-q-1', '旧题目内容', '旧答案', '旧解析', NULL, '[]', 'manual', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
        INSERT OR REPLACE INTO app_meta (key, value) VALUES ('ai_config', '{"enabled":true}');
      `)
    } finally {
      rawDb.close()
    }

    const reopened = new StudyNextStore(file)
    try {
      expect(reopened.listTasks().length).toBeGreaterThan(0)
      expect(reopened.getMeta('ai_config')).toBe('{"enabled":true}')
      const row = reopened.db
        .prepare('SELECT question FROM questions WHERE id = ?')
        .get('legacy-q-1') as { question: string } | undefined
      expect(row?.question).toBe('旧题目内容')
    } finally {
      reopened.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
