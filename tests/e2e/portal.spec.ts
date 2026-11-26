import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import type { WebContentsView } from 'electron'
import type { OfficialEntry, PortalState, StudyNextApi } from '../../src/shared/types'

const ROOT = process.cwd()
const DATA_DIR = mkdtempSync(join(ROOT, '.tmp-e2e-portal-'))
const PORTAL_HOST = 'test.chaoxing.com'

let server: Server
let app: ElectronApplication
let page: Page
let portalUrl: string

function createProbeServer(): Promise<number> {
  const key = readFileSync(join(ROOT, 'tests', 'fixtures', 'portal-test.key'))
  const cert = readFileSync(join(ROOT, 'tests', 'fixtures', 'portal-test.crt'))
  server = createServer({ key, cert }, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html>
      <html>
        <head><meta charset="utf-8"><title>Portal Isolation Probe</title></head>
        <body>
          <h1 id="probe">StudyNext portal isolation probe</h1>
          <p>This page is served by the local E2E fixture.</p>
        </body>
      </html>`)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
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
    args: [
      '.',
      '--no-sandbox',
      '--disable-gpu',
      `--user-data-dir=${DATA_DIR}`,
      `--host-resolver-rules=MAP ${PORTAL_HOST} 127.0.0.1`,
      '--no-proxy-server'
    ],
    cwd: ROOT,
    env
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })
  await app.evaluate(({ session }) => {
    session
      .fromPartition('persist:studynext-portal')
      .setCertificateVerifyProc((_request, callback) => callback(0))
  })
}

test.beforeAll(async () => {
  const port = await createProbeServer()
  portalUrl = `https://${PORTAL_HOST}:${port}/probe?token=e2e-secret#section`
  await launch()
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

test('第三方网页运行在隔离 WebContentsView 中且无法访问 Electron API', async () => {
  const entry = await page.evaluate(async (url): Promise<OfficialEntry> => {
    const api = (window as unknown as { studynext: StudyNextApi }).studynext
    return api.entries.create({
      label: 'E2E 隔离探针',
      description: '本地 HTTPS 测试页面',
      url,
      kind: 'custom'
    })
  }, portalUrl)

  await page.evaluate(async (entryId) => {
    const api = (window as unknown as { studynext: StudyNextApi }).studynext
    await api.portal.open(entryId)
  }, entry.id)

  await expect
    .poll(
      () =>
        app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]
          const view = window?.contentView.children.find((child) => 'webContents' in child) as
            | WebContentsView
            | undefined
          return view?.webContents.getURL() ?? null
        }),
      { timeout: 20_000 }
    )
    .toBe(portalUrl)

  await expect
    .poll(
      () =>
        app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]
          const view = window?.contentView.children.find((child) => 'webContents' in child) as
            | WebContentsView
            | undefined
          return view?.webContents.getTitle() ?? null
        }),
      { timeout: 10_000 }
    )
    .toBe('Portal Isolation Probe')

  const probe = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const view = window?.contentView.children.find((child) => 'webContents' in child) as
      | WebContentsView
      | undefined
    if (!view) return null
    return view.webContents.executeJavaScript(`(() => ({
      title: document.title,
      requireType: typeof require,
      processType: typeof process,
      moduleType: typeof module,
      studynextType: typeof window.studynext,
      electronType: typeof window.electron,
      ipcRendererType: typeof window.ipcRenderer
    }))()`)
  })

  expect(probe).toEqual({
    title: 'Portal Isolation Probe',
    requireType: 'undefined',
    processType: 'undefined',
    moduleType: 'undefined',
    studynextType: 'undefined',
    electronType: 'undefined',
    ipcRendererType: 'undefined'
  })

  const exposedState = await page.evaluate(async (): Promise<PortalState> => {
    const api = (window as unknown as { studynext: StudyNextApi }).studynext
    return api.portal.state()
  })
  const expectedDisplayUrl = new URL(portalUrl)
  expect(exposedState.url).toBe(`${expectedDisplayUrl.origin}${expectedDisplayUrl.pathname}`)
  expect(exposedState.url).not.toContain('token')
  expect(JSON.stringify(exposedState.navigationLog)).not.toContain('token')

  await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const view = window?.contentView.children.find((child) => 'webContents' in child) as
      | WebContentsView
      | undefined
    if (!view) return
    await view.webContents
      .executeJavaScript(`location.href = 'https://example.com/blocked'`)
      .catch(() => undefined)
  })

  await expect
    .poll(
      async () =>
        page.evaluate(async (): Promise<PortalState> => {
          const api = (window as unknown as { studynext: StudyNextApi }).studynext
          return api.portal.state()
        }),
      { timeout: 10_000 }
    )
    .toMatchObject({ state: 'blocked' })

  const finalUrl = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const view = window?.contentView.children.find((child) => 'webContents' in child) as
      | WebContentsView
      | undefined
    return view?.webContents.getURL() ?? null
  })
  expect(finalUrl).toBe(portalUrl)
})

test('Portal 打开时 Escape 严格按上层叠层优先级逐层关闭', async () => {
  await page.evaluate(async (url) => {
    const api = (window as unknown as { studynext: StudyNextApi }).studynext
    await api.portal.hide()
    await api.imports.snapshot({
      fileName: 'portal-escape.json',
      content: JSON.stringify({
        courses: [
          {
            id: 'course-portal-esc',
            name: 'Portal Escape 测试课程',
            source: 'chaoxing',
            sourceUrl: url,
            schedule: []
          }
        ]
      })
    })
  }, portalUrl)
  await page.reload()
  await expect(page.locator('.loading-screen')).toHaveCount(0, { timeout: 20_000 })

  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await expect(page.locator('.studio-course-shell')).toBeVisible()
  await page.locator('.course-rail-item', { hasText: 'Portal Escape 测试课程' }).click()
  await page.getByRole('button', { name: '进入学习通课堂' }).click()
  await expect(page.locator('.portal-overlay')).toBeVisible()

  await page.locator('button[aria-label="页面入口与会话诊断"]').click()
  await expect(page.locator('.studio-portal-drawer')).toBeVisible()

  await page.locator('.titlebar-zoom-trigger').click()
  await expect(page.locator('.titlebar-zoom-popover')).toBeVisible()

  await page.keyboard.press('Control+k')
  const palette = page.locator('.command-palette')
  await expect(palette).toBeVisible()

  // Layer 1: CommandPalette
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)
  await expect(page.locator('.titlebar-zoom-popover')).toBeVisible()
  await expect(page.locator('.studio-portal-drawer')).toBeVisible()
  await expect(page.locator('.portal-overlay')).toBeVisible()

  // Layer 2: Topbar Zoom popover
  await page.keyboard.press('Escape')
  await expect(page.locator('.titlebar-zoom-popover')).toHaveCount(0)
  await expect(page.locator('.studio-portal-drawer')).toBeVisible()
  await expect(page.locator('.portal-overlay')).toBeVisible()

  // Layer 3: Portal Tools drawer
  await page.keyboard.press('Escape')
  await expect(page.locator('.studio-portal-drawer')).toHaveCount(0)
  await expect(page.locator('.portal-overlay')).toBeVisible()

  // Layer 4: Portal overlay itself
  await page.keyboard.press('Escape')
  await expect(page.locator('.portal-overlay')).toHaveCount(0)
})
