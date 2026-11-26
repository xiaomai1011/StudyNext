import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hostname, userInfo } from 'node:os'
import type { SystemReminderStatus } from '@shared/types'

const STATE_FILE = 'notification-system.json'
const TASK_DESCRIPTION = 'StudyNext Windows DDL reminder. Safe to remove.'
const POWERSHELL_TIMEOUT_MS = 20_000

export interface PowerShellResult {
  stdout: string
  stderr: string
}

export interface PowerShellExecutor {
  run(script: string): Promise<PowerShellResult>
}

interface StoredSystemReminderState {
  version: 1
  taskName?: string
  executablePath?: string
  scheduledFor?: string | null
  registered?: boolean
  nextRunAt?: string | null
  lastCheckAt?: string | null
  lastDeliveryAt?: string | null
  lastDeliveryError?: string | null
  lastScheduleError?: string | null
}

interface TaskQuery {
  exists: boolean
  execute?: string
  arguments?: string
  principalUserId?: string
  principalSid?: string
  nextRunAt?: string | null
  lastRunAt?: string | null
  lastTaskResult?: number | null
}

export interface SystemReminderServiceOptions {
  dataDir: string
  executablePath: string
  taskName?: string
  sid?: string | null
  legacyTaskNames?: string[]
  platform?: NodeJS.Platform
  packaged?: boolean
  executor?: PowerShellExecutor
  now?: () => Date
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function sanitizeTaskPart(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export function buildSystemReminderTaskName(sid: string, machineName = hostname()): string {
  // Keep a readable installation prefix, but derive the unique part from the
  // Windows user SID. A hash avoids illegal characters and long SID strings in
  // the Task Scheduler name.
  const host = sanitizeTaskPart(machineName) || 'local'
  const digest = createHash('sha256').update(sid, 'utf8').digest('hex').slice(0, 12)
  return `StudyNext-DDL-${host}-${digest}`
}

export function buildLegacySystemReminderTaskName(
  username = userInfo().username,
  domain = process.env.USERDOMAIN ?? 'local'
): string {
  // The pre-R03 name. Retained only for safe migration/cleanup.
  const user = sanitizeTaskPart(username) || 'user'
  const host = sanitizeTaskPart(domain) || 'local'
  return `StudyNext-DDL-${host}-${user}`
}

export function readCurrentUserSid(): string | null {
  if (process.platform !== 'win32') return null
  try {
    const output = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000
    })
    const match = output.match(/"(S-\d-(?:\d+-)+\d+)"/i)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

function currentPrincipalName(): string {
  return `${process.env.USERDOMAIN ?? 'local'}\\${userInfo().username}`
}

function normalizePrincipal(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

export function buildRegisterTaskScript(input: {
  taskName: string
  executablePath: string
  runAt: string
  principalUserId?: string
}): string {
  const taskName = quotePowerShell(input.taskName)
  const executable = quotePowerShell(input.executablePath)
  const runAt = quotePowerShell(input.runAt)
  const principalUserId = quotePowerShell(input.principalUserId ?? currentPrincipalName())
  return [
    "$ErrorActionPreference='Stop'",
    '$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    `$taskName=${taskName}`,
    `$exe=${executable}`,
    `$runAt=([DateTimeOffset]::Parse(${runAt})).LocalDateTime`,
    `$principalUserId=${principalUserId}`,
    "$action=New-ScheduledTaskAction -Execute $exe -Argument '--check-reminders'",
    '$trigger=New-ScheduledTaskTrigger -Once -At $runAt',
    '$settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)',
    '$principal=New-ScheduledTaskPrincipal -UserId $principalUserId -LogonType Interactive -RunLevel Limited',
    `Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description ${quotePowerShell(TASK_DESCRIPTION)} -Force | Out-Null`,
    '$task=Get-ScheduledTask -TaskName $taskName',
    '$info=Get-ScheduledTaskInfo -TaskName $taskName',
    '$principalSid=$null',
    'try{$principalSid=(New-Object System.Security.Principal.NTAccount([string]$task.Principal.UserId)).Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{}',
    "$payload=[ordered]@{exists=$true;execute=[string]$task.Actions[0].Execute;arguments=[string]$task.Actions[0].Arguments;principalUserId=[string]$task.Principal.UserId;principalSid=[string]$principalSid;nextRunAt=if($info.NextRunTime -and $info.NextRunTime.Year -gt 1900){$info.NextRunTime.ToString('o')}else{$null};lastRunAt=if($info.LastRunTime -and $info.LastRunTime.Year -gt 1900){$info.LastRunTime.ToString('o')}else{$null};lastTaskResult=[int]$info.LastTaskResult}",
    '$payload | ConvertTo-Json -Compress'
  ].join('\n')
}

export function buildQueryTaskScript(taskName: string): string {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    '$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    `$taskName=${quotePowerShell(taskName)}`,
    '$task=Get-ScheduledTask -TaskName $taskName',
    'if(-not $task){[ordered]@{exists=$false}|ConvertTo-Json -Compress; exit 0}',
    '$info=Get-ScheduledTaskInfo -TaskName $taskName',
    '$principalSid=$null',
    'try{$principalSid=(New-Object System.Security.Principal.NTAccount([string]$task.Principal.UserId)).Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{}',
    "$payload=[ordered]@{exists=$true;execute=[string]$task.Actions[0].Execute;arguments=[string]$task.Actions[0].Arguments;principalUserId=[string]$task.Principal.UserId;principalSid=[string]$principalSid;nextRunAt=if($info.NextRunTime -and $info.NextRunTime.Year -gt 1900){$info.NextRunTime.ToString('o')}else{$null};lastRunAt=if($info.LastRunTime -and $info.LastRunTime.Year -gt 1900){$info.LastRunTime.ToString('o')}else{$null};lastTaskResult=[int]$info.LastTaskResult}",
    '$payload | ConvertTo-Json -Compress'
  ].join('\n')
}

export function buildRemoveTaskScript(taskName: string): string {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    '$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    `$taskName=${quotePowerShell(taskName)}`,
    'Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue',
    '[ordered]@{removed=$true}|ConvertTo-Json -Compress'
  ].join('\n')
}

export function parseTaskQuery(stdout: string): TaskQuery {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
  if (!line) return { exists: false }
  const parsed = JSON.parse(line) as Partial<TaskQuery>
  return {
    exists: parsed.exists === true,
    ...(typeof parsed.execute === 'string' ? { execute: parsed.execute } : {}),
    ...(typeof parsed.arguments === 'string' ? { arguments: parsed.arguments } : {}),
    ...(typeof parsed.principalUserId === 'string'
      ? { principalUserId: parsed.principalUserId }
      : {}),
    ...(typeof parsed.principalSid === 'string' && parsed.principalSid
      ? { principalSid: parsed.principalSid }
      : {}),
    ...(typeof parsed.nextRunAt === 'string' ? { nextRunAt: parsed.nextRunAt } : {}),
    ...(typeof parsed.lastRunAt === 'string' ? { lastRunAt: parsed.lastRunAt } : {}),
    ...(typeof parsed.lastTaskResult === 'number' ? { lastTaskResult: parsed.lastTaskResult } : {})
  }
}

function normalizePath(value: string | undefined): string {
  return (value ?? '').replace(/\//g, '\\').toLowerCase()
}

function defaultExecutor(script: string): Promise<PowerShellResult> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encoded
      ],
      {
        windowsHide: true,
        timeout: POWERSHELL_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message))
          return
        }
        resolve({ stdout, stderr })
      }
    )
  })
}

