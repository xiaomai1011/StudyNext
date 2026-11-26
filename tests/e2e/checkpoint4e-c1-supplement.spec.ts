import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'

const ROOT = process.cwd()
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-4e-c1-supp-'))
const DB_PATH = join(DATA_DIR, 'workspaces', 'local.sqlite')
const SCREENSHOTS = join(ROOT, 'docs', 'screenshots', 'v0.5')
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
  await expect(
    page.locator('.settings-nav').getByRole('button', { name: label, exact: true })
  ).toHaveAttribute('aria-current', 'location')
}

async function setTheme(mode: 'light' | 'dark'): Promise<void> {
  await page.locator(`.theme-option.${mode}`).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(mode)
}

async function setContentSizeAndZoom(width: number, height: number, factor: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, next) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error('窗口不存在')
      win.setContentSize(next.width, next.height)
      win.webContents.setZoomFactor(next.factor)
    },
    { width, height, factor }
  )
}

async function setContentSize(width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, next) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error('窗口不存在')
      win.setContentSize(next.width, next.height)
    },
    { width, height }
  )
}

async function captureWindow(path: string): Promise<void> {
  const encoded = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('窗口不存在')
    const image = await win.webContents.capturePage()
    return image.toPNG().toString('base64')
  })
  writeFileSync(path, Buffer.from(encoded, 'base64'))
}

async function waitForScrollSettled(): Promise<void> {
  let last = Number.NaN
  let stable = 0
  for (let i = 0; i < 60; i += 1) {
    const current = await page.locator('.main-scroll').evaluate((element) => element.scrollTop)
    if (Math.abs(current - last) < 0.5) stable += 1
    else stable = 0
    if (stable >= 4) return
    last = current
    await page.waitForTimeout(50)
  }
  throw new Error('设置页滚动未在预期时间内稳定')
}

type SettingsGeometrySnapshot = {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
  activationOffset: number
  activeId: string | null
  expectedId: string
  sections: Array<{ id: string; top: number; bottom: number }>
}

async function readSettingsGeometry(): Promise<SettingsGeometrySnapshot> {
  return page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('.main-scroll')
    const nav = document.querySelector<HTMLElement>('.settings-nav')
    if (!container) throw new Error('缺少 .main-scroll')

    const sections = Array.from(document.querySelectorAll<HTMLElement>('.settings-section'))
    if (sections.length === 0) throw new Error('缺少 settings-section')
    const containerRect = container.getBoundingClientRect()
    const activationOffset = window.matchMedia('(max-width: 901px)').matches
      ? (nav?.getBoundingClientRect().height ?? 0) + 12
      : 12
    const items = sections.map((section) => {
      const rect = section.getBoundingClientRect()
      return {
        id: section.id,
        top: rect.top - containerRect.top,
        bottom: rect.bottom - containerRect.top
      }
    })
    const atTop = container.scrollTop <= 2
    const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 2
    const firstItem = items[0]
    const lastItem = items[items.length - 1]
    if (!firstItem || !lastItem) throw new Error('设置 section 为空')
    let expectedId = firstItem.id
    if (atBottom) expectedId = lastItem.id
    else if (!atTop) {
      for (const item of items) {
        if (item.top <= activationOffset) expectedId = item.id
      }
    }
    const activeId =
      nav
        ?.querySelector<HTMLElement>('[aria-current="location"]')
        ?.getAttribute('data-settings-nav') ?? null

    return {
      scrollTop: container.scrollTop,
      clientHeight: container.clientHeight,
      scrollHeight: container.scrollHeight,
      activationOffset,
      activeId,
      expectedId,
      sections: items
    }
  })
}

async function targetScrollFor(id: string): Promise<number> {
  const geometry = await readSettingsGeometry()
  const section = geometry.sections.find((item) => item.id === id)
  if (!section) throw new Error(`找不到 section：${id}`)
  const max = Math.max(0, geometry.scrollHeight - geometry.clientHeight)
  return Math.min(
    max,
    Math.max(0, section.top + geometry.scrollTop - geometry.activationOffset + 2)
  )
}

async function waitForSectionAtActivation(id: string, allowMaxScroll = false): Promise<void> {
  await expect
    .poll(
      async () => {
        const geometry = await readSettingsGeometry()
        const target = await targetScrollFor(id)
        const max = Math.max(0, geometry.scrollHeight - geometry.clientHeight)
        return (
          Math.abs(geometry.scrollTop - target) <= 3 ||
          (allowMaxScroll && Math.abs(geometry.scrollTop - max) <= 2)
        )
      },
      { timeout: 6_000 }
    )
    .toBe(true)
  await waitForScrollSettled()
}

