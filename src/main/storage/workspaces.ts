import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface WorkspaceAccount {
  id: string
  platformUid: string
  displayName?: string | null
  school?: string | null
}

export interface WorkspaceRecord {
  id: string
  accountId: string
  platformUid: string
  displayName: string | null
  school: string | null
  filePath: string
  createdAt: string
  lastUsedAt: string
  status: 'active' | 'readonly'
  migrationSource: string | null
  /**
   * A newly created account workspace has not yet had a chance to inherit the
   * verified legacy database. The next startup may replace this empty shell
   * with a VACUUM INTO migration copy; a pending workspace is never treated as
   * user-authored data.
   */
  migrationPending?: boolean
}

interface WorkspaceRegistry {
  version: 1
  activeWorkspaceId: string | null
  workspaces: WorkspaceRecord[]
  pendingSwitch: PendingAccountSwitch | null
}

export interface WorkspaceBackupResult {
  path: string
  bytes: number
  integrity: string
  tables: Record<string, number>
}

export interface PendingAccountSwitch {
  accountId: string
  workspaceId: string
  platformUid: string
  requestedAt: string
}

const REGISTRY_FILE = 'account-workspaces.json'
const WORKSPACES_DIR = 'workspaces'
const MIGRATION_TABLES = [
  'courses',
  'tasks',
  'course_chapters',
  'study_points',
  'app_notices',
  'materials',
  'downloads',
  'task_reminders',
  'task_change_log',
  'exams'
] as const

/** Stable internal workspace id derived only from the verified platform UID. */
export function workspaceIdForPlatformUid(platformUid: string): string {
  const normalized = platformUid.trim()
  if (!/^[0-9A-Za-z_-]{4,80}$/.test(normalized)) {
    throw new Error('平台身份标识格式无效，无法创建账号工作区')
  }
  return `chaoxing-${createHash('sha256').update(`chaoxing:${normalized}`).digest('hex').slice(0, 24)}`
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Create a transactionally consistent SQLite copy via VACUUM INTO.
 * WAL/SHM journals are not copied as side files because VACUUM INTO reads the
 * logical database through SQLite and writes one self-contained database.
 */
export function backupSqliteDatabase(sourcePath: string, destinationPath: string): void {
  const source = resolve(sourcePath)
  const destination = resolve(destinationPath)
  if (!existsSync(source)) throw new Error(`数据库不存在：${source}`)
  if (existsSync(destination)) throw new Error(`备份目标已存在：${destination}`)
  mkdirSync(dirname(destination), { recursive: true })
  const db = new DatabaseSync(source)
  try {
    db.exec('PRAGMA busy_timeout = 5000;')
    db.exec(`VACUUM INTO ${quoteSqlString(destination)}`)
  } finally {
    db.close()
  }
}

export function verifySqliteDatabase(filePath: string): WorkspaceBackupResult {
  const path = resolve(filePath)
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const integrityRow = db.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined
    const integrity = String(integrityRow?.integrity_check ?? 'unknown')
    if (integrity !== 'ok') throw new Error(`SQLite 完整性检查失败：${integrity}`)
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all()
    if (foreignKeys.length > 0) {
      throw new Error(`SQLite 外键检查失败：${foreignKeys.length} 条异常引用`)
    }
    const tables: Record<string, number> = {}
    for (const table of MIGRATION_TABLES) {
      try {
        const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
          | { count?: number | bigint }
          | undefined
        tables[table] = Number(row?.count ?? 0)
      } catch (error) {
        // A missing table must never be reported as a valid zero count. That
        // would let a partially copied database pass migration verification.
        throw new Error(`数据库缺少可校验的数据表 ${table}：${String(error)}`)
      }
    }
    return { path, bytes: statSync(path).size, integrity, tables }
  } finally {
    db.close()
  }
}

/**
 * Publish a fully verified migration copy without ever replacing an existing
 * target. `link` is atomic and fails with EEXIST if the target appears between
 * verification and publication; unlike an `existsSync` check it cannot lose
 * the race. The temporary name is removed only after the link succeeds.
 */
export function publishMigrationFile(temporaryPath: string, targetPath: string): void {
  linkSync(temporaryPath, targetPath)
  try {
    rmSync(temporaryPath, { force: true })
  } catch {
    // The published target is already durable; a leftover temporary hardlink
    // is harmless and can be cleaned by the next migration attempt.
  }
}

/**
 * Account workspace registry.
 *
 * The registry contains only stable workspace metadata, never cookies,
 * passwords or tokens. The actual database lives under workspaces/.
 */
