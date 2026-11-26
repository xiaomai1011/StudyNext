import { execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'

const ROOT = process.cwd()
const CLOSE_TIMEOUT_MS = 5_000
const EXIT_POLL_MS = 50

interface LaunchElectronOptions {
  onLaunched?: (app: ElectronApplication) => void
  afterWindowReady?: (page: Page) => Promise<void>
}

interface CloseElectronOptions {
  closeTimeoutMs?: number
}

interface IsolatedCrossSemesterOptions {
  includeExams?: boolean
  onDataDirCreated?: (dataDir: string) => void
  onAppLaunched?: (attempt: 1 | 2, app: ElectronApplication) => void
  removeTempDir?: (dataDir: string) => Promise<Error | null>
  injectFailure?: {
    stage: 'first_launch_ready' | 'second_launch_ready'
    error: unknown
  }
}

interface ProcessOwnershipResult {
  verified: boolean
  reason?: string
}

const cleanupDiagnosticsByError = new WeakMap<object, Error[]>()

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`等待数据库超时：${path}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

function isChildProcessExited(proc: ChildProcess | null | undefined): boolean {
  return Boolean(proc && (proc.exitCode !== null || proc.signalCode !== null))
}

function normalizePathForCompare(targetPath: string): string {
  const resolved = resolve(targetPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function extractUserDataDirFromCommandLine(commandLine: string): string | null {
  const quotedWholeArg = /"--user-data-dir=([^"]+)"/i.exec(commandLine)
  if (quotedWholeArg?.[1]) return quotedWholeArg[1]

  const quotedValue = /(?:^|\s)--user-data-dir="([^"]+)"/i.exec(commandLine)
  if (quotedValue?.[1]) return quotedValue[1]

  const bareValue = /(?:^|\s)--user-data-dir=([^"\s]+)/i.exec(commandLine)
  return bareValue?.[1] ?? null
}

function extractUserDataDirFromArgs(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!
    const lower = token.toLowerCase()
    if (lower.startsWith('--user-data-dir=')) {
      return token.slice('--user-data-dir='.length)
    }
    if (lower === '--user-data-dir' && i + 1 < args.length) {
      return args[i + 1]!
    }
    const embedded = extractUserDataDirFromCommandLine(token)
    if (embedded) return embedded
  }
  return null
}

function verifyOwnedElectronProcess(
  proc: ChildProcess | null | undefined,
  expectedDataDir?: string
): ProcessOwnershipResult {
  if (!proc) return { verified: false, reason: '缺少 ChildProcess 句柄' }
  if (isChildProcessExited(proc)) return { verified: false, reason: '进程句柄已退出' }

  const pid = proc.pid
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return { verified: false, reason: '无效 PID' }
  }
  if (!expectedDataDir) {
    return { verified: false, reason: '缺少目标数据目录用于归属校验' }
  }

  const expectedNormalized = normalizePathForCompare(expectedDataDir)
  const spawnArgs = Array.isArray(proc.spawnargs) ? proc.spawnargs : []
  if (spawnArgs.length > 0) {
    const spawnDataDir = extractUserDataDirFromArgs(spawnArgs)
    if (!spawnDataDir || normalizePathForCompare(spawnDataDir) !== expectedNormalized) {
      return { verified: false, reason: 'ChildProcess 启动参数中的 user-data-dir 与目标目录不一致' }
    }
  }

  if (process.platform === 'win32') {
    try {
      const raw = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { "$($p.ParentProcessId)|$($p.Name)|$($p.CommandLine)" }`
        ],
        { encoding: 'utf8', timeout: 8_000 }
      ).trim()
      if (!raw) return { verified: false, reason: `未查询到 PID ${pid} 对应活动进程` }

      const firstSep = raw.indexOf('|')
      const secondSep = firstSep >= 0 ? raw.indexOf('|', firstSep + 1) : -1
      if (firstSep < 0 || secondSep < 0) {
        return { verified: false, reason: '进程信息解析失败' }
      }
      const parentPid = Number.parseInt(raw.slice(0, firstSep), 10)
      const procName = raw.slice(firstSep + 1, secondSep)
      const commandLine = raw.slice(secondSep + 1)

      if (parentPid !== process.pid) {
        return {
          verified: false,
          reason: `父进程 PID 不匹配（期望 ${process.pid}，实际 ${parentPid}）`
        }
      }
      const lowerName = procName.toLowerCase()
      const isElectronLauncher =
        lowerName.includes('electron') ||
        (lowerName === 'cmd.exe' && /electron\.exe/i.test(commandLine))
      if (!isElectronLauncher) {
        return { verified: false, reason: `进程非 Electron 启动链（实际 ${procName}）` }
      }
      const cmdDataDir = extractUserDataDirFromCommandLine(commandLine)
      if (!cmdDataDir || normalizePathForCompare(cmdDataDir) !== expectedNormalized) {
        return { verified: false, reason: '进程命令行中的 user-data-dir 与目标目录不精确匹配' }
      }
    } catch (error) {
      return { verified: false, reason: `进程归属查询失败：${toError(error).message}` }
    }
  }

  // Re-check ChildProcess handle right before confirming to prevent PID reuse window.
  if (isChildProcessExited(proc)) {
    return { verified: false, reason: '归属校验期间进程已退出' }
  }
  return { verified: true }
}

async function waitForChildProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (isChildProcessExited(proc)) return true

  const deadline = Date.now() + timeoutMs
  return await new Promise<boolean>((resolveExit) => {
    let settled = false
    const finish = (exited: boolean): void => {
      if (settled) return
      settled = true
      clearInterval(timer)
      proc.off('exit', onExit)
      proc.off('close', onExit)
      resolveExit(exited)
    }
    const onExit = (): void => {
      if (isChildProcessExited(proc)) finish(true)
    }
    proc.once('exit', onExit)
    proc.once('close', onExit)
    const timer = setInterval(() => {
      if (isChildProcessExited(proc)) {
        finish(true)
      } else if (Date.now() >= deadline) {
        finish(false)
      }
    }, EXIT_POLL_MS)
  })
}

