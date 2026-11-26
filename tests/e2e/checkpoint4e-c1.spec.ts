import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'

const ROOT = process.cwd()
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-4e-c1-'))
const DB_PATH = join(DATA_DIR, 'workspaces', 'local.sqlite')
let app: ElectronApplication
let page: Page

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`等待数据库超时：${path}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

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

async function openSettings(): Promise<void> {
  await page.locator('button[aria-label="设置"]').click()
  await expect(page.getByRole('heading', { name: '偏好与数据' })).toBeVisible()
  await page.locator('.main-scroll').evaluate((element) => {
    element.scrollTop = 0
  })
}

async function expectActive(label: string): Promise<void> {
  const nav = page.locator('.settings-nav')
  const item = nav.getByRole('button', { name: label, exact: true })
  await expect(item).toHaveAttribute('aria-current', 'location')
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  await launch()
  await waitForFile(DB_PATH)
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(DATA_DIR, { recursive: true, force: true })
})

test('六个 section 常驻，点击导航滚动并同步 active 状态', async () => {
  await openSettings()
  const nav = page.locator('.settings-nav')
  for (const label of ['外观', '应用行为', 'DDL 提醒', '学习通与同步', '手动导入', '数据与关于']) {
    await expect(nav.getByRole('button', { name: label, exact: true })).toHaveAttribute(
      'aria-controls',
      /settings-/
    )
  }
  await expect(page.locator('.settings-section')).toHaveCount(6)
  await expectActive('外观')

  await nav.getByRole('button', { name: '学习通与同步', exact: true }).click()
  await expectActive('学习通与同步')
  await expect
    .poll(async () =>
      page.locator('#settings-portal').evaluate((element) => {
        const container = element.closest('.main-scroll')
        if (!container) return Number.POSITIVE_INFINITY
        return element.getBoundingClientRect().top - container.getBoundingClientRect().top
      })
    )
    .toBeLessThan(20)

  await nav.getByRole('button', { name: '数据与关于', exact: true }).click()
  await expectActive('数据与关于')
  await expect
    .poll(async () =>
      page
        .locator('.main-scroll')
        .evaluate((element) =>
          Math.abs(element.scrollTop + element.clientHeight - element.scrollHeight)
        )
    )
    .toBeLessThan(3)
})

test('导航不卸载 section，未保存表单值和 DOM 节点保持', async () => {
  await openSettings()
  const nav = page.locator('.settings-nav')
  await nav.getByRole('button', { name: '学习通与同步', exact: true }).click()
  const sso = page.locator('#sso-domains')
  await sso.fill('sso.c1.example.test')
  await sso.evaluate((element) => element.setAttribute('data-c1-probe', 'kept'))
  const fileInput = page.locator('#settings-import input[type=file]').first()
  await fileInput.evaluate((element) => element.setAttribute('data-c1-file', 'kept'))
  await page.evaluate(() => {
    ;(window as Window & { __c1FileInput?: Element | null }).__c1FileInput = document.querySelector(
      '#settings-import input[type=file]'
    )
  })

  await nav.getByRole('button', { name: '外观', exact: true }).click()
  await nav.getByRole('button', { name: '学习通与同步', exact: true }).click()
  await expect(sso).toHaveValue('sso.c1.example.test')
  await expect(sso).toHaveAttribute('data-c1-probe', 'kept')
  await expect(fileInput).toHaveAttribute('data-c1-file', 'kept')
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __c1FileInput?: Element | null }).__c1FileInput ===
        document.querySelector('#settings-import input[type=file]')
    )
  ).toBe(true)
})

test('键盘激活导航，900px 横向导航保持 active 可见且无页面横向溢出', async () => {
  await page.setViewportSize({ width: 900, height: 900 })
  await openSettings()
  const nav = page.locator('.settings-nav')
  const dataButton = nav.getByRole('button', { name: '数据与关于', exact: true })
  await dataButton.focus()
  await expect(dataButton).toBeFocused()
  await page.keyboard.press('Enter')
  await expectActive('数据与关于')

  const navBox = await nav.boundingBox()
  const itemBox = await dataButton.boundingBox()
  expect(navBox).not.toBeNull()
  expect(itemBox).not.toBeNull()
  if (navBox && itemBox) {
    expect(itemBox.x).toBeGreaterThanOrEqual(navBox.x - 1)
    expect(itemBox.x + itemBox.width).toBeLessThanOrEqual(navBox.x + navBox.width + 1)
  }
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    navOverflowX: getComputedStyle(document.querySelector<HTMLElement>('.settings-nav')!).overflowX
  }))
  expect(overflow.page).toBeLessThanOrEqual(1)
  expect(overflow.navOverflowX).toBe('auto')
})

test('宽屏切换至 900px 后 active 导航保持完整可见', async () => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openSettings()
  const nav = page.locator('.settings-nav')
  await nav.getByRole('button', { name: '数据与关于', exact: true }).click()
  await expectActive('数据与关于')
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })

  await page.setViewportSize({ width: 900, height: 900 })
  await expectActive('数据与关于')
  const overflow = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('.settings-nav')
    const active = element?.querySelector<HTMLElement>('[aria-current="location"]')
    if (!element || !active) return Number.POSITIVE_INFINITY
    const navRect = element.getBoundingClientRect()
    const itemRect = active.getBoundingClientRect()
    return Math.max(navRect.left - itemRect.left, itemRect.right - navRect.right)
  })
  expect(overflow).toBeLessThanOrEqual(1)
})

test('手动滚动更新 active，顶部和底部边界正确', async () => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openSettings()
  await page.locator('.main-scroll').evaluate((element) => {
    const section = document.getElementById('settings-behavior')
    if (!section) return
    const containerTop = element.getBoundingClientRect().top
    element.scrollTop += section.getBoundingClientRect().top - containerTop + 2
  })
  await expectActive('应用行为')

  await page.locator('.main-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expectActive('数据与关于')

  await page.locator('.main-scroll').evaluate((element) => {
    element.scrollTop = 0
  })
  await expectActive('外观')
})