export class WorkspaceManager {
  private readonly registryPath: string
  private readonly workspacesDir: string

  constructor(private readonly dataDir: string) {
    this.registryPath = join(dataDir, REGISTRY_FILE)
    this.workspacesDir = join(dataDir, WORKSPACES_DIR)
    mkdirSync(this.workspacesDir, { recursive: true })
  }

  private readRegistry(): WorkspaceRegistry {
    if (!existsSync(this.registryPath)) {
      return { version: 1, activeWorkspaceId: null, workspaces: [], pendingSwitch: null }
    }
    try {
      const parsed = JSON.parse(
        readFileSync(this.registryPath, 'utf8')
      ) as Partial<WorkspaceRegistry>
      const workspaces = Array.isArray(parsed.workspaces)
        ? parsed.workspaces.filter(
            (item): item is WorkspaceRecord =>
              typeof item === 'object' &&
              item !== null &&
              typeof (item as WorkspaceRecord).id === 'string' &&
              typeof (item as WorkspaceRecord).platformUid === 'string' &&
              typeof (item as WorkspaceRecord).filePath === 'string'
          )
        : []
      const rawPending = parsed.pendingSwitch
      const pendingSwitch =
        rawPending &&
        typeof rawPending === 'object' &&
        typeof (rawPending as PendingAccountSwitch).accountId === 'string' &&
        typeof (rawPending as PendingAccountSwitch).workspaceId === 'string' &&
        typeof (rawPending as PendingAccountSwitch).platformUid === 'string' &&
        typeof (rawPending as PendingAccountSwitch).requestedAt === 'string'
          ? (rawPending as PendingAccountSwitch)
          : null
      return {
        version: 1,
        activeWorkspaceId:
          typeof parsed.activeWorkspaceId === 'string' ? parsed.activeWorkspaceId : null,
        workspaces,
        pendingSwitch
      }
    } catch {
      // A corrupt registry must not cause an account's database to be guessed.
      return { version: 1, activeWorkspaceId: null, workspaces: [], pendingSwitch: null }
    }
  }

  private writeRegistry(registry: WorkspaceRegistry): void {
    mkdirSync(dirname(this.registryPath), { recursive: true })
    const temporary = `${this.registryPath}.tmp-${randomUUID()}`
    writeFileSync(temporary, JSON.stringify(registry, null, 2), 'utf8')
    renameSync(temporary, this.registryPath)
  }

  list(): WorkspaceRecord[] {
    return this.readRegistry().workspaces
  }

  getActive(): WorkspaceRecord | null {
    const registry = this.readRegistry()
    if (!registry.activeWorkspaceId) return null
    return registry.workspaces.find((item) => item.id === registry.activeWorkspaceId) ?? null
  }

  findForPlatformUid(platformUid: string): WorkspaceRecord | null {
    return this.readRegistry().workspaces.find((item) => item.platformUid === platformUid) ?? null
  }

  findForAccount(accountId: string): WorkspaceRecord | null {
    return this.readRegistry().workspaces.find((item) => item.accountId === accountId) ?? null
  }

  /**
   * Create (or return) the independent workspace for a verified account.
   * The database is created empty and initialized by StudyNextStore on first boot.
   */
  ensureWorkspaceForAccount(account: WorkspaceAccount): WorkspaceRecord {
    const platformUid = account.platformUid.trim()
    if (!platformUid) throw new Error('不能为未验证身份创建可写工作区')
    const id = workspaceIdForPlatformUid(platformUid)
    const registry = this.readRegistry()
    const existing = registry.workspaces.find((item) => item.id === id)
    const now = new Date().toISOString()
    if (existing) {
      if (existing.platformUid !== platformUid) {
        throw new Error('工作区 ID 与平台身份映射冲突，已停止创建')
      }
      existing.accountId = account.id
      existing.displayName = account.displayName ?? existing.displayName
      existing.school = account.school ?? existing.school
      existing.lastUsedAt = now
      this.writeRegistry(registry)
      return existing
    }
    const record: WorkspaceRecord = {
      id,
      accountId: account.id,
      platformUid,
      displayName: account.displayName ?? null,
      school: account.school ?? null,
      filePath: join(this.workspacesDir, `${id}.sqlite`),
      createdAt: now,
      lastUsedAt: now,
      status: 'active',
      migrationSource: null,
      migrationPending: false
    }
    registry.workspaces.push(record)
    this.writeRegistry(registry)
    return record
  }