async function waitForActiveId(id: string): Promise<void> {
  await expect
    .poll(async () => (await readSettingsGeometry()).activeId, { timeout: 6_000 })
    .toBe(id)
}

async function waitForStableActiveId(id: string, stableFrames = 8): Promise<void> {
  await page.evaluate(
    async ({ id: expected, frames }) => {
      let streak = 0
      for (let frame = 0; frame < 180; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        const active = document.querySelector<HTMLElement>(
          '.settings-nav-item[aria-current="location"]'
        )?.dataset.settingsNav
        streak = active === expected ? streak + 1 : 0
        if (streak >= frames) return
      }
    },
    { id, frames: stableFrames }
  )
}

type InlineSectionSnapshot = {
  paddingBottom: string
  overflowAnchor: string
}

async function expandSection(id: string, height: number): Promise<InlineSectionSnapshot> {
  return page.evaluate(
    ({ id: sectionId, height: nextHeight }) => {
      const container = document.querySelector<HTMLElement>('.main-scroll')
      const section = document.getElementById(sectionId)
      if (!container || !section) throw new Error(`缺少 section：${sectionId}`)
      const snapshot = {
        paddingBottom: section.style.paddingBottom,
        overflowAnchor: container.style.overflowAnchor
      }
      container.style.overflowAnchor = 'none'
      section.style.paddingBottom = `${nextHeight}px`
      return snapshot
    },
    { id, height }
  )
}

async function restoreSection(id: string, snapshot: InlineSectionSnapshot): Promise<void> {
  await page.evaluate(
    ({ id: sectionId, previous }) => {
      const container = document.querySelector<HTMLElement>('.main-scroll')
      const section = document.getElementById(sectionId)
      if (!container || !section) throw new Error(`缺少 section：${sectionId}`)
      section.style.paddingBottom = previous.paddingBottom
      container.style.overflowAnchor = previous.overflowAnchor
    },
    { id, previous: snapshot }
  )
}

async function resetSettingsView(): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1)
  })
  await setContentSize(1280, 900)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const nav = page.getByRole('navigation', { name: '主导航' })
  await nav.getByRole('button', { name: '今天', exact: true }).click()
  await expect(page.locator('.studio-today')).toBeVisible()
  await openSettings()
}

async function activeNavOverflow(): Promise<number> {
  return page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('.settings-nav')
    const active = nav?.querySelector<HTMLElement>('[aria-current="location"]')
    if (!nav || !active) return Number.POSITIVE_INFINITY
    const navRect = nav.getBoundingClientRect()
    const itemRect = active.getBoundingClientRect()
    return Math.max(navRect.left - itemRect.left, itemRect.right - navRect.right)
  })
}

test.describe.configure({ mode: 'default' })

test.beforeAll(async () => {
  await launch()
  await waitForFile(DB_PATH)
  await openSettings()
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  rmSync(DATA_DIR, { recursive: true, force: true })
})

