import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StudyNextStore } from '../../src/main/storage/store'
import { ChaoxingSessionService } from '../../src/main/integrations/chaoxing/service'
import type {
  ChaoxingAdapterLike,
  ChaoxingPullResult
} from '../../src/main/integrations/chaoxing/adapter'
import {
  WorkspaceManager,
  backupSqliteDatabase,
  readLegacySessionUid,
  verifySqliteDatabase,
  workspaceIdForPlatformUid
} from '../../src/main/storage/workspaces'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studynext-workspaces-'))
  tempDirs.push(dir)
  return dir
}

function fileHash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function createLegacyDatabase(dir: string): string {
  const file = join(dir, 'legacy.sqlite')
  const store = new StudyNextStore(file)
  store.createTask({
    title: '历史任务',
    description: '来自旧单库',
    courseId: null,
    priority: 'medium',
    kind: 'homework',
    dueAt: '2026-12-01T12:00:00.000Z',
    reminderOffsets: []
  })
  store.setMeta(
    'chaoxing_session_status',
    JSON.stringify({ studentId: '468846679', displayName: '钟嘉杨' })
  )
  store.close()
  return file
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('账号工作区与数据库备份', () => {
  it('工作区 ID 由平台 UID 稳定派生且不同账号不同', () => {
    const a1 = workspaceIdForPlatformUid('468846679')
    const a2 = workspaceIdForPlatformUid('468846679')
    const b = workspaceIdForPlatformUid('100000001')
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
    expect(a1).toMatch(/^chaoxing-[0-9a-f]{24}$/)
    expect(() => workspaceIdForPlatformUid('')).toThrow()
  })

  it('VACUUM INTO 生成事务一致备份并通过恢复读取校验', () => {
    const dir = tempDir()
    const source = createLegacyDatabase(dir)
    const backup = join(dir, 'backup.sqlite')
    backupSqliteDatabase(source, backup)
    const result = verifySqliteDatabase(backup)
    expect(result.integrity).toBe('ok')
    expect(result.tables.tasks).toBeGreaterThanOrEqual(1)

    // 实际打开备份验证数据，而不是只看文件大小。
    const restored = new StudyNextStore(backup, { readOnly: true })
    try {
      expect(restored.listTasks().some((task) => task.title === '历史任务')).toBe(true)
      expect(readLegacySessionUid(backup)).toBe('468846679')
    } finally {
      restored.close()
    }
  })

  it('历史库中的非数字 studentId 不会被当成平台 UID', () => {
    const dir = tempDir()
    const file = join(dir, 'invalid-uid.sqlite')
    const store = new StudyNextStore(file)
    store.setMeta('chaoxing_session_status', JSON.stringify({ studentId: 'zhangsan' }))
    store.close()
    expect(readLegacySessionUid(file)).toBeNull()
  })

  it('已验证账号使用独立数据库，A/B 数据互不可见', () => {
    const dir = tempDir()
    const manager = new WorkspaceManager(dir)
    const accountA = { id: 'account-a', platformUid: '468846679' }
    const accountB = { id: 'account-b', platformUid: '100000001' }
    const workspaceA = manager.ensureWorkspaceForAccount(accountA)
    const workspaceB = manager.ensureWorkspaceForAccount(accountB)
    expect(workspaceA.filePath).not.toBe(workspaceB.filePath)

    const storeA = new StudyNextStore(workspaceA.filePath, { workspaceId: workspaceA.id })
    const storeB = new StudyNextStore(workspaceB.filePath, { workspaceId: workspaceB.id })
    try {
      storeA.createTask({
        title: 'A 账号任务',
        description: 'A only',
        courseId: null,
        priority: 'high',
        kind: 'homework',
        dueAt: '2026-12-02T12:00:00.000Z',
        reminderOffsets: []
      })
      expect(storeA.listTasks().some((task) => task.title === 'A 账号任务')).toBe(true)
      expect(storeB.listTasks().some((task) => task.title === 'A 账号任务')).toBe(false)
    } finally {
      storeA.close()
      storeB.close()
    }
  })

  it('已验证账号启动不会自动迁移历史库，空账号工作区与只读历史并存', () => {
    const dir = tempDir()
    const legacy = createLegacyDatabase(dir)
    const manager = new WorkspaceManager(dir)
    const account = { id: 'account-a', platformUid: '468846679', displayName: '钟嘉杨' }
    const startup = manager.resolveStartupWorkspace(account, { legacyPath: legacy })
    expect(startup.status).toBe('active')
    expect(startup.accountId).toBe('account-a')
    expect(startup.filePath).not.toBe(legacy)
    expect(manager.list().some((workspace) => workspace.status === 'readonly')).toBe(true)
    const original = new StudyNextStore(legacy, { readOnly: true })
    try {
      expect(original.listTasks().some((task) => task.title === '历史任务')).toBe(true)
    } finally {
      original.close()
    }
  })

  it('目标工作区已有数据时拒绝迁移覆盖', () => {
    const dir = tempDir()
    const legacy = createLegacyDatabase(dir)
    const manager = new WorkspaceManager(dir)
    const account = { id: 'account-a', platformUid: '468846679', displayName: '钟嘉杨' }
    const workspace = manager.ensureWorkspaceForAccount(account)
    const target = new StudyNextStore(workspace.filePath)
    target.createTask({
      title: '目标库已有任务',
      description: '',
      courseId: null,
      priority: 'medium',
      kind: 'homework',
      dueAt: '2026-12-02T12:00:00.000Z',
      reminderOffsets: [30]
    })
    target.upsertDownload({
      id: 'target-download',
      filename: 'target.pdf',
      url: 'https://example.invalid/target.pdf',
      state: 'completed',
      receivedBytes: 5,
      totalBytes: 5,
      startedAt: '2026-12-01T10:00:00.000Z',
      completedAt: '2026-12-01T10:00:01.000Z',
      savePath: 'D:\\Downloads\\StudyNext\\target.pdf'
    })
    target.close()
    expect(() => manager.migrateLegacyForVerifiedAccount(account, legacy)).toThrow()
    const stillThere = new StudyNextStore(workspace.filePath, { readOnly: true })
    try {
      expect(stillThere.listTasks().some((task) => task.title === '目标库已有任务')).toBe(true)
      expect(
        stillThere.listTasks().find((task) => task.title === '目标库已有任务')?.reminders
      ).toHaveLength(1)
      expect(stillThere.listDownloads()).toHaveLength(1)
    } finally {
      stillThere.close()
    }
  })

  it('历史库在 UID 证据匹配时复制到账号工作区，原库保留且可恢复', () => {
    const dir = tempDir()
    const legacy = createLegacyDatabase(dir)
    const manager = new WorkspaceManager(dir)
    const workspace = manager.migrateLegacyForVerifiedAccount(
      { id: 'account-a', platformUid: '468846679', displayName: '钟嘉杨' },
      legacy
    )
    expect(workspace.migrationSource).toBe(legacy)
    const restored = new StudyNextStore(workspace.filePath, { readOnly: true })
    try {
      expect(restored.listTasks().some((task) => task.title === '历史任务')).toBe(true)
    } finally {
      restored.close()
    }
    // 原库仍在，且仍可读取。
    const original = new StudyNextStore(legacy, { readOnly: true })
    try {
      expect(original.listTasks().some((task) => task.title === '历史任务')).toBe(true)
    } finally {
      original.close()
    }
  })

  it('迁移发布前目标突然出现时拒绝覆盖，源和目标字节不变', () => {
    const dir = tempDir()
    const legacy = createLegacyDatabase(dir)
    const manager = new WorkspaceManager(dir)
    const account = { id: 'account-a', platformUid: '468846679', displayName: '钟嘉杨' }
    const workspace = manager.ensureWorkspaceForAccount(account)
    const sourceHash = fileHash(legacy)
    let targetHash = ''
    expect(() =>
      manager.migrateLegacyForVerifiedAccount(account, legacy, () => {
        const target = new StudyNextStore(workspace.filePath)
        target.createTask({
          title: '发布前突然出现的任务',
          description: '',
          courseId: null,
          priority: 'medium',
          kind: 'homework',
          dueAt: '2026-12-05T12:00:00.000Z',
          reminderOffsets: []
        })
        target.close()
        targetHash = fileHash(workspace.filePath)
      })
    ).toThrow()
    expect(fileHash(workspace.filePath)).toBe(targetHash)
    expect(fileHash(legacy)).toBe(sourceHash)
    expect(
      readdirSync(join(dir, 'workspaces')).filter((name) => name.includes('.migrating-'))
    ).toHaveLength(0)
    // 重复执行仍然拒绝，不会覆盖目标。
    expect(() => manager.migrateLegacyForVerifiedAccount(account, legacy)).toThrow()
  })

  it('相同 courseId/clazzId/assignmentId 在 A/B 工作区中互不覆盖，下载与提醒也隔离', () => {
    const dir = tempDir()
    const manager = new WorkspaceManager(dir)
    const workspaceA = manager.ensureWorkspaceForAccount({
      id: 'account-a',
      platformUid: '468846679'
    })
    const workspaceB = manager.ensureWorkspaceForAccount({
      id: 'account-b',
      platformUid: '100000001'
    })
    const storeA = new StudyNextStore(workspaceA.filePath, {
      workspaceId: workspaceA.id,
      accountId: 'account-a'
    })
    const storeB = new StudyNextStore(workspaceB.filePath, {
      workspaceId: workspaceB.id,
      accountId: 'account-b'
    })
    try {
      const courseA = storeA.upsertProviderCourse({
        externalId: '266936191:154266737',
        name: 'A 课程',
        teacher: 'A 老师',
        sourceUrl: null
      }).course
      const courseB = storeB.upsertProviderCourse({
        externalId: '266936191:154266737',
        name: 'B 课程',
        teacher: 'B 老师',
        sourceUrl: null
      }).course
      storeA.createTask(
        {
          title: 'A 同名作业',
          description: 'A',
          courseId: courseA.id,
          priority: 'high',
          kind: 'homework',
          dueAt: '2026-12-10T12:00:00.000Z',
          reminderOffsets: [30]
        },
        { source: 'chaoxing', externalId: 'assignment-1' }
      )
      storeB.createTask(
        {
          title: 'B 同名作业',
          description: 'B',
          courseId: courseB.id,
          priority: 'low',
          kind: 'homework',
          dueAt: '2026-12-20T12:00:00.000Z',
          reminderOffsets: [60]
        },
        { source: 'chaoxing', externalId: 'assignment-1' }
      )
      storeA.upsertDownload({
        id: 'download-a',
        filename: 'a.pdf',
        url: 'https://example.invalid/a.pdf',
        state: 'completed',
        receivedBytes: 10,
        totalBytes: 10,
        startedAt: '2026-12-01T10:00:00.000Z',
        completedAt: '2026-12-01T10:00:01.000Z',
        savePath: 'D:\\Downloads\\StudyNext\\a.pdf'
      })
      const taskA = storeA.listTasks().find((task) => task.title === 'A 同名作业')
      const taskB = storeB.listTasks().find((task) => task.title === 'B 同名作业')
      expect(taskA?.title).toBe('A 同名作业')
      expect(taskB?.title).toBe('B 同名作业')
      expect(taskA?.reminders[0]?.offsetMinutes).toBe(30)
      expect(taskB?.reminders[0]?.offsetMinutes).toBe(60)
      expect(storeA.listDownloads()).toHaveLength(1)
      expect(storeB.listDownloads()).toHaveLength(0)
      manager.setActive(workspaceB.id)
      const restartedManager = new WorkspaceManager(dir)
      expect(restartedManager.getActive()?.id).toBe(workspaceB.id)
    } finally {
      storeA.close()
      storeB.close()
    }
  })

  it('A/B 账号切换经过启动工作区解析后仍保持各自数据', () => {
    const dir = tempDir()
    const manager = new WorkspaceManager(dir)
    const accountA = { id: 'account-a', platformUid: '468846679' }
    const accountB = { id: 'account-b', platformUid: '100000001' }
    const workspaceA = manager.ensureWorkspaceForAccount(accountA)
    manager.setActive(workspaceA.id)
    const storeA = new StudyNextStore(workspaceA.filePath, {
      workspaceId: workspaceA.id,
      accountId: accountA.id
    })
    storeA.createTask({
      title: 'A only',
      description: '',
      courseId: null,
      priority: 'medium',
      kind: 'homework',
      dueAt: '2026-12-05T12:00:00.000Z',
      reminderOffsets: []
    })
    storeA.close()

    const workspaceB = manager.beginAccountSwitch(accountB)
    const startupB = manager.resolveStartupWorkspace(accountB)
    expect(startupB.id).toBe(workspaceB.id)
    const storeB = new StudyNextStore(startupB.filePath, {
      workspaceId: startupB.id,
      accountId: accountB.id
    })
    expect(storeB.listTasks().some((task) => task.title === 'A only')).toBe(false)
    storeB.createTask({
      title: 'B only',
      description: '',
      courseId: null,
      priority: 'medium',
      kind: 'homework',
      dueAt: '2026-12-06T12:00:00.000Z',
      reminderOffsets: []
    })
    storeB.close()

    manager.clearPendingSwitch()
    manager.beginAccountSwitch(accountA)
    const startupA = manager.resolveStartupWorkspace(accountA)
    const reopenedA = new StudyNextStore(startupA.filePath, {
      workspaceId: startupA.id,
      accountId: accountA.id,
      readOnly: true
    })
    try {
      expect(reopenedA.listTasks().some((task) => task.title === 'A only')).toBe(true)
      expect(reopenedA.listTasks().some((task) => task.title === 'B only')).toBe(false)
    } finally {
      reopenedA.close()
    }
  })

  it('待切换工作区只有在账号与平台 UID 一致时才允许启动', () => {
    const dir = tempDir()
    const manager = new WorkspaceManager(dir)
    const accountA = { id: 'account-a', platformUid: '468846679' }
    const accountB = { id: 'account-b', platformUid: '100000001' }
    const workspaceA = manager.ensureWorkspaceForAccount(accountA)
    manager.setActive(workspaceA.id)
    const workspaceB = manager.beginAccountSwitch(accountB)
    expect(manager.getPendingSwitch()).toMatchObject({
      accountId: 'account-b',
      workspaceId: workspaceB.id,
      platformUid: '100000001'
    })
    const resolved = manager.resolveStartupWorkspace(accountB)
    expect(resolved.id).toBe(workspaceB.id)
    expect(() => manager.resolveStartupWorkspace(accountA)).toThrow()
  })

  it('本机工作区使用独立路径，不复用历史数据库', () => {
    const dir = tempDir()
    const legacy = createLegacyDatabase(dir)
    const manager = new WorkspaceManager(dir)
    const local = manager.ensureLocalWorkspace()
    expect(local.filePath).not.toBe(legacy)
    expect(local.filePath).toContain('local.sqlite')
  })

  it('没有已验证账号时，带平台 UID 的历史库以只读工作区启动', () => {
    const dir = tempDir()
    const legacy = createLegacyDatabase(dir)
    const manager = new WorkspaceManager(dir)
    const workspace = manager.resolveStartupWorkspace(null, { legacyPath: legacy })
    expect(workspace.status).toBe('readonly')
    expect(workspace.accountId).toBe('legacy-readonly')
    const store = new StudyNextStore(workspace.filePath, {
      workspaceId: workspace.id,
      accountId: workspace.accountId,
      readOnly: true
    })
    try {
      expect(store.listTasks().some((task) => task.title === '历史任务')).toBe(true)
    } finally {
      store.close()
    }
  })

  it('归属不明的历史库只创建只读副本，不认领到任何账号', () => {
    const dir = tempDir()
    const legacy = createLegacyDatabase(dir)
    const manager = new WorkspaceManager(dir)
    const readonly = manager.createLegacyReadonlyWorkspace(legacy)
    expect(readonly.status).toBe('readonly')
    expect(readonly.accountId).toBe('legacy-readonly')
    expect(readonly.platformUid).toBe('')
    expect(manager.findForAccount('account-a')).toBeNull()
    const store = new StudyNextStore(readonly.filePath, { readOnly: true })
    try {
      expect(store.listTasks().some((task) => task.title === '历史任务')).toBe(true)
      expect(() =>
        store.createTask({
          title: '不应写入',
          description: '',
          courseId: null,
          priority: 'medium',
          kind: 'homework',
          dueAt: '2026-12-03T12:00:00.000Z',
          reminderOffsets: []
        })
      ).toThrow()
    } finally {
      store.close()
    }
  })

  it('账号切换后旧 pull 结果晚返回不会写入新工作区', async () => {
    const store = new StudyNextStore(':memory:')
    let resolvePull: ((value: ChaoxingPullResult) => void) | undefined
    const checkedAt = new Date().toISOString()
    const result: ChaoxingPullResult = {
      courses: [
        {
          externalId: '266936191:154266737',
          courseId: '266936191',
          clazzId: '154266737',
          cpi: '576016073',
          name: '旧账号课程',
          teacher: '旧老师',
          schedule: [],
          sourceUrl: ''
        }
      ],
      tasks: [
        {
          externalId: '266936191:154266737:assignment-1',
          title: '旧账号作业',
          description: '',
          courseExternalId: '266936191:154266737',
          dueAt: '2026-12-20T15:59:00.000Z',
          platformStatus: '未提交',
          platformStatusKind: 'not_submitted',
          sourceUrl: null,
          submittedAt: null,
          score: null,
          fullScore: null,
          teacherFeedback: null,
          attachments: []
        }
      ],
      errors: [],
      warnings: [],
      checkedAt
    }
    const adapter = {
      checkSession: async () => ({
        authState: 'authenticated' as const,
        message: '已登录',
        profile: { name: '旧账号', school: '旧学校', uid: '468846679', fid: '1' },
        httpStatus: 200,
        transport: 'session_fetch' as const,
        cookieDomainCount: 1
      }),
      pull: () =>
        new Promise<ChaoxingPullResult>((resolve) => {
          resolvePull = resolve
        })
    } as ChaoxingAdapterLike
    const service = new ChaoxingSessionService(store, adapter)
    try {
      const pending = service.sync(true)
      await new Promise((resolve) => setTimeout(resolve, 20))
      service.resetForAccountSwitch()
      resolvePull?.(result)
      const status = await pending
      expect(status.message).toContain('已切换学习通账号')
      expect(store.findTaskByExternalId('chaoxing', '266936191:154266737:assignment-1')).toBeNull()
      expect(store.findCourseByExternalId('chaoxing', '266936191:154266737')).toBeNull()
    } finally {
      store.close()
    }
  })
})