  setActive(workspaceId: string): WorkspaceRecord {
    const registry = this.readRegistry()
    const workspace = registry.workspaces.find((item) => item.id === workspaceId)
    if (!workspace) throw new Error('账号工作区不存在')
    workspace.lastUsedAt = new Date().toISOString()
    registry.activeWorkspaceId = workspace.id
    this.writeRegistry(registry)
    return workspace
  }

  /**
   * Copy the legacy database into a verified account workspace, never moving or
   * deleting the original and never replacing an existing target.
   *
   * This is an explicit migration operation, not a startup shortcut. Last-login
   * UID in the legacy database is not sufficient evidence to claim every row in
   * a shared historical database, so startup never calls this automatically.
   */
  migrateLegacyForVerifiedAccount(
    account: WorkspaceAccount,
    legacyPath: string,
    beforePublish?: (temporaryPath: string) => void
  ): WorkspaceRecord {
    const workspace = this.ensureWorkspaceForAccount(account)
    if (existsSync(workspace.filePath)) {
      throw new Error('目标工作区已存在，禁止自动覆盖或删除已有数据')
    }
    const source = verifySqliteDatabase(legacyPath)
    const temporary = `${workspace.filePath}.migrating-${randomUUID()}`
    mkdirSync(dirname(workspace.filePath), { recursive: true })
    try {
      backupSqliteDatabase(legacyPath, temporary)
      const copied = verifySqliteDatabase(temporary)
      for (const table of MIGRATION_TABLES) {
        if ((source.tables[table] ?? null) !== (copied.tables[table] ?? null)) {
          throw new Error(`历史数据库迁移校验失败：表 ${table} 计数不一致`)
        }
      }
      beforePublish?.(temporary)
      publishMigrationFile(temporary, workspace.filePath)
    } catch (error) {
      // Only the temporary copy is removed. The source and any target database
      // remain untouched.
      rmSync(temporary, { force: true })
      rmSync(`${temporary}-wal`, { force: true })
      rmSync(`${temporary}-shm`, { force: true })
      throw error
    }
    const registry = this.readRegistry()
    const stored = registry.workspaces.find((item) => item.id === workspace.id)
    if (stored) {
      stored.migrationSource = legacyPath
      stored.migrationPending = false
      stored.status = 'active'
      stored.lastUsedAt = new Date().toISOString()
      this.writeRegistry(registry)
    }
    return stored ?? workspace
  }

  /** Preserve an unattributed legacy database as a read-only historical workspace copy. */
  createLegacyReadonlyWorkspace(legacyPath: string): WorkspaceRecord {
    const id = `legacy-${createHash('sha256')
      .update(`legacy:${resolve(legacyPath)}`)
      .digest('hex')
      .slice(0, 16)}`
    const registry = this.readRegistry()
    const existing = registry.workspaces.find((item) => item.id === id)
    if (existing) return existing
    const destination = join(this.workspacesDir, `${id}.sqlite`)
    if (!existsSync(destination)) backupSqliteDatabase(legacyPath, destination)
    const verified = verifySqliteDatabase(destination)
    if (verified.integrity !== 'ok')
      throw new Error(`历史数据库备份校验失败：${verified.integrity}`)
    const now = new Date().toISOString()
    const record: WorkspaceRecord = {
      id,
      accountId: 'legacy-readonly',
      platformUid: '',
      displayName: '历史数据（只读）',
      school: null,
      filePath: destination,
      createdAt: now,
      lastUsedAt: now,
      status: 'readonly',
      migrationSource: legacyPath
    }
    registry.workspaces.push(record)
    this.writeRegistry(registry)
    return record
  }

  /**
   * Local workspace for a fresh install. It must never reuse a pre-existing
   * legacy database path: a database with unknown ownership is handled as a
   * read-only historical copy elsewhere.
   */
  ensureLocalWorkspace(): WorkspaceRecord {
    const id = 'local-default'
    const registry = this.readRegistry()
    const existing = registry.workspaces.find((item) => item.id === id)
    const localPath = join(this.workspacesDir, 'local.sqlite')
    if (existing) {
      if (resolve(existing.filePath) !== resolve(localPath)) {
        existing.filePath = localPath
        existing.migrationSource = null
        existing.status = 'active'
        this.writeRegistry(registry)
      }
      this.setActive(existing.id)
      return existing
    }
    const now = new Date().toISOString()
    const record: WorkspaceRecord = {
      id,
      accountId: 'local',
      platformUid: '',
      displayName: '本机工作区',
      school: null,
      filePath: localPath,
      createdAt: now,
      lastUsedAt: now,
      status: 'active',
      migrationSource: null,
      migrationPending: false
    }
    registry.workspaces.push(record)
    registry.activeWorkspaceId = id
    this.writeRegistry(registry)
    return record
  }

