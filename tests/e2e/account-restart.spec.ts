import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, expect, test, _electron as electron } from '@playwright/test'

const ROOT = process.cwd()
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-account-restart-e2e-'))
const ACCOUNT_A = 'restart-account-a'
const ACCOUNT_B = 'restart-account-b'
const ELECTRON_BIN = join(
  ROOT,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)

let child: ChildProcess | null = null
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null

function terminateTestApp(): void {
  if (process.platform !== 'win32') {
    child?.kill()
    return
  }
  const needle = DATA_DIR.replace(/'/g, "''")
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      ],
      { stdio: 'ignore' }
    )
  } catch {
    child?.kill()
  }
}

function baseEnv(noRelaunch = false): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
  env.STUDYNEXT_DATA_DIR = DATA_DIR
  env.STUDYNEXT_TEST_NO_RELAUNCH = noRelaunch ? '1' : '0'
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

async function waitForCdp(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return
    } catch {
      // Electron is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`CDP endpoint did not become ready on port ${port}`)
}

async function waitForExit(
  processHandle: ChildProcess,
  timeoutMs = 30_000
): Promise<number | null> {
  if (processHandle.exitCode !== null) return processHandle.exitCode
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Electron process did not exit')), timeoutMs)
    processHandle.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

async function connectPage(port: number) {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const context = browser.contexts()[0]
  if (!context) throw new Error('CDP browser has no default context')
  const page = context.pages()[0] ?? (await context.waitForEvent('page'))
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 25_000 })
  return page
}

test.afterAll(async () => {
  await browser?.close().catch(() => undefined)
  terminateTestApp()
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('生产切换路径会真实重启并加载目标账号工作区', async () => {
  test.setTimeout(120_000)
  const setup = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${DATA_DIR}`],
    cwd: ROOT,
    env: baseEnv(true)
  })
  const setupPage = await setup.firstWindow()
  await setupPage.waitForLoadState('domcontentloaded')
  const encrypted = await setup.evaluate(
    ({ safeStorage }, payload) => {
      return safeStorage.encryptString(JSON.stringify(payload)).toString('base64')
    },
    {
      version: 2,
      activeId: ACCOUNT_A,
      accounts: [
        { id: ACCOUNT_A, username: 'a@example.invalid', password: 'a', platformUid: '10000001' },
        { id: ACCOUNT_B, username: 'b@example.invalid', password: 'b', platformUid: '10000002' }
      ]
    }
  )
  writeFileSync(join(DATA_DIR, 'chaoxing-credentials.enc'), Buffer.from(encrypted, 'base64'))
  await setup.close()

  const port = 9460 + Math.floor(Math.random() * 200)
  child = spawn(
    ELECTRON_BIN,
    [
      '.',
      '--no-sandbox',
      '--disable-gpu',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${DATA_DIR}`
    ],
    { cwd: ROOT, env: baseEnv(false), stdio: 'ignore' }
  )
  await waitForCdp(port)
  const page = await connectPage(port)
  const before = await page.evaluate(() => window.studynext.bootstrap())
  expect(before.appInfo.workspace.mode).toBe('account')
  expect(before.appInfo.workspace.accountId).toBe(ACCOUNT_A)

  await page.evaluate(async () => {
    await window.studynext.tasks.create({
      title: 'restart-A-only-task',
      description: '',
      courseId: null,
      priority: 'medium',
      kind: 'homework',
      dueAt: '2030-01-01T00:00:00.000Z',
      reminderOffsets: []
    })
  })

  const oldExit = waitForExit(child)
  await page
    .evaluate((id) => window.studynext.chaoxing.activateAccount(id), ACCOUNT_B)
    .catch(() => undefined)
  await oldExit
  await waitForCdp(port, 45_000)

  await browser?.close().catch(() => undefined)
  browser = null
  const reloaded = await connectPage(port)
  const after = await reloaded.evaluate(() => window.studynext.bootstrap())
  expect(after.appInfo.workspace.mode).toBe('account')
  expect(after.appInfo.workspace.accountId).toBe(ACCOUNT_B)
  expect(after.tasks.some((task: { title: string }) => task.title === 'restart-A-only-task')).toBe(
    false
  )
  expect(child.exitCode).not.toBeNull()
})