test('真实 125%/150% 缩放：布局、active 可见性和 Light/Dark 截图', async () => {
  await setTheme('light')
  await setContentSize(1280, 900)
  await openSettings()
  const baseDpr = await page.evaluate(() => window.devicePixelRatio)
  await page
    .locator('.settings-nav')
    .getByRole('button', { name: '学习通与同步', exact: true })
    .click()
  await expectActive('学习通与同步')

  await setContentSizeAndZoom(1600, 1000, 1.25)
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1280)
  const metrics125 = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    dpr: window.devicePixelRatio,
    zoom: window.visualViewport?.scale ?? null,
    navOverflow: document.querySelector<HTMLElement>('.settings-nav')?.scrollWidth ?? 0
  }))
  expect(metrics125.innerWidth).toBe(1280)
  expect(metrics125.dpr).toBeCloseTo(baseDpr * 1.25, 2)
  expect(await activeNavOverflow()).toBeLessThanOrEqual(1)
  await waitForScrollSettled()
  await captureWindow(join(SCREENSHOTS, 'v050-4ec1-zoom-125-light.png'))

  await setTheme('dark')
  await page
    .locator('.settings-nav')
    .getByRole('button', { name: '数据与关于', exact: true })
    .click()
  await expectActive('数据与关于')
  expect(await activeNavOverflow()).toBeLessThanOrEqual(1)
  await waitForScrollSettled()
  await captureWindow(join(SCREENSHOTS, 'v050-4ec1-zoom-125-dark.png'))

  await setContentSizeAndZoom(1350, 900, 1.5)
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(900)
  await page
    .locator('.settings-nav')
    .getByRole('button', { name: '数据与关于', exact: true })
    .click()
  await expectActive('数据与关于')
  const metrics150 = await page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('.settings-nav')!
    const content = document.querySelector<HTMLElement>('.settings-content')!
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
      zoom: window.visualViewport?.scale ?? null,
      matchNarrow: window.matchMedia('(max-width: 901px)').matches,
      navOverflow: getComputedStyle(nav).overflowX,
      navPosition: getComputedStyle(nav).position,
      navWidth: nav.getBoundingClientRect().width,
      contentWidth: content.getBoundingClientRect().width,
      docClient: document.documentElement.clientWidth,
      docScroll: document.documentElement.scrollWidth,
      bodyScroll: document.body.scrollWidth,
      outerWidth: window.outerWidth,
      screenWidth: window.screen.width,
      visualWidth: window.visualViewport?.width ?? null,
      mainScrollWidth: document.querySelector<HTMLElement>('.main-scroll')?.scrollWidth ?? null,
      mainClientWidth: document.querySelector<HTMLElement>('.main-scroll')?.clientWidth ?? null,
      layoutScrollWidth:
        document.querySelector<HTMLElement>('.settings-layout')?.scrollWidth ?? null,
      navScrollLeft: nav.scrollLeft,
      navDirection: getComputedStyle(nav).flexDirection,
      navItems: Array.from(nav.querySelectorAll<HTMLButtonElement>('button')).map((button) => {
        const rect = button.getBoundingClientRect()
        return {
          text: button.textContent?.trim() ?? '',
          left: rect.left,
          width: rect.width
        }
      })
    }
  })
  expect(metrics150.innerWidth).toBe(900)
  expect(metrics150.dpr).toBeCloseTo(baseDpr * 1.5, 2)
  expect(metrics150.matchNarrow).toBe(true)
  expect(metrics150.navDirection).toBe('row')
  expect(metrics150.docScroll).toBeLessThanOrEqual(metrics150.docClient)
  expect(metrics150.mainScrollWidth).toBeLessThanOrEqual(metrics150.mainClientWidth!)
  expect(await activeNavOverflow()).toBeLessThanOrEqual(1)
  await waitForScrollSettled()
  await captureWindow(join(SCREENSHOTS, 'v050-4ec1-zoom-150-dark.png'))

  await setTheme('light')
  await page
    .locator('.settings-nav')
    .getByRole('button', { name: '数据与关于', exact: true })
    .click()
  await expectActive('数据与关于')
  expect(await activeNavOverflow()).toBeLessThanOrEqual(1)
  await waitForScrollSettled()
  await captureWindow(join(SCREENSHOTS, 'v050-4ec1-zoom-150-light.png'))

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1)
  })
  await setContentSize(1280, 900)
})

test('导入结果和同步事件跨导航保持；文件 input 按现有行为清空', async () => {
  await resetSettingsView()
  const nav = page.locator('.settings-nav')
  await nav.getByRole('button', { name: '手动导入', exact: true }).click()

  const fixture = join(DATA_DIR, 'c1-supplement.csv')
  writeFileSync(
    fixture,
    '标题,截止时间,所属课程,优先级,类型\nC1 补充导入,2026-12-20 18:00,C1 补充课程,中,作业',
    'utf8'
  )
  const input = page.locator('#settings-import input[type=file]').first()
  await input.setInputFiles(fixture)
  await expect(page.locator('#settings-import .import-result')).toContainText(
    '已导入 1 个任务、1 门新课程'
  )
  await expect(input).toHaveValue('')
  expect(await input.evaluate((element) => (element as HTMLInputElement).files?.length)).toBe(0)
  await page.evaluate(() => {
    ;(window as Window & { __c1ImportInput?: Element | null }).__c1ImportInput =
      document.querySelector('#settings-import input[type=file]')
  })

  await nav.getByRole('button', { name: '学习通与同步', exact: true }).click()
  await nav.getByRole('button', { name: '手动导入', exact: true }).click()
  await expect(page.locator('#settings-import .import-result')).toContainText(
    '已导入 1 个任务、1 门新课程'
  )
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __c1ImportInput?: Element | null }).__c1ImportInput ===
        document.querySelector('#settings-import input[type=file]')
    )
  ).toBe(true)

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('chaoxing:sync-progress', {
      phase: 'homework',
      message: 'C1 模拟同步',
      current: 1,
      total: 3
    })
  })
  await nav.getByRole('button', { name: '学习通与同步', exact: true }).click()
  await expect(page.locator('.chaoxing-progress')).toContainText('C1 模拟同步')
  await expect(page.locator('.chaoxing-progress')).toContainText('1/3')
  await nav.getByRole('button', { name: '外观', exact: true }).click()
  await nav.getByRole('button', { name: '学习通与同步', exact: true }).click()
  await expect(page.locator('.chaoxing-progress')).toContainText('C1 模拟同步')
})