export class SystemReminderService {
  private readonly dataDir: string
  private readonly executablePath: string
  private readonly taskName: string
  private readonly sid: string | null
  private readonly principalUserId: string
  private readonly identityBlocked: boolean
  private readonly legacyTaskNames: string[]
  private readonly supported: boolean
  private readonly executor: PowerShellExecutor
  private readonly now: () => Date
  private state: StoredSystemReminderState
  private queue: Promise<void> = Promise.resolve()
  private lastQuery: TaskQuery = { exists: false }
  private needsRepair = false

  constructor(options: SystemReminderServiceOptions) {
    const platform = options.platform ?? process.platform
    this.dataDir = options.dataDir
    this.executablePath = options.executablePath
    const sid = options.sid !== undefined ? options.sid : readCurrentUserSid()
    this.taskName =
      options.taskName ??
      (sid ? buildSystemReminderTaskName(sid) : buildLegacySystemReminderTaskName())
    this.principalUserId = sid ?? currentPrincipalName()
    this.sid = sid
    this.identityBlocked = !sid && !options.taskName
    this.supported = platform === 'win32' && options.packaged === true
    this.executor = options.executor ?? { run: defaultExecutor }
    this.now = options.now ?? (() => new Date())
    this.state = this.readState()
    const legacy = new Set(options.legacyTaskNames ?? [])
    legacy.add(buildLegacySystemReminderTaskName())
    if (this.state.taskName && this.state.taskName !== this.taskName) {
      legacy.add(this.state.taskName)
    }
    legacy.delete(this.taskName)
    this.legacyTaskNames = [...legacy].filter(Boolean)
    if (!sid && !options.taskName) {
      this.state.lastScheduleError = '无法读取当前 Windows 用户 SID，已阻止注册系统级提醒'
    }
  }