function forceTerminateVerifiedProcess(proc: ChildProcess): void {
  if (isChildProcessExited(proc)) return
  const pid = proc.pid
  if (process.platform === 'win32' && typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: CLOSE_TIMEOUT_MS
      })
      return
    } catch {
      // Fall back to ChildProcess handle kill if taskkill fails.
    }
  }
  proc.kill('SIGKILL')
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function recordCleanupDiagnostics(primaryError: unknown, cleanupErrors: Error[]): void {
  if (cleanupErrors.length === 0) return
  const summary = cleanupErrors.map((err) => err.message).join('；')
  console.warn(`[today-schedule.spec] 清理阶段附加诊断：${summary}`)
  if (primaryError !== null && typeof primaryError === 'object') {
    const existing = cleanupDiagnosticsByError.get(primaryError) ?? []
    cleanupDiagnosticsByError.set(primaryError, [...existing, ...cleanupErrors])
  }
}

function getCleanupDiagnostics(primaryError: unknown): readonly Error[] {
  if (primaryError !== null && typeof primaryError === 'object') {
    return cleanupDiagnosticsByError.get(primaryError) ?? []
  }
  return []
}

async function closeElectronSafely(
  launchedApp: Pick<ElectronApplication, 'close' | 'process'>,
  dataDir?: string,
  options?: CloseElectronOptions
): Promise<Error | null> {
  const closeTimeoutMs = options?.closeTimeoutMs ?? CLOSE_TIMEOUT_MS
  let proc: ChildProcess | null = null
  try {
    proc = launchedApp.process()
  } catch {
    proc = null
  }
  const pid = proc?.pid
  let closeError: Error | null = null

  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        launchedApp.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`关闭 Electron 超时（${closeTimeoutMs}ms）`)),
            closeTimeoutMs
          )
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch (error) {
    closeError = toError(error)
  }

  if (!proc) {
    return closeError
  }

  let exited = await waitForChildProcessExit(proc, closeTimeoutMs)
  if (!exited) {
    const ownership = verifyOwnedElectronProcess(proc, dataDir)
    if (!ownership.verified) {
      if (isChildProcessExited(proc)) return closeError
      return new Error(
        `无法确认 Electron 进程归属（PID ${pid ?? 'unknown'}，${ownership.reason ?? '未知原因'}），已跳过强制终止`
      )
    }
    if (!closeError) {
      closeError = new Error(
        `Electron 进程（PID ${pid ?? 'unknown'}）未在限定时间内退出，已执行归属核验并强制终止`
      )
    }
    forceTerminateVerifiedProcess(proc)
    exited = await waitForChildProcessExit(proc, CLOSE_TIMEOUT_MS)
    if (!exited) {
      return new Error(`强制终止后 Electron 进程（PID ${pid ?? 'unknown'}）仍未退出`)
    }
  }

  return closeError
}

async function removeTempDirSafely(dataDir: string): Promise<Error | null> {
  const maxAttempts = 12
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      rmSync(dataDir, { recursive: true, force: true })
      return null
    } catch (error) {
      lastError = toError(error)
      const code = (error as NodeJS.ErrnoException)?.code
      const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY'
      if (!retryable || attempt === maxAttempts) {
        return lastError
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150))
    }
  }
  return lastError
}

