import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import electronPath from 'electron'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'

const ROOT = process.cwd()
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-activation-'))
const TASK_TITLE = '激活测试任务'
const SECOND_TITLE = '激活测试任务二'
let app: ElectronApplication | null = null
let page: Page | null = null

function env(): Record<string, string> {
  const result: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
  result.STUDYNEXT_DATA_DIR = DATA_DIR
  delete result.ELECTRON_RUN_AS_NODE
  return result
}

async function launch(extraArgs: string[] = []): Promise<void> {
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${DATA_DIR}`, ...extraArgs],
    cwd: ROOT,
    env: env()
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })
}

async function close(): Promise<void> {
  await app?.close().catch(() => undefined)
  app = null
  page = null
}

async function createTask(title: string): Promise<string> {
  if (!page) throw new Error('page unavailable')
  return page.evaluate(async (taskTitle) => {
    const windowApi = (
      window as unknown as {
        studynext: {
          tasks: {
            create: (input: unknown) => Promise<{ id: string }>
          }
        }
      }
    ).studynext
    const task = await windowApi.tasks.create({
      title: taskTitle,
      description: '',
      courseId: null,
      priority: 'medium',
      kind: 'homework',
      dueAt: '2030-06-01T14:00:00.000Z',
      reminderOffsets: [60]
    })
    return task.id
  }, title)
}

async function expectFocusedTask(title: string): Promise<void> {
  if (!page) throw new Error('page unavailable')
  await expect(page.locator('.b2-detail-title')).toHaveText(title)
}

async function spawnSecondInstance(extraArgs: string[]): Promise<number> {
  const child = spawn(
    electronPath as unknown as string,
    ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${DATA_DIR}`, ...extraArgs],
    { cwd: ROOT, env: env(), stdio: 'ignore', windowsHide: true }
  )
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('second instance did not exit'))
    }, 20_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code ?? 0)
    })
  })
}

test.afterAll(async () => {
  await close()
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('启动参数激活、单实例转发和缺失任务降级', async () => {
  await launch()
  const taskId = await createTask(TASK_TITLE)
  const secondId = await createTask(SECOND_TITLE)
  await app?.close()
  app = null
  page = null

  await launch(['--focus-task', taskId])
  await expectFocusedTask(TASK_TITLE)

  if (process.platform === 'win32') {
    const command = execFileSync(
      'reg.exe',
      ['query', 'HKCU\\Software\\Classes\\studynext\\shell\\open\\command', '/ve'],
      { encoding: 'utf8', windowsHide: true }
    )
    expect(command.toLowerCase()).toContain('electron.exe')
    expect(command).toContain('studynext')
  }

  const secondExit = await spawnSecondInstance(['--focus-task', secondId])
  expect(secondExit).toBe(0)
  await expectFocusedTask(SECOND_TITLE)

  const protocolExit = await spawnSecondInstance([`studynext://task/${encodeURIComponent(taskId)}`])
  expect(protocolExit).toBe(0)
  await expectFocusedTask(TASK_TITLE)

  await close()
  await launch(['--focus-task', 'missing-task-id'])
  const activePage = page as Page | null
  if (!activePage) throw new Error('page unavailable')
  await expect(activePage.getByText('这条提醒对应的任务已删除或不存在')).toBeVisible()
  await expect(activePage.locator('.b2-detail-title')).toHaveCount(0)
})