  getStatus(): SystemReminderStatus {
    const registered = this.state.registered === true
    return {
      supported: this.supported,
      taskName: this.supported ? this.taskName : null,
      registered,
      executablePath: this.state.executablePath ?? null,
      nextRunAt: this.state.nextRunAt ?? null,
      lastCheckAt: this.state.lastCheckAt ?? null,
      lastDeliveryAt: this.state.lastDeliveryAt ?? null,
      lastDeliveryError: this.state.lastDeliveryError ?? null,
      lastScheduleError: this.state.lastScheduleError ?? null,
      lastError: this.state.lastScheduleError ?? this.state.lastDeliveryError ?? null,
      needsReregister: this.supported && this.needsRepair
    }
  }

  recordCheck(input: { at?: string; delivered?: number; error?: string | null }): void {
    this.state.lastCheckAt = input.at ?? this.now().toISOString()
    if (input.delivered && input.delivered > 0) {
      this.state.lastDeliveryAt = this.state.lastCheckAt
    }
    // Delivery errors and Task Scheduler errors have different lifetimes:
    // registering the next trigger must never erase a failed notification.
    this.state.lastDeliveryError = input.error ?? null
    this.writeState()
  }

  async refreshStatus(): Promise<SystemReminderStatus> {
    if (!this.supported) return this.getStatus()
    const wasRegistered = this.state.registered === true
    try {
      const query = await this.queryTask()
      this.lastQuery = query
      this.state.registered = query.exists
      this.state.nextRunAt = query.nextRunAt ?? null
      if (query.execute) this.state.executablePath = query.execute
      this.state.lastScheduleError = null
      this.needsRepair =
        wasRegistered &&
        (!query.exists || normalizePath(query.execute) !== normalizePath(this.executablePath))
    } catch (error) {
      this.state.lastScheduleError = error instanceof Error ? error.message : String(error)
    }
    this.writeState()
    return this.getStatus()
  }

  async initialize(): Promise<SystemReminderStatus> {
    if (!this.supported) return this.getStatus()
    await this.removeLegacyTasks()
    await this.refreshStatus()
    return this.getStatus()
  }

