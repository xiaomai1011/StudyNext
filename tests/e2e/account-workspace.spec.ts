import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import type { StudyNextApi } from '../../src/shared/types'

declare global {
  interface Window {
    studynext: StudyNextApi
  }
}

const ROOT = process.cwd()
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-account-e2e-'))
const ACCOUNT_A = 'test-account-a'
const ACCOUNT_B = 'test-account-b'

let app: ElectronApplication
let page: Page

function launchEnv(): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
  env.STUDYNEXT_DATA_DIR = DATA_DIR
  env.STUDYNEXT_TEST_NO_RELAUNCH = '1'
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${DATA_DIR}`],
    cwd: ROOT,
    env: launchEnv()
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })
}

async function close(): Promise<void> {
  await app?.close().catch(() => undefined)
}

test.afterAll(async () => {
  await close()
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('真实主进程生命周期：A→B→A 切换后加载各自工作区', async () => {
  await launch()
  expect(await page.evaluate(() => window.studynext.bootstrap())).toMatchObject({
    appInfo: { workspace: { mode: 'local' } }
  })

  const encrypted = await app.evaluate(
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
  await close()

  await launch()
  let bootstrap = await page.evaluate(() => window.studynext.bootstrap())
  expect(bootstrap.appInfo.workspace.mode).toBe('account')
  expect(bootstrap.appInfo.workspace.accountId).toBe(ACCOUNT_A)
  await page.evaluate(async () => {
    await window.studynext.tasks.create({
      title: 'A 涓撳睘浠诲姟',
      description: '',
      courseId: null,
      priority: 'medium',
      kind: 'homework',
      dueAt: '2030-01-01T00:00:00.000Z',
      reminderOffsets: []
    })
  })

  await page.evaluate((id) => window.studynext.chaoxing.activateAccount(id), ACCOUNT_B)
  await close()

  await launch()
  bootstrap = await page.evaluate(() => window.studynext.bootstrap())
  expect(bootstrap.appInfo.workspace.mode).toBe('account')
  expect(bootstrap.appInfo.workspace.accountId).toBe(ACCOUNT_B)
  expect(bootstrap.tasks.some((task: { title: string }) => task.title === 'A 涓撳睘浠诲姟')).toBe(
    false
  )
  await page.evaluate(async () => {
    await window.studynext.tasks.create({
      title: 'B 涓撳睘浠诲姟',
      description: '',
      courseId: null,
      priority: 'medium',
      kind: 'homework',
      dueAt: '2030-01-01T00:00:00.000Z',
      reminderOffsets: []
    })
  })

  await page.evaluate((id) => window.studynext.chaoxing.activateAccount(id), ACCOUNT_A)
  await close()

  await launch()
  bootstrap = await page.evaluate(() => window.studynext.bootstrap())
  expect(bootstrap.appInfo.workspace.accountId).toBe(ACCOUNT_A)
  expect(bootstrap.tasks.some((task: { title: string }) => task.title === 'A 涓撳睘浠诲姟')).toBe(
    true
  )
  expect(bootstrap.tasks.some((task: { title: string }) => task.title === 'B 涓撳睘浠诲姟')).toBe(
    false
  )
})