test('首次平滑滚动到达目标并保持 active 与几何位置一致', async () => {
  await resetSettingsView()
  const nav = page.locator('.settings-nav')

  await nav.getByRole('button', { name: '学习通与同步', exact: true }).click()
  await waitForSectionAtActivation('settings-portal')
  const geometry = await readSettingsGeometry()

  expect(geometry.activeId).toBe('settings-portal')
  expect(geometry.expectedId).toBe('settings-portal')
  expect(
    Math.abs(geometry.scrollTop - (await targetScrollFor('settings-portal')))
  ).toBeLessThanOrEqual(3)
})

test('重复点击后 Scroll-spy 仍能响应布局变化', async () => {
  await resetSettingsView()
  const nav = page.locator('.settings-nav')

  await nav.getByRole('button', { name: '应用行为', exact: true }).click()
  await waitForSectionAtActivation('settings-behavior')
  const before = await readSettingsGeometry()
  expect(before.activeId).toBe('settings-behavior')

  await nav.getByRole('button', { name: '应用行为', exact: true }).click()
  await expectActive('应用行为')
  const afterSecondClick = await readSettingsGeometry()
  expect(Math.abs(afterSecondClick.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1)

  const snapshot = await expandSection('settings-appearance', 600)
  try {
    await waitForActiveId('settings-appearance')
    const afterLayout = await readSettingsGeometry()
    expect(afterLayout.expectedId).toBe('settings-appearance')
    expect(Math.abs(afterLayout.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1)
  } finally {
    await restoreSection('settings-appearance', snapshot)
  }

  await nav.getByRole('button', { name: '学习通与同步', exact: true }).click()
  await nav.getByRole('button', { name: '手动导入', exact: true }).click()
  await nav.getByRole('button', { name: '数据与关于', exact: true }).click()
  await expectActive('数据与关于')
  await waitForSectionAtActivation('settings-about', true)

  const beforeSettings = await page.evaluate(() =>
    window.studynext.bootstrap().then((data) => data.settings)
  )
  await nav.getByRole('button', { name: '外观', exact: true }).click()
  await nav.getByRole('button', { name: '学习通与同步', exact: true }).click()
  await nav.getByRole('button', { name: '数据与关于', exact: true }).click()
  const afterSettings = await page.evaluate(() =>
    window.studynext.bootstrap().then((data) => data.settings)
  )
  expect(afterSettings).toEqual(beforeSettings)
})

test('末节在最大滚动位置重复点击后仍能响应布局变化', async () => {
  await resetSettingsView()
  const nav = page.locator('.settings-nav')

  await nav.getByRole('button', { name: '数据与关于', exact: true }).click()
  await waitForSectionAtActivation('settings-about', true)
  await waitForActiveId('settings-about')
  const before = await readSettingsGeometry()
  const maxBefore = Math.max(0, before.scrollHeight - before.clientHeight)
  expect(before.scrollTop).toBeGreaterThanOrEqual(maxBefore - 2)

  await nav.getByRole('button', { name: '数据与关于', exact: true }).click()
  await expectActive('数据与关于')
  const afterSecondClick = await readSettingsGeometry()
  // At the maximum scroll boundary Chromium can settle on a 2px integer rounding
  // difference depending on when the final smooth-scroll frame is sampled.
  expect(Math.abs(afterSecondClick.scrollTop - before.scrollTop)).toBeLessThanOrEqual(2)

  const snapshot = await expandSection('settings-portal', 600)
  try {
    await expect
      .poll(
        async () => {
          const geometry = await readSettingsGeometry()
          return geometry.activeId === geometry.expectedId && geometry.activeId !== 'settings-about'
            ? geometry.activeId
            : null
        },
        { timeout: 6_000 }
      )
      .not.toBeNull()
    const after = await readSettingsGeometry()
    expect(after.scrollTop).toBeLessThanOrEqual(before.scrollTop + 1)
    expect(after.scrollTop + after.clientHeight).toBeLessThan(after.scrollHeight - 5)
    expect(after.expectedId).not.toBe('settings-about')
    expect(after.activeId).toBe(after.expectedId)
  } finally {
    await restoreSection('settings-portal', snapshot)
  }
})

test('连续导航在首次滚动未完成时切换到邻近 Section', async () => {
  await resetSettingsView()
  const nav = page.locator('.settings-nav')

  await nav.getByRole('button', { name: '学习通与同步', exact: true }).click()
  const target = await targetScrollFor('settings-portal')
  await expect
    .poll(
      async () => {
        const geometry = await readSettingsGeometry()
        return geometry.scrollTop > 60 && geometry.scrollTop < target - 80
      },
      { timeout: 2_500 }
    )
    .toBe(true)

  await nav.getByRole('button', { name: '手动导入', exact: true }).click()
  await waitForSectionAtActivation('settings-import')
  const after = await readSettingsGeometry()
  expect(after.activeId).toBe('settings-import')
  expect(after.expectedId).toBe('settings-import')
})

test('平滑滚动途中 PageUp 中断并恢复到实际位置', async () => {
  await resetSettingsView()
  const nav = page.locator('.settings-nav')

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await nav.getByRole('button', { name: '数据与关于', exact: true }).focus()
  const target = await targetScrollFor('settings-about')
  await page.keyboard.press('Enter')

  await expect
    .poll(
      async () => {
        const geometry = await readSettingsGeometry()
        return geometry.scrollTop > 60 && geometry.scrollTop < target - 80
      },
      { timeout: 2_500 }
    )
    .toBe(true)
  const before = await readSettingsGeometry()
  expect(before.scrollTop).toBeGreaterThan(60)
  expect(before.scrollTop).toBeLessThan(target - 60)

  await page.keyboard.press('PageUp')
  await expect
    .poll(async () => (await readSettingsGeometry()).scrollTop, { timeout: 3_000 })
    .not.toBe(before.scrollTop)
  await waitForScrollSettled()
  const after = await readSettingsGeometry()

  expect(after.scrollTop).toBeLessThan(before.scrollTop)
  expect(after.scrollTop).toBeLessThan(target - 40)
  expect(after.activeId).toBe(after.expectedId)
  expect(after.activeId).not.toBe('settings-about')
  expect(after.activeId).not.toBeNull()
})

test('静止时内容高度变化会重新计算 active', async () => {
  await resetSettingsView()
  const target = await targetScrollFor('settings-reminders')
  await page
    .locator('.main-scroll')
    .evaluate((element, nextTop) => element.scrollTo({ top: nextTop, behavior: 'auto' }), target)
  await waitForActiveId('settings-reminders')
  await waitForScrollSettled()
  const before = await readSettingsGeometry()
  expect(before.activeId).toBe('settings-reminders')

  const snapshot = await expandSection('settings-appearance', 600)
  try {
    await expect
      .poll(
        async () => {
          const geometry = await readSettingsGeometry()
          return geometry.activeId === geometry.expectedId ? geometry.activeId : null
        },
        { timeout: 6_000 }
      )
      .not.toBe(before.activeId)
    await waitForStableActiveId('settings-appearance')
    const after = await readSettingsGeometry()
    expect(after.activeId).toBe(after.expectedId)
    expect(after.activeId).not.toBe(before.activeId)
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1)
  } finally {
    await restoreSection('settings-appearance', snapshot)
  }
})

test('900px 布局切换后 active 导航保持可见', async () => {
  await resetSettingsView()
  const nav = page.locator('.settings-nav')
  await nav.getByRole('button', { name: '数据与关于', exact: true }).click()
  await expectActive('数据与关于')
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await setContentSize(900, 900)
  await expectActive('数据与关于')
  await expect.poll(activeNavOverflow).toBeLessThanOrEqual(1)
})
