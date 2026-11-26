import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { StudyNextStore } from '../../src/main/storage/store'
import type { StudyNextApi } from '../../src/shared/types'

declare global {
  interface Window {
    studynext: StudyNextApi
  }
}

const ROOT = process.cwd()
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-legacy-readonly-e2e-'))
const LEGACY = join(DATA_DIR, 'studynext.sqlite')
const KEEP_FILE = join(DATA_DIR, 'keep-download.pdf')

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

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('只读历史工作区可启动、可读、不删除下载文件且拒绝写入', async () => {
  const setup = new StudyNextStore(LEGACY)
  setup.createTask({
    title: '历史只读任务',
    description: '历史数据',
    courseId: null,
    priority: 'medium',
    kind: 'homework',
    dueAt: '2030-01-01T00:00:00.000Z',
    reminderOffsets: [30]
  })
  writeFileSync(KEEP_FILE, 'history download must survive')
  setup.upsertDownload({
    id: 'history-download',
    filename: 'keep-download.pdf',
    url: 'https://example.invalid/keep-download.pdf',
    state: 'progressing',
    receivedBytes: 3,
    totalBytes: 10,
    startedAt: '2026-11-16T10:00:00.000Z',
    completedAt: null,
    savePath: KEEP_FILE
  })
  setup.close()
  const beforeHash = createHash('sha256').update(readFileSync(LEGACY)).digest('hex')
  const beforeSize = readFileSync(LEGACY).length

  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${DATA_DIR}`],
    cwd: ROOT,
    env: launchEnv()
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })

  const bootstrap = await page.evaluate(() => window.studynext.bootstrap())
  expect(bootstrap.appInfo.workspace.mode).toBe('readonly')
  expect(bootstrap.tasks.some((task) => task.title === '历史只读任务')).toBe(true)

  const error = await page.evaluate(async () => {
    try {
      await window.studynext.tasks.create({
        title: '禁止写入',
        description: '',
        courseId: null,
        priority: 'low',
        kind: 'homework',
        dueAt: '2030-01-01T00:00:00.000Z',
        reminderOffsets: []
      })
      return null
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }
  })
  expect(error).toMatch(/只读|READ_ONLY|WORKSPACE_READ_ONLY/)

  expect(existsSync(KEEP_FILE)).toBe(true)
  expect(readFileSync(KEEP_FILE, 'utf8')).toBe('history download must survive')
  const after = readFileSync(LEGACY)
  expect(after.length).toBe(beforeSize)
  expect(createHash('sha256').update(after).digest('hex')).toBe(beforeHash)
})