  /**
   * Keep exactly one one-shot Windows task positioned at the next reminder.
   * A null nextRunAt (or disabled reminders) removes the task.
   */
  syncNextTrigger(input: {
    enabled: boolean
    nextRunAt: string | null
  }): Promise<SystemReminderStatus> {
    if (!this.supported) return Promise.resolve(this.getStatus())
    if (this.identityBlocked) return Promise.resolve(this.getStatus())
    const run = async (): Promise<void> => {
      if (!input.enabled || !input.nextRunAt) {
        await this.removeTask()
        return
      }
      const nextMs = Date.parse(input.nextRunAt)
      if (!Number.isFinite(nextMs)) {
        throw new Error('下一条提醒时间无效')
      }
      const runAtMs = Math.max(nextMs + 2_000, this.now().getTime() + 2_000)
      const runAt = new Date(runAtMs).toISOString()
      const current = await this.queryTask()
      this.lastQuery = current
      if (current.exists && !this.isOwnedTask(current)) {
        throw new Error('计划任务名称已被其他任务占用，已停止覆盖')
      }
      if (current.exists && current.nextRunAt) {
        const currentMs = Date.parse(current.nextRunAt)
        if (Number.isFinite(currentMs) && Math.abs(currentMs - runAtMs) < 2_000) {
          this.state.registered = true
          this.state.executablePath = current.execute ?? this.executablePath
          this.state.nextRunAt = current.nextRunAt
          this.state.scheduledFor = runAt
          this.state.lastScheduleError = null
          this.writeState()
          return
        }
      }
      await this.registerTask(runAt)
    }
    const result = this.queue.then(run)
    this.queue = result.catch(() => undefined)
    return result.then(() => this.getStatus())
  }

  async repair(input: {
    enabled: boolean
    nextRunAt: string | null
  }): Promise<SystemReminderStatus> {
    if (!this.supported) return this.getStatus()
    await this.removeAllOwnedTasks()
    return this.syncNextTrigger(input)
  }

  async removeAllOwnedTasks(): Promise<void> {
    if (!this.supported) return
    await this.removeLegacyTasks()
    await this.removeTask()
  }

  private async registerTask(runAt: string): Promise<void> {
    if (this.identityBlocked) {
      throw new Error('无法读取当前 Windows 用户 SID，已阻止注册系统级提醒')
    }
    try {
      const result = await this.executor.run(
        buildRegisterTaskScript({
          taskName: this.taskName,
          executablePath: this.executablePath,
          runAt,
          principalUserId: this.principalUserId
        })
      )
      const query = parseTaskQuery(result.stdout)
      if (!query.exists) throw new Error('任务计划注册后未找到任务')
      this.lastQuery = query
      this.state.registered = true
      this.state.executablePath = query.execute ?? this.executablePath
      this.state.nextRunAt = query.nextRunAt ?? runAt
      this.state.scheduledFor = runAt
      this.state.lastScheduleError = null
      this.needsRepair = false
    } catch (error) {
      this.state.lastScheduleError = error instanceof Error ? error.message : String(error)
      this.state.registered = false
      throw error
    } finally {
      this.writeState()
    }
  }

  private async removeTask(): Promise<void> {
    try {
      const current = await this.queryTask()
      this.lastQuery = current
      if (current.exists) {
        if (!this.isOwnedTask(current)) {
          throw new Error('当前计划任务不属于此 StudyNext 安装，已拒绝删除')
        }
        await this.executor.run(buildRemoveTaskScript(this.taskName))
      }
      this.state.registered = false
      this.state.nextRunAt = null
      this.state.scheduledFor = null
      this.state.lastScheduleError = null
      this.needsRepair = false
    } catch (error) {
      this.state.lastScheduleError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.writeState()
    }
  }

  private async removeLegacyTasks(): Promise<void> {
    for (const name of this.legacyTaskNames) {
      try {
        const query = await this.queryTask(name)
        if (!query.exists) continue
        // Legacy names are predictable. Never delete one unless its action is
        // this executable and its principal is the current Windows user.
        if (!this.isOwnedTask(query, true)) {
          this.state.lastScheduleError = `旧计划任务 ${name} 不属于当前用户或安装，已保留`
          continue
        }
        await this.executor.run(buildRemoveTaskScript(name))
      } catch (error) {
        this.state.lastScheduleError = error instanceof Error ? error.message : String(error)
      }
    }
    this.writeState()
  }

