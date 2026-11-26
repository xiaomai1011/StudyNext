import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'

const ROOT = process.cwd()
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-modal-focus-'))
let app: ElectronApplication
let page: Page

async function launch(): Promise<void> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
  env.STUDYNEXT_DATA_DIR = DATA_DIR
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${DATA_DIR}`],
    cwd: ROOT,
    env
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })
}

async function openTasks(): Promise<void> {
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: /作业/ })
    .click()
  await expect(page.getByRole('heading', { name: '作业', exact: true })).toBeVisible()
}

test.describe('公共 Modal 焦点治理', () => {
  test.beforeAll(async () => {
    await launch()
    await openTasks()
  })

  test.afterAll(async () => {
    await app.close()
    rmSync(DATA_DIR, { recursive: true, force: true })
  })

  test('打开后聚焦标题输入，Tab 在弹窗内循环并隔离背景', async () => {
    const trigger = page.getByRole('button', { name: '新建任务' }).first()
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '新建任务' })
    await expect(dialog).toBeVisible()

    const title = dialog.getByPlaceholder('例如：完成第 3 章在线作业')
    await expect(title).toBeFocused()
    expect(await page.locator('#root').evaluate((element) => element.hasAttribute('inert'))).toBe(
      true
    )

    const close = dialog.getByRole('button', { name: '关闭' })
    const create = dialog.getByRole('button', { name: '创建任务' })
    await create.focus()
    await page.keyboard.press('Tab')
    await expect(close).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(create).toBeFocused()

    await page
      .locator('.nav-item')
      .first()
      .evaluate((element) => (element as HTMLElement).focus())
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    expect(await page.locator('#root').evaluate((element) => element.hasAttribute('inert'))).toBe(
      false
    )
  })

  test('嵌套确认弹窗只关闭最上层并恢复上一层焦点', async () => {
    const trigger = page.getByRole('button', { name: '新建任务' }).first()
    await trigger.click()
    const editor = page.getByRole('dialog', { name: '新建任务' })
    await editor.getByPlaceholder('例如：完成第 3 章在线作业').fill('未保存的焦点测试')
    const close = editor.getByRole('button', { name: '关闭' })
    await close.click()

    const confirm = page.getByRole('dialog', { name: '放弃未保存的修改？' })
    await expect(confirm).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(2)

    await page.keyboard.press('Escape')
    await expect(confirm).toHaveCount(0)
    await expect(editor).toBeVisible()
    await expect(close).toBeFocused()

    await close.click()
    await page.getByRole('button', { name: '放弃修改' }).click()
    await expect(editor).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })
})
