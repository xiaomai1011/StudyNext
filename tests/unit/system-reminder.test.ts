import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SystemReminderService,
  buildQueryTaskScript,
  buildRegisterTaskScript,
  buildLegacySystemReminderTaskName,
  buildRemoveTaskScript,
  buildSystemReminderTaskName,
  parseTaskQuery,
  type PowerShellExecutor
} from '../../src/main/notifications/system-reminder'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studynext-system-reminder-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('system reminder scripts', () => {
  it('derives a stable task name from the SID, not the display name', () => {
    const a = buildSystemReminderTaskName('S-1-5-21-111-222-333-1001', 'DESKTOP-1')
    expect(a).toBe(buildSystemReminderTaskName('S-1-5-21-111-222-333-1001', 'DESKTOP-1'))
    expect(a).toMatch(/^StudyNext-DDL-DESKTOP-1-[a-f0-9]{12}$/)
    expect(a).not.toContain('1001')
    // Two users whose display names sanitize to the same "user" still differ.
    const b = buildSystemReminderTaskName('S-1-5-21-111-222-333-1002', 'DESKTOP-1')
    expect(a).not.toBe(b)
    expect(buildLegacySystemReminderTaskName('钟嘉杨', 'DESKTOP-1')).toBe(
      'StudyNext-DDL-DESKTOP-1-user'
    )
    expect(buildSystemReminderTaskName('S-1-5-21-1', 'local host')).toMatch(
      /^StudyNext-DDL-local-host-[a-f0-9]{12}$/
    )
  })

  it('registers a one-shot task for the SID principal without WakeToRun', () => {
    const script = buildRegisterTaskScript({
      taskName: 'StudyNext-DDL-test',
      executablePath: 'C:\\Program Files\\StudyNext\\StudyNext.exe',
      runAt: '2026-11-22T10:00:00.000Z',
      principalUserId: 'S-1-5-21-111-222-333-1001'
    })
    expect(script).toContain("New-ScheduledTaskAction -Execute $exe -Argument '--check-reminders'")
    expect(script).toContain('New-ScheduledTaskTrigger -Once -At $runAt')
    expect(script).toContain('-StartWhenAvailable')
    expect(script).toContain('-LogonType Interactive -RunLevel Limited')
    expect(script).not.toContain('WakeToRun')
    expect(script).toContain("$principalUserId='S-1-5-21-111-222-333-1001'")
    expect(script).toContain('-UserId $principalUserId')
    expect(script).not.toContain('$env:USERDOMAIN')
  })

  it('queries and removes only the named task', () => {
    expect(buildQueryTaskScript('StudyNext-DDL-test')).toContain(
      'Get-ScheduledTask -TaskName $taskName'
    )
    expect(buildRemoveTaskScript('StudyNext-DDL-test')).toContain(
      'Unregister-ScheduledTask -TaskName $taskName'
    )
  })

  it('parses the final JSON line from PowerShell output', () => {
    expect(
      parseTaskQuery(
        'noise\n{"exists":true,"execute":"C:\\\\StudyNext.exe","arguments":"--check-reminders",' +
          '"nextRunAt":"2026-11-22T10:00:00.0000000+08:00","lastRunAt":null,"lastTaskResult":0}\n'
      )
    ).toMatchObject({
      exists: true,
      execute: 'C:\\StudyNext.exe',
      arguments: '--check-reminders',
      lastTaskResult: 0
    })
    expect(parseTaskQuery('{"exists":false}')).toEqual({ exists: false })
  })

  it('parses the SID principal used for ownership checks', () => {
    expect(
      parseTaskQuery(
        '{"exists":true,"execute":"C:\\\\StudyNext.exe","arguments":"--check-reminders",' +
          '"principalUserId":"S-1-5-21-111-222-333-1001","nextRunAt":null,' +
          '"lastRunAt":null,"lastTaskResult":0}'
      )
    ).toMatchObject({
      exists: true,
      principalUserId: 'S-1-5-21-111-222-333-1001'
    })
    expect(
      parseTaskQuery(
        '{"exists":true,"execute":"C:\\\\StudyNext.exe","arguments":"--check-reminders",' +
          '"principalUserId":"45181","principalSid":"S-1-5-21-111-222-333-1001",' +
          '"nextRunAt":null,"lastRunAt":null,"lastTaskResult":0}'
      )
    ).toMatchObject({
      principalUserId: '45181',
      principalSid: 'S-1-5-21-111-222-333-1001'
    })
  })

  it('refuses removal when the resolved principal SID belongs to another user', async () => {
    const removed: string[] = []
    const executor: PowerShellExecutor = {
      run: vi.fn(async (script: string) => {
        if (script.includes('Unregister-ScheduledTask')) {
          removed.push(script)
          return { stdout: '{"removed":true}', stderr: '' }
        }
        return {
          stdout:
            '{"exists":true,"execute":"C:\\\\StudyNext.exe","arguments":"--check-reminders",' +
            '"principalUserId":"45181","principalSid":"S-1-5-21-999-888-777-1009",' +
            '"nextRunAt":null,"lastRunAt":null,"lastTaskResult":0}',
          stderr: ''
        }
      })
    }
    const service = new SystemReminderService({
      dataDir: tempDir(),
      executablePath: 'C:\\StudyNext.exe',
      taskName: 'StudyNext-DDL-test',
      sid: 'S-1-5-21-111-222-333-1001',
      platform: 'win32',
      packaged: true,
      executor
    })
    await expect(service.syncNextTrigger({ enabled: false, nextRunAt: null })).rejects.toThrow(
      '不属于此 StudyNext 安装'
    )
    expect(removed).toHaveLength(0)
  })

  it('blocks registration when the Windows SID is unavailable', async () => {
    const executor = { run: vi.fn() } satisfies PowerShellExecutor
    const service = new SystemReminderService({
      dataDir: tempDir(),
      executablePath: 'C:\\StudyNext.exe',
      sid: null,
      platform: 'win32',
      packaged: true,
      executor
    })
    const status = await service.syncNextTrigger({
      enabled: true,
      nextRunAt: '2026-11-22T03:00:00.000Z'
    })
    expect(status.registered).toBe(false)
    expect(status.lastScheduleError).toContain('SID')
    expect(executor.run).not.toHaveBeenCalled()
  })

  it('migrates an owned legacy task and refuses a foreign one', async () => {
    const dataDir = tempDir()
    const currentSid = 'S-1-5-21-111-222-333-1001'
    const oldName = 'StudyNext-DDL-OLD-user'
    const removed: string[] = []
    const executor: PowerShellExecutor = {
      run: vi.fn(async (script: string) => {
        if (script.includes('Unregister-ScheduledTask')) {
          const match = script.match(/\$taskName='([^']+)'/)
          if (match?.[1]) removed.push(match[1])
          return { stdout: '{"removed":true}', stderr: '' }
        }
        if (script.includes(oldName)) {
          return {
            stdout:
              '{"exists":true,"execute":"C:\\\\StudyNext.exe","arguments":"--check-reminders",' +
              `"principalUserId":"${currentSid}","nextRunAt":null,"lastRunAt":null,"lastTaskResult":0}`,
            stderr: ''
          }
        }
        return { stdout: '{"exists":false}', stderr: '' }
      })
    }
    const service = new SystemReminderService({
      dataDir,
      executablePath: 'C:\\StudyNext.exe',
      sid: currentSid,
      legacyTaskNames: [oldName],
      platform: 'win32',
      packaged: true,
      executor,
      now: () => new Date('2026-11-22T01:00:00.000Z')
    })
    const status = await service.initialize()
    expect(removed).toEqual([oldName])
    expect(status.registered).toBe(false)
  })

  it('never deletes a legacy task owned by another principal', async () => {
    const dataDir = tempDir()
    const oldName = 'StudyNext-DDL-OLD-user'
    const removed: string[] = []
    const executor: PowerShellExecutor = {
      run: vi.fn(async (script: string) => {
        if (script.includes('Unregister-ScheduledTask')) {
          removed.push(script)
          return { stdout: '{"removed":true}', stderr: '' }
        }
        if (script.includes(oldName)) {
          return {
            stdout:
              '{"exists":true,"execute":"C:\\\\StudyNext.exe","arguments":"--check-reminders",' +
              '"principalUserId":"S-1-5-21-999-888-777-1009","nextRunAt":null,"lastRunAt":null,"lastTaskResult":0}',
            stderr: ''
          }
        }
        return { stdout: '{"exists":false}', stderr: '' }
      })
    }
    const service = new SystemReminderService({
      dataDir,
      executablePath: 'C:\\StudyNext.exe',
      sid: 'S-1-5-21-111-222-333-1001',
      legacyTaskNames: [oldName],
      platform: 'win32',
      packaged: true,
      executor
    })
    await service.initialize()
    expect(removed).toHaveLength(0)
  })

  it('keeps delivery and scheduler errors isolated', async () => {
    const dataDir = tempDir()
    let failRegister = false
    const executor: PowerShellExecutor = {
      run: vi.fn(async (script: string) => {
        if (script.includes('Register-ScheduledTask') && failRegister) {
          throw new Error('任务计划服务不可用')
        }
        if (script.includes('Register-ScheduledTask')) {
          return {
            stdout:
              '{"exists":true,"execute":"C:\\\\StudyNext.exe","arguments":"--check-reminders",' +
              '"nextRunAt":"2026-11-22T02:00:02.000Z","lastRunAt":null,"lastTaskResult":0}',
            stderr: ''
          }
        }
        return { stdout: '{"exists":false}', stderr: '' }
      })
    }
    const service = new SystemReminderService({
      dataDir,
      executablePath: 'C:\\StudyNext.exe',
      taskName: 'StudyNext-DDL-test',
      sid: 'S-1-5-21-111-222-333-1001',
      platform: 'win32',
      packaged: true,
      executor,
      now: () => new Date('2026-11-22T01:00:00.000Z')
    })
    service.recordCheck({ at: '2026-11-22T01:00:00.000Z', error: '投递失败' })
    await service.refreshStatus()
    expect(service.getStatus().lastDeliveryError).toBe('投递失败')

    failRegister = true
    await expect(
      service.syncNextTrigger({
        enabled: true,
        nextRunAt: '2026-11-22T03:00:00.000Z'
      })
    ).rejects.toThrow('任务计划服务不可用')
    expect(service.getStatus().lastDeliveryError).toBe('投递失败')
    expect(service.getStatus().lastScheduleError).toContain('任务计划服务不可用')

    // A successful delivery is the only event that clears the delivery error.
    service.recordCheck({ at: '2026-11-22T01:01:00.000Z', error: null })
    expect(service.getStatus().lastDeliveryError).toBeNull()
    expect(service.getStatus().lastScheduleError).toContain('任务计划服务不可用')
  })

  it('writes status only for supported Windows packaged builds', async () => {
    const executor = { run: vi.fn() } satisfies PowerShellExecutor
    const service = new SystemReminderService({
      dataDir: tempDir(),
      executablePath: 'C:\\StudyNext.exe',
      platform: 'linux',
      packaged: true,
      executor
    })
    const status = await service.initialize()
    expect(status.supported).toBe(false)
    expect(executor.run).not.toHaveBeenCalled()
  })

  it('queries, registers and removes a one-shot task through the injected executor', async () => {
    const dataDir = tempDir()
    const calls: string[] = []
    const executor: PowerShellExecutor = {
      run: vi.fn(async (script: string) => {
        if (script.includes('Unregister-ScheduledTask')) {
          calls.push('remove')
          return { stdout: '{"removed":true}', stderr: '' }
        }
        if (script.includes('Register-ScheduledTask')) {
          calls.push('register')
          return {
            stdout:
              '{"exists":true,"execute":"C:\\\\StudyNext.exe","arguments":"--check-reminders",' +
              '"nextRunAt":"2026-11-22T02:00:02.000Z","lastRunAt":null,"lastTaskResult":0}',
            stderr: ''
          }
        }
        calls.push('query')
        return {
          stdout:
            '{"exists":true,"execute":"C:\\\\StudyNext.exe","arguments":"--check-reminders","nextRunAt":"2026-11-22T02:00:02.000Z","lastRunAt":null,"lastTaskResult":0}',
          stderr: ''
        }
      })
    }
    const service = new SystemReminderService({
      dataDir,
      executablePath: 'C:\\StudyNext.exe',
      taskName: 'StudyNext-DDL-test',
      platform: 'win32',
      packaged: true,
      executor,
      now: () => new Date('2026-11-22T01:00:00.000Z')
    })
    expect((await service.initialize()).registered).toBe(true)
    const status = await service.syncNextTrigger({
      enabled: true,
      nextRunAt: '2026-11-22T03:00:00.000Z'
    })
    expect(status.registered).toBe(true)
    expect(status.nextRunAt).toBe('2026-11-22T02:00:02.000Z')
    expect(calls).toContain('register')
    expect(readFileSync(join(dataDir, 'notification-system.json'), 'utf8')).toContain(
      '"registered": true'
    )
    const repaired = await service.repair({
      enabled: true,
      nextRunAt: '2026-11-22T03:00:00.000Z'
    })
    expect(repaired.registered).toBe(true)
    expect(calls.filter((item) => item === 'register').length).toBeGreaterThanOrEqual(2)
  })
})