  private isOwnedTask(query: TaskQuery, requirePrincipal = false): boolean {
    if (!query.exists) return false
    if (normalizePath(query.execute) !== normalizePath(this.executablePath)) {
      return false
    }
    if (!(query.arguments ?? '').includes('--check-reminders')) return false
    if (!query.principalUserId && !query.principalSid) return !requirePrincipal
    // Task Scheduler resolves a SID principal back to an account name when the
    // task is queried. Translate that name to a SID (done by the query script)
    // so ownership is still checked against the exact current user, not a
    // same-named account in another domain.
    const querySid = query.principalSid?.trim().toLowerCase()
    if (this.sid && querySid) return querySid === this.sid.trim().toLowerCase()
    const principal = normalizePrincipal(query.principalUserId)
    return (
      principal === normalizePrincipal(this.principalUserId) ||
      // Tasks created by the pre-SID implementation have a readable
      // DOMAIN\user principal. Accept it only for migration/cleanup.
      principal === normalizePrincipal(currentPrincipalName())
    )
  }

  private async queryTask(name = this.taskName): Promise<TaskQuery> {
    const result = await this.executor.run(buildQueryTaskScript(name))
    return parseTaskQuery(result.stdout)
  }

  private get statePath(): string {
    return join(this.dataDir, STATE_FILE)
  }

  private readState(): StoredSystemReminderState {
    if (!existsSync(this.statePath)) return { version: 1 }
    try {
      const parsed = JSON.parse(
        readFileSync(this.statePath, 'utf8')
      ) as Partial<StoredSystemReminderState> & { lastError?: string | null }
      return {
        version: 1,
        ...(typeof parsed.taskName === 'string' ? { taskName: parsed.taskName } : {}),
        ...(typeof parsed.executablePath === 'string'
          ? { executablePath: parsed.executablePath }
          : {}),
        ...(typeof parsed.scheduledFor === 'string' || parsed.scheduledFor === null
          ? { scheduledFor: parsed.scheduledFor }
          : {}),
        ...(typeof parsed.registered === 'boolean' ? { registered: parsed.registered } : {}),
        ...(typeof parsed.nextRunAt === 'string' || parsed.nextRunAt === null
          ? { nextRunAt: parsed.nextRunAt }
          : {}),
        ...(typeof parsed.lastCheckAt === 'string' || parsed.lastCheckAt === null
          ? { lastCheckAt: parsed.lastCheckAt }
          : {}),
        ...(typeof parsed.lastDeliveryAt === 'string' || parsed.lastDeliveryAt === null
          ? { lastDeliveryAt: parsed.lastDeliveryAt }
          : {}),
        ...(typeof parsed.lastDeliveryError === 'string' || parsed.lastDeliveryError === null
          ? { lastDeliveryError: parsed.lastDeliveryError }
          : {}),
        ...(typeof parsed.lastScheduleError === 'string' || parsed.lastScheduleError === null
          ? { lastScheduleError: parsed.lastScheduleError }
          : {}),
        // v0.5.0 stored one `lastError` field for both delivery and scheduler
        // failures. Migrate it to the scheduler slot; a real delivery failure
        // will be re-read from the durable queue on the next check.
        ...(!('lastScheduleError' in parsed) &&
        (typeof parsed.lastError === 'string' || parsed.lastError === null)
          ? { lastScheduleError: parsed.lastError }
          : {})
      }
    } catch {
      return { version: 1 }
    }
  }

  private writeState(): void {
    mkdirSync(dirname(this.statePath), { recursive: true })
    const temporary = `${this.statePath}.tmp`
    writeFileSync(temporary, JSON.stringify(this.state, null, 2), 'utf8')
    renameSync(temporary, this.statePath)
  }
}