  /** Record the target of a controlled account switch before the app restarts. */
  beginAccountSwitch(account: WorkspaceAccount): WorkspaceRecord {
    const workspace = this.ensureWorkspaceForAccount(account)
    const registry = this.readRegistry()
    const stored = registry.workspaces.find((item) => item.id === workspace.id)
    if (!stored) throw new Error('目标账号工作区不存在')
    registry.pendingSwitch = {
      accountId: account.id,
      workspaceId: stored.id,
      platformUid: account.platformUid,
      requestedAt: new Date().toISOString()
    }
    this.writeRegistry(registry)
    return stored
  }

  getPendingSwitch(): PendingAccountSwitch | null {
    return this.readRegistry().pendingSwitch
  }

  clearPendingSwitch(): void {
    const registry = this.readRegistry()
    if (!registry.pendingSwitch) return
    registry.pendingSwitch = null
    this.writeRegistry(registry)
  }

  /**
   * Resolve the startup workspace. A verified active account always uses its
   * own workspace; an existing database with unknown ownership is read-only.
   */
  resolveStartupWorkspace(
    activeAccount: WorkspaceAccount | null,
    options: { legacyPath?: string; fallbackWorkspaceId?: string } = {}
  ): WorkspaceRecord {
    const registry = this.readRegistry()
    const pending = registry.pendingSwitch
    if (pending) {
      if (
        !activeAccount ||
        activeAccount.id !== pending.accountId ||
        activeAccount.platformUid !== pending.platformUid
      ) {
        throw new Error('待切换账号的身份与当前登录身份不一致，已阻止加载目标数据库')
      }
      const workspace = registry.workspaces.find((item) => item.id === pending.workspaceId)
      if (
        !workspace ||
        workspace.status !== 'active' ||
        workspace.accountId !== pending.accountId ||
        workspace.platformUid !== pending.platformUid
      ) {
        throw new Error('待切换账号的工作区校验失败，已阻止加载')
      }
      this.setActive(workspace.id)
      return workspace
    }
    if (activeAccount?.platformUid) {
      const existing = this.findForPlatformUid(activeAccount.platformUid)
      if (existing) {
        if (
          existing.status !== 'active' ||
          existing.accountId !== activeAccount.id ||
          existing.platformUid !== activeAccount.platformUid
        ) {
          throw new Error('账号身份与数据库工作区不匹配，已阻止加载可写数据库')
        }
        this.setActive(existing.id)
        return existing
      }
      // Never claim or auto-migrate the legacy database from a last-login UID.
      // Preserve it separately as read-only history and start a fresh account
      // workspace. An explicit migration decision must be made outside startup.
      if (options.legacyPath && existsSync(options.legacyPath)) {
        this.createLegacyReadonlyWorkspace(options.legacyPath)
      }
      const accountWorkspace = this.ensureWorkspaceForAccount(activeAccount)
      this.setActive(accountWorkspace.id)
      return accountWorkspace
    }
    if (options.fallbackWorkspaceId) {
      const fallback = this.readRegistry().workspaces.find(
        (item) => item.id === options.fallbackWorkspaceId
      )
      if (fallback && fallback.status === 'active') {
        this.setActive(fallback.id)
        return fallback
      }
    }
    if (options.legacyPath && existsSync(options.legacyPath)) {
      // Any pre-existing database without a verified active account is
      // preserved read-only. It is never used as a writable local workspace.
      const readonly = this.createLegacyReadonlyWorkspace(options.legacyPath)
      this.setActive(readonly.id)
      return readonly
    }
    return this.ensureLocalWorkspace()
  }
}

/** Read the last verified session UID from legacy app_meta. */
export function readLegacySessionUid(legacyPath: string): string | null {
  if (!existsSync(legacyPath)) return null
  const db = new DatabaseSync(legacyPath, { readOnly: true })
  try {
    const row = db
      .prepare("SELECT value FROM app_meta WHERE key = 'chaoxing_session_status'")
      .get() as { value?: string } | undefined
    if (!row?.value) return null
    const parsed = JSON.parse(row.value) as { studentId?: unknown }
    return typeof parsed.studentId === 'string' && /^\d{1,20}$/.test(parsed.studentId)
      ? parsed.studentId
      : null
  } catch {
    return null
  } finally {
    db.close()
  }
}

/** Copy a database file for tests without touching the source. */
export function copySqliteForTest(sourcePath: string, destinationPath: string): void {
  mkdirSync(dirname(destinationPath), { recursive: true })
  copyFileSync(sourcePath, destinationPath)
}