async function launchElectron(
  dataDir: string,
  options?: LaunchElectronOptions
): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
  env.STUDYNEXT_DATA_DIR = dataDir
  delete env.ELECTRON_RUN_AS_NODE
  const launchedApp = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${dataDir}`],
    cwd: ROOT,
    env
  })
  try {
    options?.onLaunched?.(launchedApp)
    const launchedPage = await launchedApp.firstWindow()
    await launchedPage.waitForLoadState('domcontentloaded')
    await expect(launchedPage.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })
    if (options?.afterWindowReady) {
      await options.afterWindowReady(launchedPage)
    }
    return { app: launchedApp, page: launchedPage }
  } catch (primaryError) {
    const closeErr = await closeElectronSafely(launchedApp, dataDir)
    if (closeErr) {
      recordCleanupDiagnostics(primaryError, [closeErr])
    }
    throw primaryError
  }
}

async function installControllableClock(targetPage: Page, startIso: string): Promise<void> {
  await targetPage.addInitScript(
    ({ iso }) => {
      const RealDate = Date
      const startMs = RealDate.parse(iso)
      let offset = startMs - RealDate.now()
      const FakeDate = function (...args: unknown[]) {
        return args.length > 0
          ? (Reflect.construct(RealDate, args) as Date)
          : new RealDate(RealDate.now() + offset)
      } as unknown as DateConstructor
      FakeDate.now = () => RealDate.now() + offset
      FakeDate.parse = RealDate.parse
      FakeDate.UTC = RealDate.UTC
      ;(FakeDate as unknown as { prototype: Date }).prototype = RealDate.prototype
      Object.setPrototypeOf(FakeDate, RealDate)
      window.Date = FakeDate
      ;(window as Window & { __n8Advance?: (ms: number) => void }).__n8Advance = (ms) => {
        offset += ms
      }
      const realSetInterval = window.setInterval.bind(window)
      window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
        realSetInterval(
          handler,
          timeout === 60_000 ? 60 : timeout,
          ...args
        )) as typeof window.setInterval
    },
    { iso: startIso }
  )
}

function seedCrossSemesterFixture(dbPath: string, options?: { includeExams?: boolean }): void {
  const db = new DatabaseSync(dbPath)
  try {
    const courses = db.prepare('SELECT id FROM courses ORDER BY id ASC LIMIT 2').all() as Array<{
      id: string
    }>
    if (courses.length < 2) throw new Error('N-008 跨学期测试缺少两门课程记录')
    const fallId = courses[0]!.id
    const springId = courses[1]!.id

    // Reset courses to cleanly test 2026秋 (2026-09-07, 18 weeks) -> 2027春 (2027-01-11, 18 weeks)
    db.prepare('DELETE FROM courses WHERE id NOT IN (?, ?)').run(fallId, springId)
    db.prepare(
      `UPDATE courses
         SET name = '秋季数据结构', code = 'CS201', semester = '2026秋',
             class_name = '1班', clazz_id = '7001',
             semester_start = '2026-09-07', max_week = 18, schedule_json = ?
       WHERE id = ?`
    ).run(
      JSON.stringify([
        {
          id: 'r2-fall-s',
          weekday: 7,
          startTime: '10:20',
          endTime: '12:00',
          location: '秋楼101',
          weeks: '1-18'
        }
      ]),
      fallId
    )
    db.prepare(
      `UPDATE courses
         SET name = '春季编译原理', code = 'CS401', semester = '2027春',
             class_name = '1班', clazz_id = '7002',
             semester_start = '2027-01-11', max_week = 18, schedule_json = ?
       WHERE id = ?`
    ).run(
      JSON.stringify([
        {
          id: 'r2-spring-s',
          weekday: 1,
          startTime: '08:20',
          endTime: '10:00',
          location: '春楼202',
          weeks: '1-18'
        }
      ]),
      springId
    )

    if (options?.includeExams) {
      // Seed: stale ongoing snapshot (no endAt, updated yesterday), real ongoing (synced 10m ago),
      // and tomorrow exam with score='--' and status='待进行'
      db.prepare('DELETE FROM exams').run()
      const insertExam = db.prepare(
        `INSERT INTO exams (
          id, external_id, title, course_name, start_at, end_at, duration_minutes,
          exam_status, answer_status, score, mode, source, source_url, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '线上考试', 'chaoxing',
          'https://mooc1.chaoxing.com/exam/r2', ?)`
      )
      insertExam.run(
        'r2-stale-ongoing',
        'r2:stale',
        'R2 陈旧进行中快照',
        '秋季数据结构',
        '2027-01-09T09:00:00+08:00',
        null,
        90,
        '进行中',
        '',
        null,
        '2027-01-09T09:10:00+08:00'
      )
      insertExam.run(
        'r2-real-live',
        'r2:live',
        'R2 实时进行中考试',
        '秋季数据结构',
        '2027-01-10T23:30:00+08:00',
        null,
        120,
        '进行中',
        '',
        null,
        '2027-01-10T23:50:00+08:00'
      )
      insertExam.run(
        'r2-tmr-placeholder',
        'r2:tmr',
        'R2 明日占位分考试',
        '春季编译原理',
        '2027-01-11T14:00:00+08:00',
        '2027-01-11T16:00:00+08:00',
        120,
        '待进行',
        '未交',
        '--',
        '2027-01-10T22:00:00+08:00'
      )
    }
  } finally {
    db.close()
  }
}

async function withIsolatedCrossSemesterApp(
  prefix: string,
  startIso: string,
  options: IsolatedCrossSemesterOptions,
  run: (page: Page) => Promise<void>
): Promise<void> {
  const dataDir = mkdtempSync(join(ROOT, prefix))
  options.onDataDirCreated?.(dataDir)
  const dbPath = join(dataDir, 'workspaces', 'local.sqlite')
  let isolatedApp: ElectronApplication | undefined
  let primaryError: unknown
  let hasPrimaryError = false
  const cleanupErrors: Error[] = []

  try {
    const boot = await launchElectron(dataDir, {
      ...(options.onAppLaunched ? { onLaunched: (app) => options.onAppLaunched?.(1, app) } : {}),
      ...(options.injectFailure?.stage === 'first_launch_ready'
        ? {
            afterWindowReady: async () => {
              throw options.injectFailure!.error
            }
          }
        : {})
    })
    isolatedApp = boot.app
    await waitForFile(dbPath)
    const bootCloseErr = await closeElectronSafely(isolatedApp, dataDir)
    isolatedApp = undefined
    if (bootCloseErr) throw bootCloseErr

    seedCrossSemesterFixture(dbPath, options)

    const session = await launchElectron(dataDir, {
      ...(options.onAppLaunched ? { onLaunched: (app) => options.onAppLaunched?.(2, app) } : {}),
      ...(options.injectFailure?.stage === 'second_launch_ready'
        ? {
            afterWindowReady: async () => {
              throw options.injectFailure!.error
            }
          }
        : {})
    })
    isolatedApp = session.app
    await installControllableClock(session.page, startIso)
    await session.page.reload()
    await session.page.waitForLoadState('domcontentloaded')
    await expect(session.page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })

    await run(session.page)
  } catch (error) {
    primaryError = error
    hasPrimaryError = true
    throw error
  } finally {
    if (isolatedApp) {
      const closeErr = await closeElectronSafely(isolatedApp, dataDir)
      isolatedApp = undefined
      if (closeErr) cleanupErrors.push(closeErr)
    }
    const rmErr = await (options.removeTempDir ?? removeTempDirSafely)(dataDir)
    if (rmErr) cleanupErrors.push(rmErr)

    if (cleanupErrors.length > 0) {
      if (hasPrimaryError) {
        recordCleanupDiagnostics(primaryError, cleanupErrors)
      } else {
        throw cleanupErrors[0]
      }
    }
  }
}

function localDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function todayAtLocal(hour: number, minute: number, dayOffset = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}

function offsetHours(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString()
}

function mondayWeeksAgo(weeksAgo: number): string {
  const d = new Date()
  const wd = d.getDay() === 0 ? 7 : d.getDay()
  d.setDate(d.getDate() - (wd - 1) - weeksAgo * 7)
  return localDateKey(d)
}

function seedTodaySchedule(dbPath: string, courses: Array<{ id: string; name: string }>): void {
  const db = new DatabaseSync(dbPath)
  try {
    const nowIso = new Date().toISOString()
    const todayWd = new Date().getDay() === 0 ? 7 : new Date().getDay()
    const curStart = mondayWeeksAgo(5) // currently week 6
    const futureStart = mondayWeeksAgo(-12) // pre-enrolled future semester starting 12 weeks ahead

    const primaryId = courses[0]!.id
    const dupId = courses[1]!.id
    const futureId = courses[2]!.id

    // Configure two same-name + same-className courses in current active semester with distinct clazz_id
    db.prepare(
      `UPDATE courses
         SET name = '数据结构', code = 'CS201', semester = '2026秋',
             class_name = '1班', clazz_id = '9001',
             semester_start = ?, max_week = 18, schedule_json = ?
       WHERE id = ?`
    ).run(
      curStart,
      JSON.stringify([
        {
          id: 'n8-session-a',
          weekday: todayWd,
          startTime: '10:20',
          endTime: '12:00',
          location: '一教 204',
          weeks: '1-18'
        }
      ]),
      primaryId
    )

    db.prepare(
      `UPDATE courses
         SET name = '数据结构', code = 'CS201', semester = '2026秋',
             class_name = '1班', clazz_id = '9002',
             semester_start = ?, max_week = 18, schedule_json = ?
       WHERE id = ?`
    ).run(
      curStart,
      JSON.stringify([
        {
          id: 'n8-session-b',
          weekday: todayWd,
          startTime: '14:00',
          endTime: '15:40',
          location: '二教 305',
          weeks: '1-18'
        }
      ]),
      dupId
    )

    // Pre-enrolled future semester that must NOT hide currently active 2026秋 courses
    db.prepare(
      `UPDATE courses
         SET name = '编译原理', code = 'CS401', semester = '2027春',
             class_name = '1班', clazz_id = '9901',
             semester_start = ?, max_week = 18, schedule_json = ?
       WHERE id = ?`
    ).run(
      futureStart,
      JSON.stringify([
        {
          id: 'n8-session-future',
          weekday: todayWd,
          startTime: '08:20',
          endTime: '10:00',
          location: '未来楼 101',
          weeks: '1-18'
        }
      ]),
      futureId
    )

    // Seed two tasks today (including 23:59 evening deadline) to test timeline rail + month hidden count
    db.prepare('DELETE FROM tasks').run()
    const insertTask = db.prepare(
      `INSERT INTO tasks (
        id, course_id, title, description, kind, due_at, priority, status,
        completed_at, completion_source, source, external_id, source_url,
        platform_status, platform_status_kind, submitted_at, score, full_score,
        teacher_feedback, attachments_json, manual_fields_json,
        field_sources_json, created_at, updated_at
      ) VALUES (?, ?, ?, '', 'homework', ?, 'high', 'todo', NULL, NULL, 'chaoxing', ?,
        'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?workId=801',
        '未交', 'not_submitted', NULL, NULL, '100', NULL, '[]', '[]', '{}', ?, ?)`
    )
    insertTask.run(
      'n8-task-2359',
      primaryId,
      'N8 晚间23:59截止作业',
      todayAtLocal(23, 59),
      'n8:2359',
      nowIso,
      nowIso
    )
    insertTask.run(
      'n8-task-1500',
      primaryId,
      'N8 下午作业',
      todayAtLocal(15, 0),
      'n8:1500',
      nowIso,
      nowIso
    )

    // Seed historical exams (no endAt / terminal status) + 2 real exams today (so today has 2 exams + 2 tasks = 4 events -> hidden 1)
    db.prepare('DELETE FROM exams').run()
    const insertExam = db.prepare(
      `INSERT INTO exams (
        id, external_id, title, course_name, start_at, end_at, duration_minutes,
        exam_status, answer_status, score, mode, source, source_url, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 90, ?, ?, ?, '线上考试', 'chaoxing',
        'https://mooc1.chaoxing.com/exam/801', ?)`
    )
    // Historical exam without endAt (must NOT hijack dashboard upcoming exams)
    insertExam.run(
      'n8-exam-old-no-end',
      'n8:exam:old1',
      'N8 历史无结束时间旧考',
      '编译原理',
      offsetHours(-24 * 60),
      null,
      '',
      '',
      null,
      nowIso
    )
    // Historical exam with terminal status on yesterday (must NOT hijack dashboard upcoming exams)
    insertExam.run(
      'n8-exam-terminal',
      'n8:exam:old2',
      'N8 历史已结束考试',
      '编译原理',
      offsetHours(-26),
      null,
      '已结束',
      '已提交',
      '90',
      nowIso
    )
    // Real upcoming exam #1 today
    insertExam.run(
      'n8-exam-1',
      'n8:exam:1',
      'N8 近期阶段考试一',
      '数据结构',
      todayAtLocal(21, 30),
      todayAtLocal(22, 30),
      '未开始',
      '',
      null,
      nowIso
    )
    // Real upcoming exam #2 today (creates 2 exams + 2 tasks = 4 events on today's month cell)
    insertExam.run(
      'n8-exam-2',
      'n8:exam:2',
      'N8 近期阶段考试二',
      '数据结构',
      todayAtLocal(22, 40),
      todayAtLocal(23, 30),
      '未开始',
      '',
      null,
      nowIso
    )

    // Seed an older unread notice and a newer read notice
    db.prepare('DELETE FROM app_notices').run()
    db.prepare(
      `INSERT INTO app_notices (
        id, external_id, title, body, category, sender, course_name,
        published_at, is_read, url, source, updated_at
      ) VALUES
        ('n8-read', 'n8:read', 'N8 已读较新通知', '已读正文', 'course', '教务处', '数据结构', ?, 1, NULL, 'chaoxing', ?),
        ('n8-unread', 'n8:unread', 'N8 未读优先通知', '未读正文', 'course', '任课教师', '数据结构', ?, 0, NULL, 'chaoxing', ?)`
    ).run(offsetHours(-1), nowIso, offsetHours(-12), nowIso)
  } finally {
    db.close()
  }
}

test.describe('今日页与多视图日程', () => {
  let dataDir: string
  let dbPath: string
  let app: ElectronApplication | undefined
  let page: Page

  test.beforeAll(async () => {
    dataDir = mkdtempSync(join(ROOT, '.tmp-e2e-n008-today-'))
    dbPath = join(dataDir, 'workspaces', 'local.sqlite')
    const boot = await launchElectron(dataDir)
    app = boot.app
    page = boot.page
    await waitForFile(dbPath)
    const courses = await page.evaluate(async () => {
      const api = window.studynext as unknown as {
        bootstrap: () => Promise<{ courses: Array<{ id: string; name: string }> }>
      }
      const result = await api.bootstrap()
      return result.courses.slice(0, 3)
    })
    if (courses.length < 3) throw new Error('N-008 E2E 缺少足够课程数据')
    const bootCloseErr = await closeElectronSafely(app, dataDir)
    app = undefined
    if (bootCloseErr) throw bootCloseErr
    seedTodaySchedule(dbPath, courses)
    const session = await launchElectron(dataDir)
    app = session.app
    page = session.page
  })

  test.afterAll(async () => {
    const cleanupErrors: Error[] = []
    if (app) {
      const closeErr = await closeElectronSafely(app, dataDir)
      app = undefined
      if (closeErr) cleanupErrors.push(closeErr)
    }
    if (dataDir) {
      const rmErr = await removeTempDirSafely(dataDir)
      if (rmErr) cleanupErrors.push(rmErr)
    }
    if (cleanupErrors.length > 0) {
      throw cleanupErrors[0]
    }
  })

  test('跨学期当前排课不被未来预录学期遮蔽，历史考试不挤占近期考试，同名同班课程可见稳定班级标识', async () => {
    await expect(page.locator('.studio-today')).toBeVisible()

    // 当前学期(2026秋)两门同名同班课程均展示且可见稳定班级标识 9001 / 9002
    const ribbon = page.locator('.today-classes-ribbon')
    await expect(ribbon).toBeVisible()
    await expect(ribbon).toContainText('一教 204')
    await expect(ribbon).toContainText('二教 305')
    await expect(ribbon).not.toContainText('未来楼 101')
    await expect(ribbon.locator('.today-class-tag', { hasText: '9001' })).toBeVisible()
    await expect(ribbon.locator('.today-class-tag', { hasText: '9002' })).toBeVisible()
    await expect(ribbon.locator('.today-ribbon-pending').first()).toContainText('2 项待交')

    // 近期考试只展示真实临近考试，不包含历史无结束时间或已结束考试
    const examBlock = page.locator('.today-exam-block')
    await expect(examBlock).toBeVisible()
    await expect(examBlock).toContainText('N8 近期阶段考试一')
    await expect(examBlock).not.toContainText('N8 历史无结束时间旧考')
    await expect(examBlock).not.toContainText('N8 历史已结束考试')

    // 未读通知优先展示
    await expect(page.locator('.today-notice-unread-pill')).toContainText('未读 1')
    await expect(page.locator('.today-side-col .notice-item').first()).toContainText(
      'N8 未读优先通知'
    )

    // 周课表截止行点击作业直开详情弹窗，且 +2 项日程可直达日视图查看晚间 23:59 截止作业
    const weekAgendaChip = page.locator('.week-table-agenda-cell .week-agenda-chip', {
      hasText: 'N8 下午作业'
    })
    await expect(weekAgendaChip).toBeVisible()
    await weekAgendaChip.click()
    await expect(page.locator('.modal')).toBeVisible()
    await expect(page.locator('.b2-detail-title')).toHaveText('N8 下午作业')
    await page.locator('.modal-close').click()

    await page
      .locator('.week-table-agenda-cell .week-agenda-more', { hasText: '+2 项日程' })
      .click()
    await expect(page.locator('.studio-day-wrap')).toBeVisible()
    await expect(
      page.locator('.studio-day-task-row', { hasText: 'N8 晚间23:59截止作业' })
    ).toBeVisible()
    await expect(
      page.locator('.studio-day-task-row .today-go-btn', { hasText: '去作答' }).first()
    ).toBeEnabled()
  })

  test('时间轴在 1440px 与 1024px 下保持 8 列严格对齐，晚间截止芯片落在对应日期列内且页面无横向溢出', async () => {
    const todayKey = localDateKey(new Date())

    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 })
      await page.getByRole('button', { name: '时间轴', exact: true }).click()
      await expect(page.locator('.week-timeline-grid')).toBeVisible()

      const geometry = await page.evaluate((key) => {
        const heads = [
          ...document.querySelectorAll<HTMLElement>('.week-timeline-grid .week-day-head')
        ]
        const headRects = heads.map((el) => {
          const r = el.getBoundingClientRect()
          return {
            key: el.dataset.dateKey,
            left: r.left,
            right: r.right,
            top: r.top,
            width: r.width
          }
        })
        const targetHead = document.querySelector<HTMLElement>(
          `.week-timeline-grid .week-day-head[data-date-key="${key}"]`
        )
        const targetAllDay = document.querySelector<HTMLElement>(
          `.week-timeline-grid .week-allday-cell[data-date-key="${key}"]`
        )
        const targetCol = document.querySelector<HTMLElement>(
          `.week-timeline-grid .week-day-col[data-date-key="${key}"]`
        )
        const targetChip = targetAllDay?.querySelector<HTMLElement>(
          '.week-agenda-chip:not(.is-exam)'
        )
        return {
          headCount: heads.length,
          headRects,
          headRect: targetHead?.getBoundingClientRect() ?? null,
          allDayRect: targetAllDay?.getBoundingClientRect() ?? null,
          colRect: targetCol?.getBoundingClientRect() ?? null,
          chipRect: targetChip?.getBoundingClientRect() ?? null,
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth
        }
      }, todayKey)

      expect(geometry.headCount).toBe(7)
      expect(geometry.pageOverflow).toBeLessThanOrEqual(1)
      // All 7 day headers must stay on one single horizontal row, strictly left-to-right
      for (let i = 1; i < geometry.headRects.length; i += 1) {
        expect(
          Math.abs(geometry.headRects[i]!.top - geometry.headRects[0]!.top)
        ).toBeLessThanOrEqual(1)
        expect(geometry.headRects[i]!.left).toBeGreaterThan(geometry.headRects[i - 1]!.left + 50)
      }
      expect(geometry.headRect).not.toBeNull()
      expect(geometry.allDayRect).not.toBeNull()
      expect(geometry.colRect).not.toBeNull()
      expect(geometry.chipRect).not.toBeNull()

      // Header, all-day cell, and hourly column for today must share identical horizontal bounds
      expect(Math.abs(geometry.allDayRect!.left - geometry.headRect!.left)).toBeLessThanOrEqual(2)
      expect(Math.abs(geometry.allDayRect!.width - geometry.headRect!.width)).toBeLessThanOrEqual(2)
      expect(Math.abs(geometry.colRect!.left - geometry.headRect!.left)).toBeLessThanOrEqual(2)
      expect(Math.abs(geometry.colRect!.width - geometry.headRect!.width)).toBeLessThanOrEqual(2)

      // 23:59 deadline chip must lie strictly inside today's column
      expect(geometry.chipRect!.left).toBeGreaterThanOrEqual(geometry.headRect!.left - 1)
      expect(geometry.chipRect!.right).toBeLessThanOrEqual(geometry.headRect!.right + 1)
    }
  })

  test('月视图隐藏计数准确计入未展示考试，且日/周/月/时间轴切换保持所选日期与教学周一致', async () => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const today = new Date()
    const todayKey = localDateKey(today)

    // 月视图：今日有 2 场考试 + 2 项任务 = 4 项事件 -> 渲染 1 场考试 + 2 项任务，准确提示“还有 1 项”
    await page.getByRole('button', { name: '月视图', exact: true }).click()
    const todayCell = page.locator(`.calendar-day[data-date-key="${todayKey}"]`)
    await expect(todayCell.locator('.calendar-exam-event')).toHaveCount(1)
    await expect(todayCell.locator('.calendar-event')).toHaveCount(2)
    await expect(todayCell.locator('.calendar-more')).toHaveText('还有 1 项')

    // 在月视图点击 7 天后的日期（下周），切换周课表、日视图与时间轴均保持该日期与教学周
    const nextWeekDate = new Date(today)
    nextWeekDate.setDate(today.getDate() + 7)
    const nextWeekKey = localDateKey(nextWeekDate)
    const targetCell = page.locator(`.calendar-day[data-date-key="${nextWeekKey}"]`)
    if ((await targetCell.count()) === 0) {
      await page.getByRole('button', { name: '下一页' }).click()
    }
    await page.locator(`.calendar-day[data-date-key="${nextWeekKey}"] .calendar-day-number`).click()

    // 切换到周课表：应显示第 7 周（今天是第 6 周，+7 天为第 7 周）
    await page.getByRole('button', { name: '周课表', exact: true }).click()
    await expect(page.locator('.studio-timetable-bar .today-week-pill')).toHaveText('第 7 周')

    // 切换到日视图：应显示选中日期与第 7 周
    await page.getByRole('button', { name: '日视图', exact: true }).click()
    await expect(page.locator('.studio-day-wrap .studio-timetable-range')).toContainText(
      `${nextWeekDate.getFullYear()}年${nextWeekDate.getMonth() + 1}月${nextWeekDate.getDate()}日`
    )
    await expect(page.locator('.studio-day-wrap .today-week-pill')).toHaveText('第 7 周')

    // 在日视图点“下一天”，再切时间轴：对应日期表头高亮 selected
    const nextPlusOne = new Date(nextWeekDate)
    nextPlusOne.setDate(nextWeekDate.getDate() + 1)
    const nextPlusOneKey = localDateKey(nextPlusOne)
    await page.getByRole('button', { name: '下一天' }).click()
    await page.getByRole('button', { name: '时间轴', exact: true }).click()
    await expect(
      page.locator(`.week-timeline-grid .week-day-head[data-date-key="${nextPlusOneKey}"]`)
    ).toHaveClass(/selected/)
  })
})

test('固定时钟下陈旧进行中考试不遮蔽明日占位分考试，且持续运行跨学期时自动/手动选学期表现正确', async () => {
  const fixedStartIso = '2027-01-10T23:59:30+08:00' // Sunday of 2026秋 Week 18
  await withIsolatedCrossSemesterApp(
    '.tmp-e2e-n008-r2-exams-',
    fixedStartIso,
    { includeExams: true },
    async (isolatedPage) => {
      // 1) Dashboard 近期考试：展示实时进行中考试 + 明日占位分考试，不展示昨日陈旧进行中快照
      const examBlock = isolatedPage.locator('.today-exam-block')
      await expect(examBlock).toBeVisible()
      await expect(examBlock).toContainText('R2 实时进行中考试')
      await expect(examBlock).toContainText('R2 明日占位分考试')
      await expect(examBlock).not.toContainText('R2 陈旧进行中快照')

      // 2) 自动学期模式：当前在 2026秋 第 18 周末，默认选中 2026秋 并展示秋季课程
      const semesterSelect = isolatedPage.getByLabel('选择课表学期')
      await expect(semesterSelect).toHaveValue('2026秋')
      await expect(isolatedPage.locator('.studio-full-week-table')).toContainText('秋季数据结构')

      // 3) 持续运行跨越学期边界进入 2027春 第 1 周（不 reload！）：自动模式切到 2027春
      await isolatedPage.evaluate(() => {
        ;(window as Window & { __n8Advance?: (ms: number) => void }).__n8Advance?.(10 * 60_000)
      })
      await expect(semesterSelect).toHaveValue('2027春')
      await expect(isolatedPage.locator('.studio-full-week-table')).toContainText('春季编译原理')

      // 4) 用户手动切换回 2026秋 后继续推进时间：手动选择保持不变
      await semesterSelect.selectOption('2026秋')
      await expect(semesterSelect).toHaveValue('2026秋')
      await isolatedPage.evaluate(() => {
        ;(window as Window & { __n8Advance?: (ms: number) => void }).__n8Advance?.(60 * 60_000)
      })
      await isolatedPage.waitForTimeout(180)
      await expect(semesterSelect).toHaveValue('2026秋')

      // 5) 考试安排页状态一致：陈旧快照显示“时间待确认”且保留原“进行中”标签；明日占位分考试显示“即将开始”与“—”分
      await isolatedPage.locator('.studio-pill-item', { hasText: '作业' }).click()
      await isolatedPage.getByRole('tab', { name: /考试安排/ }).click()
      const staleCard = isolatedPage.locator('.exam-card').filter({ hasText: 'R2 陈旧进行中快照' })
      await expect(staleCard.locator('.exam-status')).toHaveText('时间待确认')
      await expect(staleCard.locator('.exam-chip', { hasText: '进行中' })).toBeVisible()

      const tmrCard = isolatedPage.locator('.exam-card').filter({ hasText: 'R2 明日占位分考试' })
      await expect(tmrCard.locator('.exam-status')).toHaveText('即将开始')
      await expect(tmrCard).toContainText('待进行')
      await expect(tmrCard).not.toContainText('已结束')
      await expect(tmrCard.locator('.exam-meta')).not.toContainText('--')
    }
  )
})

test('手选旧日期进入日视图后跨午夜进入新学期，旧日期标题与原学期课程保持一致，手动学期与全部学期不受影响', async () => {
  const fixedStartIso = '2027-01-10T23:59:30+08:00' // Sunday of 2026秋 Week 18
  await withIsolatedCrossSemesterApp(
    '.tmp-e2e-n008-r4-pinned-day-',
    fixedStartIso,
    { includeExams: false },
    async (isolatedPage) => {
      await expect(isolatedPage.locator('.today-title')).toContainText('1月10日')

      const semesterSelect = isolatedPage.getByLabel('选择课表学期')
      await expect(semesterSelect).toHaveValue('2026秋')

      // 1) 在秋季学期周课表中点击 1 月 10 日（周日）进入日视图，确认标题与秋季课程正常显示
      await isolatedPage
        .locator('.studio-full-week-table .week-table-day', { hasText: '1/10' })
        .click()
      await expect(isolatedPage.locator('.studio-day-wrap')).toBeVisible()
      await expect(isolatedPage.locator('.studio-day-wrap .studio-timetable-range')).toContainText(
        '2027年1月10日'
      )
      await expect(isolatedPage.locator('.studio-day-wrap .today-week-pill')).toHaveText('第 18 周')
      await expect(isolatedPage.locator('.studio-day-session')).toContainText('秋季数据结构')
      await expect(isolatedPage.locator('.studio-day-session')).toContainText('秋楼101')

      // 2) 应用持续运行，时钟跨过午夜进入 1 月 11 日（2027春 第 1 周）
      await isolatedPage.evaluate(() => {
        ;(window as Window & { __n8Advance?: (ms: number) => void }).__n8Advance?.(10 * 60_000)
      })
      // 确认首页实时时钟已进入 1 月 11 日
      await expect(isolatedPage.locator('.today-title')).toContainText('1月11日')

      // 3) 手选的 1 月 10 日日视图标题、教学周、自动学期与秋季课程必须保持一致（不得显示“当天没有排课”）
      await expect(isolatedPage.locator('.studio-day-wrap .studio-timetable-range')).toContainText(
        '2027年1月10日'
      )
      await expect(isolatedPage.locator('.studio-day-wrap .today-week-pill')).toHaveText('第 18 周')
      await expect(semesterSelect).toHaveValue('2026秋')
      await expect(isolatedPage.locator('.studio-day-session')).toContainText('秋季数据结构')
      await expect(isolatedPage.locator('.studio-day-wrap')).not.toContainText('当天没有排课')

      // 4) 点击“今天”恢复跟随当前日期（1 月 11 日）：自动模式切到 2027春 并显示春季课程
      await isolatedPage
        .locator('.studio-day-wrap')
        .getByRole('button', { name: '今天', exact: true })
        .click()
      await expect(isolatedPage.locator('.studio-day-wrap .studio-timetable-range')).toContainText(
        '2027年1月11日'
      )
      await expect(semesterSelect).toHaveValue('2027春')
      await expect(isolatedPage.locator('.studio-day-session')).toContainText('春季编译原理')

      // 5) 手动选择特定学期与“全部学期”在翻动日期时均不受自动模式覆盖
      await semesterSelect.selectOption('2026秋')
      await expect(semesterSelect).toHaveValue('2026秋')
      await isolatedPage.getByRole('button', { name: '上一天' }).click()
      await expect(semesterSelect).toHaveValue('2026秋')
      await expect(isolatedPage.locator('.studio-day-session')).toContainText('秋季数据结构')

      await semesterSelect.selectOption('all')
      await expect(semesterSelect).toHaveValue('all')
      await isolatedPage.getByRole('button', { name: '下一天' }).click()
      await expect(semesterSelect).toHaveValue('all')
      await expect(isolatedPage.locator('.studio-day-session')).toContainText('春季编译原理')
    }
  )
})

test('故障注入 A：首次启动后页面就绪检查失败时退出 Electron、删除临时目录并保留原始异常', async () => {
  const siblingDir = mkdtempSync(join(ROOT, '.tmp-e2e-n008-r5-sibling-a-'))
  const injectedError = new Error('INJECTED_FIRST_LAUNCH_READY_FAILURE')
  let createdDataDir = ''
  const launchedProcs: Partial<Record<1 | 2, ChildProcess>> = {}
  let caughtError: unknown

  let testPrimaryError: unknown
  let hasTestPrimaryError = false

  try {
    try {
      await withIsolatedCrossSemesterApp(
        '.tmp-e2e-n008-r5-fault-a-',
        '2027-01-10T23:59:30+08:00',
        {
          includeExams: false,
          onDataDirCreated: (dir) => {
            createdDataDir = dir
          },
          onAppLaunched: (attempt, launchedApp) => {
            launchedProcs[attempt] = launchedApp.process()
          },
          injectFailure: {
            stage: 'first_launch_ready',
            error: injectedError
          }
        },
        async () => {
          throw new Error('不应进入测试主体')
        }
      )
    } catch (error) {
      caughtError = error
    }

    expect(caughtError).toBe(injectedError)
    expect(launchedProcs[1]?.pid).toBeGreaterThan(0)
    expect(isChildProcessExited(launchedProcs[1])).toBe(true)
    expect(createdDataDir).not.toBe('')
    expect(existsSync(createdDataDir)).toBe(false)
    expect(existsSync(siblingDir)).toBe(true)
  } catch (error) {
    testPrimaryError = error
    hasTestPrimaryError = true
    throw error
  } finally {
    const rmErr = await removeTempDirSafely(siblingDir)
    if (rmErr) {
      if (hasTestPrimaryError) {
        recordCleanupDiagnostics(testPrimaryError, [rmErr])
      } else {
        throw rmErr
      }
    }
  }
})

test('故障注入 B：写入夹具后第二次启动就绪检查失败时退出 Electron、删除临时目录并保留原始异常', async () => {
  const siblingDir = mkdtempSync(join(ROOT, '.tmp-e2e-n008-r5-sibling-b-'))
  const injectedError = new Error('INJECTED_SECOND_LAUNCH_READY_FAILURE')
  let createdDataDir = ''
  const launchedProcs: Partial<Record<1 | 2, ChildProcess>> = {}
  let caughtError: unknown
  let testPrimaryError: unknown
  let hasTestPrimaryError = false

  try {
    try {
      await withIsolatedCrossSemesterApp(
        '.tmp-e2e-n008-r5-fault-b-',
        '2027-01-10T23:59:30+08:00',
        {
          includeExams: false,
          onDataDirCreated: (dir) => {
            createdDataDir = dir
          },
          onAppLaunched: (attempt, launchedApp) => {
            launchedProcs[attempt] = launchedApp.process()
          },
          injectFailure: {
            stage: 'second_launch_ready',
            error: injectedError
          }
        },
        async () => {
          throw new Error('不应进入测试主体')
        }
      )
    } catch (error) {
      caughtError = error
    }

    expect(caughtError).toBe(injectedError)
    expect(launchedProcs[1]?.pid).toBeGreaterThan(0)
    expect(launchedProcs[2]?.pid).toBeGreaterThan(0)
    expect(isChildProcessExited(launchedProcs[1])).toBe(true)
    expect(isChildProcessExited(launchedProcs[2])).toBe(true)
    expect(createdDataDir).not.toBe('')
    expect(existsSync(createdDataDir)).toBe(false)
    expect(existsSync(siblingDir)).toBe(true)
  } catch (error) {
    testPrimaryError = error
    hasTestPrimaryError = true
    throw error
  } finally {
    const rmErr = await removeTempDirSafely(siblingDir)
    if (rmErr) {
      if (hasTestPrimaryError) {
        recordCleanupDiagnostics(testPrimaryError, [rmErr])
      } else {
        throw rmErr
      }
    }
  }
})

test('安全清理 C：路径前缀重合的两实例强制终止 A 时仅退出 A 且不误伤 B 及其子进程，归属不符时拒绝强杀', async () => {
  const baseDir = mkdtempSync(join(ROOT, '.tmp-e2e-n008-r6-prefix-'))
  const dirA = join(baseDir, 'inst')
  const dirB = join(baseDir, 'inst-2')
  mkdirSync(dirA)
  mkdirSync(dirB)

  let appA: ElectronApplication | undefined
  let appB: ElectronApplication | undefined
  let pageB: Page | undefined
  let testPrimaryError: unknown
  let hasTestPrimaryError = false

  try {
    const sessionA = await launchElectron(dirA)
    appA = sessionA.app
    const sessionB = await launchElectron(dirB)
    appB = sessionB.app
    pageB = sessionB.page

    const procA = appA.process()
    const procB = appB.process()
    expect(procA.pid).toBeGreaterThan(0)
    expect(procB.pid).toBeGreaterThan(0)
    expect(dirB.startsWith(dirA)).toBe(true)

    // 1) 归属校验必须精确区分前缀重合目录：A 属于 dirA，B 不属于 dirA
    expect(verifyOwnedElectronProcess(procA, dirA).verified).toBe(true)
    expect(verifyOwnedElectronProcess(procB, dirA).verified).toBe(false)

    // 2) 无法确认归属时（传入前缀重合目录 dirA 对应实例 B）：报告清理失败且绝不强杀 B
    const unverifiedHangingB: Pick<ElectronApplication, 'close' | 'process'> = {
      process: () => procB,
      close: () => new Promise<void>(() => {})
    }
    const unverifiedErr = await closeElectronSafely(unverifiedHangingB, dirA, {
      closeTimeoutMs: 120
    })
    expect(unverifiedErr).not.toBeNull()
    expect(unverifiedErr?.message).toContain('无法确认 Electron 进程归属')
    expect(isChildProcessExited(procB)).toBe(false)
    expect(await pageB.evaluate(() => 1 + 1)).toBe(2)

    // 3) 实际走通已核验归属的强制终止分支关闭 A（模拟优雅关闭卡死），B 及其渲染子进程保持完好
    const hangingA: Pick<ElectronApplication, 'close' | 'process'> = {
      process: () => procA,
      close: () => new Promise<void>(() => {})
    }
    const forcedCloseErr = await closeElectronSafely(hangingA, dirA, { closeTimeoutMs: 120 })
    appA = undefined
    expect(forcedCloseErr).not.toBeNull()
    expect(forcedCloseErr?.message).toContain('超时')
    expect(isChildProcessExited(procA)).toBe(true)
    expect(await removeTempDirSafely(dirA)).toBeNull()
    expect(existsSync(dirA)).toBe(false)

    // B 及其渲染进程、数据目录均完全不受影响
    expect(isChildProcessExited(procB)).toBe(false)
    expect(existsSync(dirB)).toBe(true)
    await expect(pageB.locator('.studio-today')).toBeVisible()
    expect(await pageB.evaluate(() => document.readyState)).toBe('complete')
  } catch (error) {
    testPrimaryError = error
    hasTestPrimaryError = true
    throw error
  } finally {
    const cleanupErrors: Error[] = []
    if (appA) {
      const errA = await closeElectronSafely(appA, dirA)
      appA = undefined
      if (errA) cleanupErrors.push(errA)
    }
    if (appB) {
      const errB = await closeElectronSafely(appB, dirB)
      appB = undefined
      if (errB) cleanupErrors.push(errB)
    }
    const rmErr = await removeTempDirSafely(baseDir)
    if (rmErr) cleanupErrors.push(rmErr)
    if (cleanupErrors.length > 0) {
      if (hasTestPrimaryError) {
        recordCleanupDiagnostics(testPrimaryError, cleanupErrors)
      } else {
        throw cleanupErrors[0]
      }
    }
  }
})

test('安全清理 D：冻结/不可扩展主异常与清理失败并存时原样传播主异常，且独立记录清理诊断', async () => {
  const frozenError = Object.freeze(new Error('INJECTED_FROZEN_PRIMARY_ERROR'))
  const injectedCleanupError = new Error('INJECTED_TEMP_DIR_CLEANUP_FAILURE')
  let createdDataDir = ''
  const launchedProcs: Partial<Record<1 | 2, ChildProcess>> = {}
  let caughtError: unknown

  try {
    await withIsolatedCrossSemesterApp(
      '.tmp-e2e-n008-r6-frozen-',
      '2027-01-10T23:59:30+08:00',
      {
        includeExams: false,
        onDataDirCreated: (dir) => {
          createdDataDir = dir
        },
        onAppLaunched: (attempt, launchedApp) => {
          launchedProcs[attempt] = launchedApp.process()
        },
        removeTempDir: async (dir) => {
          const actualRmErr = await removeTempDirSafely(dir)
          return actualRmErr ?? injectedCleanupError
        },
        injectFailure: {
          stage: 'first_launch_ready',
          error: frozenError
        }
      },
      async () => {
        throw new Error('不应进入测试主体')
      }
    )
  } catch (error) {
    caughtError = error
  }

  // 1) 冻结主异常必须原样传播、不被修改，且清理错误保存在独立诊断记录中
  expect(caughtError).toBe(frozenError)
  expect(Object.isFrozen(caughtError)).toBe(true)
  expect('cleanupErrors' in (caughtError as object)).toBe(false)
  expect(getCleanupDiagnostics(caughtError)).toEqual([injectedCleanupError])

  // 2) Electron 进程已退出且真实临时目录已删除
  expect(launchedProcs[1]?.pid).toBeGreaterThan(0)
  expect(isChildProcessExited(launchedProcs[1])).toBe(true)
  expect(createdDataDir).not.toBe('')
  expect(existsSync(createdDataDir)).toBe(false)

  // 3) 不可扩展异常对象同样不抛 TypeError 且独立记录诊断
  const nonExtensibleError = Object.preventExtensions(new Error('NON_EXTENSIBLE_PRIMARY_ERROR'))
  const extraCleanupError = new Error('EXTRA_CLEANUP_FAILURE')
  expect(() => recordCleanupDiagnostics(nonExtensibleError, [extraCleanupError])).not.toThrow()
  expect(Object.isExtensible(nonExtensibleError)).toBe(false)
  expect('cleanupErrors' in nonExtensibleError).toBe(false)
  expect(getCleanupDiagnostics(nonExtensibleError)).toEqual([extraCleanupError])
})
