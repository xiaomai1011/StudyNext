import { BrowserWindow, WebContentsView, session, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import type { PortalLoginState, PortalNavigationEvent, PortalState } from '@shared/types'
import { PORTAL_PARTITION } from '@shared/constants'
import type { StudyNextStore } from '../storage/store'
import { UserFacingError } from '../lib/errors'
import {
  buildPortalSecurityState,
  buildPortalWebPreferences,
  isAllowedPortalUrl,
  isPortalNavigationAllowed,
  safeDisplayUrl,
  upgradePortalHttpUrl
} from './security'
import { buildCredentialFillScript, isChaoxingLoginUrl } from './autofill'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const IDLE_STATE: PortalState = {
  entryId: null,
  url: '',
  displayUrl: '',
  title: '',
  state: 'idle',
  canGoBack: false,
  canGoForward: false,
  loggedIn: null,
  loginState: 'unknown',
  navigationLog: [],
  error: null
}

export class PortalService {
  private view: WebContentsView | null = null
  private state: PortalState = { ...IDLE_STATE }
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private sessionConfigured = false
  private currentUrl = ''

  constructor(
    private readonly store: StudyNextStore,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly getCredentials?: () => Promise<{ username: string; password: string } | null>
  ) {}

  getState(): PortalState {
    return { ...this.state, navigationLog: [...this.state.navigationLog] }
  }

  getSecurityState() {
    return buildPortalSecurityState()
  }

  setBounds(bounds: Rect): void {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return
    const content = window.getContentBounds()
    const x = clampNumber(bounds.x, 0, Math.max(0, content.width - 1))
    const y = clampNumber(bounds.y, 0, Math.max(0, content.height - 1))
    const width = clampNumber(bounds.width, 0, Math.max(0, content.width - x))
    const height = clampNumber(bounds.height, 0, Math.max(0, content.height - y))
    this.bounds = { x, y, width, height }
    if (this.view) this.view.setBounds(this.bounds)
  }

  async open(entryId: string): Promise<void> {
    const entry = this.store.getOfficialEntry(entryId)
    if (!entry || !entry.enabled) {
      throw new UserFacingError('ENTRY_NOT_FOUND', '官方入口不存在或已停用')
    }
    if (!isAllowedPortalUrl(entry.url)) {
      throw new UserFacingError('PORTAL_URL_BLOCKED', '该入口不属于学习通官方域名，已拦截')
    }
    const window = this.getWindow()
    if (!window || window.isDestroyed()) {
      throw new UserFacingError('WINDOW_NOT_READY', '主窗口尚未就绪')
    }
    this.destroyView()
    this.configureSession()
    const view = new WebContentsView({ webPreferences: buildPortalWebPreferences() })
    this.view = view
    this.attachSecurityHandlers(view)
    window.contentView.addChildView(view)
    if (this.bounds.width > 0 && this.bounds.height > 0) {
      view.setBounds(this.bounds)
    }
    this.state = {
      ...IDLE_STATE,
      entryId,
      url: safeDisplayUrl(entry.url),
      displayUrl: safeDisplayUrl(entry.url),
      state: 'loading',
      navigationLog: this.state.navigationLog
    }
    this.currentUrl = entry.url
    this.appendNavigation('open', entry.url, true, null)
    this.emit()
    try {
      await view.webContents.loadURL(entry.url)
    } catch (error) {
      const message = error instanceof Error ? error.message : '官方页面加载失败'
      if (!message.includes('ERR_ABORTED')) {
        this.updateState({ state: 'error', error: '官方页面加载失败，可尝试在系统浏览器中打开' })
      }
    }
  }

  close(): void {
    this.destroyView()
    this.currentUrl = ''
    this.state = { ...IDLE_STATE, navigationLog: this.state.navigationLog }
    this.emit()
  }

  async openInitialInBrowser(): Promise<void> {
    const target = this.currentUrl || this.store.listOfficialEntries()[0]?.url
    if (!target || !this.isNavigationAllowed(target)) {
      throw new UserFacingError(
        'PORTAL_URL_BLOCKED',
        '当前地址不属于学习通官方域名或已授权的校园 SSO 域名'
      )
    }
    await shell.openExternal(target)
  }

  async back(): Promise<void> {
    const contents = this.view?.webContents
    if (contents?.canGoBack()) contents.goBack()
  }

  async forward(): Promise<void> {
    const contents = this.view?.webContents
    if (contents?.canGoForward()) contents.goForward()
  }

  async reload(): Promise<void> {
    this.view?.webContents.reload()
  }

  /**
   * Fills the official passport form with the locally encrypted account. It
   * never submits the form: the user still reviews and clicks the login button,
   * and any captcha / MFA challenge stays with the user.
   */
  async fillCredentials(): Promise<boolean> {
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed()) return false
    if (!isChaoxingLoginUrl(contents.getURL())) return false
    const credentials = await this.getCredentials?.()
    if (!credentials) return false
    const script = buildCredentialFillScript(credentials.username, credentials.password)
    const mainFrame = contents.mainFrame
    const frames = [mainFrame, ...mainFrame.framesInSubtree.filter((frame) => frame !== mainFrame)]
    for (const frame of frames) {
      try {
        if ((await frame.executeJavaScript(script, true)) === true) return true
      } catch {
        // Try the next frame; the login form may live in a nested frame.
      }
    }
    return false
  }

  /**
   * Reads the course grid from the Portal's own frames. The personal-space
   * page builds the iframe src in JavaScript, and the isolated HTTP client can
   * be blocked by Chromium for that cross-subdomain frame; the visible Portal
   * frame already has the authenticated DOM, so use it as the read-only source.
   */
  async readCoursePageHtml(): Promise<string | null> {
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed()) return null
    const mainFrame = contents.mainFrame
    const frames = [mainFrame, ...mainFrame.framesInSubtree.filter((frame) => frame !== mainFrame)]
    let best: string | null = null
    let bestCount = 0
    for (const frame of frames) {
      try {
        const count = (await frame.executeJavaScript(
          '(document.body ? (document.body.innerHTML.match(/stucoursemiddle/g) || []).length : 0)',
          true
        )) as number
        if (typeof count === 'number' && count > bestCount) {
          const html = (await frame.executeJavaScript(
            'document.documentElement.outerHTML',
            true
          )) as string
          if (typeof html === 'string' && html.length > 0) {
            best = html
            bestCount = count
          }
        }
      } catch {
        // Frame may be detached or still loading; try the next one.
      }
    }
    return best
  }

  /**
   * 同步时 Portal 可能还没打开，或课程 iframe 仍在加载。这里按需打开个人空间，
   * 轮询等待课程网格渲染完成；只读取 DOM，不注入任何脚本逻辑。
   */
  async ensureCoursePageHtml(): Promise<string | null> {
    const existing = await this.readCoursePageHtml()
    if (existing) return existing
    if (!this.view) {
      const entries = this.store.listOfficialEntries(false)
      const home =
        entries.find((entry) => entry.id === 'entry-home') ??
        entries.find((entry) => entry.url.includes('i.chaoxing.com'))
      if (!home) return null
      try {
        await this.open(home.id)
      } catch {
        return null
      }
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const html = await this.readCoursePageHtml()
      if (html) return html
    }
    return null
  }

  /**
   * 课表页与个人空间同属学习通登录态。HTTP 客户端请求 kb.chaoxing.com 会被
   * Chromium 拦截（ERR_BLOCKED_BY_CLIENT），但课表页自身的同源 fetch 可用；
   * 这里在课表页上下文内逐周拉取，返回不含 Cookie 的 JSON 字符串。
   */
  async readScheduleFromPage(): Promise<string | null> {
    const entries = this.store.listOfficialEntries(false)
    const calendar = entries.find((entry) => entry.id === 'entry-calendar')
    if (!calendar) return null
    const contents = this.view?.webContents
    const alreadyOpen =
      contents &&
      !contents.isDestroyed() &&
      contents.getURL().startsWith('https://kb.chaoxing.com/res/pc/curriculum/schedule.html')
    if (!alreadyOpen) {
      try {
        await this.open(calendar.id)
      } catch {
        return null
      }
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const current = this.view?.webContents
      if (!current || current.isDestroyed()) return null
      if (current.getURL().startsWith('https://kb.chaoxing.com/res/pc/curriculum/schedule.html')) {
        try {
          const result = (await current.executeJavaScript(
            `(async () => {
              const post = async (body) => {
                const response = await fetch('/pc/curriculum/getMyLessons', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                  body,
                  credentials: 'include'
                })
                return response.json()
              }
              const first = await post('')
              const maxWeek = Math.min(Number(first && first.data && first.data.curriculum && first.data.curriculum.maxWeek) || 20, 30)
              const weeks = []
              for (let week = 1; week <= maxWeek; week += 1) {
                try {
                  const payload = await post('week=' + week)
                  if (payload && payload.result === 1) {
                    weeks.push({ week, lessons: (payload.data && payload.data.lessonArray) || [] })
                  }
                } catch {
                  // 单周失败不阻断其他周；上层会按缺失周次提示。
                }
              }
              return JSON.stringify({
                curriculum: (first && first.data && first.data.curriculum) || {},
                weeks
              })
            })()`,
            true
          )) as unknown
          if (typeof result === 'string' && result.length > 0) return result
        } catch {
          // Page may still be loading; retry below.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    return null
  }

  async clearSession(): Promise<void> {
    const portalSession = session.fromPartition(PORTAL_PARTITION)
    await portalSession.clearStorageData()
    await portalSession.clearCache()
    this.close()
  }

  async clearNavigationLog(): Promise<void> {
    this.updateState({ navigationLog: [] })
  }

  destroy(): void {
    this.destroyView()
  }

  private configureSession(): void {
    if (this.sessionConfigured) return
    this.sessionConfigured = true
    const portalSession = session.fromPartition(PORTAL_PARTITION)
    portalSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })
    portalSession.setPermissionCheckHandler(() => false)
    portalSession.on('will-download', (event) => {
      event.preventDefault()
      if (this.view) {
        this.updateState({ error: '官方页面下载已拦截，请在系统浏览器中完成下载' })
      }
    })
  }

  private attachSecurityHandlers(view: WebContentsView): void {
    const contents = view.webContents
    const upgradeHttpNavigation = (url: string): boolean => {
      const upgraded = upgradePortalHttpUrl(url)
      if (!upgraded) return false
      this.appendNavigation('open', upgraded, true, '学习通入口要求使用 HTTPS，已自动升级')
      void contents.loadURL(upgraded)
      return true
    }
    const blockNavigation = (url: string): boolean => {
      if (this.isNavigationAllowed(url)) return false
      this.appendNavigation('blocked', url, false, '非学习通官方域名或未授权的校园 SSO 域名')
      this.updateState({
        state: 'blocked',
        error: '已拦截未授权域名的跳转；可在设置中添加受信任的校园 SSO 域名，或使用系统浏览器'
      })
      return true
    }

    contents.on('will-navigate', (event, url) => {
      if (upgradeHttpNavigation(url)) {
        event.preventDefault()
        return
      }
      if (blockNavigation(url)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      if (upgradeHttpNavigation(url)) {
        event.preventDefault()
        return
      }
      if (blockNavigation(url)) event.preventDefault()
    })
    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })
    contents.setWindowOpenHandler(({ url }) => {
      const upgraded = upgradePortalHttpUrl(url)
      if (upgraded) {
        this.appendNavigation('open', upgraded, true, '学习通入口要求使用 HTTPS，已自动升级')
        void contents.loadURL(upgraded)
      } else if (this.isNavigationAllowed(url)) {
        this.appendNavigation('open', url, true, null)
        void contents.loadURL(url)
      } else {
        this.appendNavigation('blocked', url, false, '弹窗目标域名未授权')
        this.updateState({
          state: 'blocked',
          error: '已拦截未授权弹窗；可使用系统浏览器打开官方入口'
        })
      }
      return { action: 'deny' }
    })
    contents.on('did-start-loading', () => {
      this.updateState({ state: 'loading', error: null })
    })
    contents.on('did-stop-loading', () => {
      if (this.state.state === 'loading') this.updateState({ state: 'ready' })
    })
    contents.on('did-finish-load', () => {
      if (this.getCredentials) void this.fillCredentials()
    })
    contents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return
        this.currentUrl = validatedUrl
        this.updateState({
          state: 'error',
          url: safeDisplayUrl(validatedUrl),
          displayUrl: safeDisplayUrl(validatedUrl),
          error: `页面加载失败（${errorDescription || errorCode}），可尝试系统浏览器`
        })
      }
    )
    contents.on('did-navigate', (_event, url) => {
      this.applyNavigatedUrl(url, 'navigate')
    })
    contents.on('did-navigate-in-page', (_event, url) => {
      this.applyNavigatedUrl(url, 'navigate')
    })
    contents.on('page-title-updated', (_event, title) => {
      this.updateState({ title })
    })
    contents.on('render-process-gone', (_event, details) => {
      this.updateState({
        state: 'error',
        error: `官方页面进程异常退出（${details.reason}）`
      })
    })
    contents.on('destroyed', () => {
      if (this.view?.webContents === contents) {
        this.view = null
      }
    })
  }

  private isNavigationAllowed(url: string): boolean {
    return isPortalNavigationAllowed(url, this.store.getSettings().trustedSsoDomains)
  }

  private applyNavigatedUrl(
    url: string,
    action: PortalNavigationEvent['action'] = 'navigate'
  ): void {
    if (!this.isNavigationAllowed(url)) {
      this.appendNavigation('blocked', url, false, '导航离开授权域名')
      this.updateState({
        state: 'blocked',
        error: '已拦截非授权域名的跳转'
      })
      return
    }
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLocaleLowerCase()
    const path = parsed.pathname.toLocaleLowerCase()
    const isLoginPage =
      hostname.startsWith('passport') ||
      hostname.startsWith('passport2') ||
      hostname.includes('login') ||
      /\/login|\/signin|\/cas\//i.test(path)
    const loginState: PortalLoginState = isLoginPage
      ? 'logged_out'
      : (hostname === 'i.chaoxing.com' &&
            (path.startsWith('/base') || path.startsWith('/visit'))) ||
          (this.state.loginState === 'logged_out' && isAllowedPortalUrl(url))
        ? 'logged_in'
        : this.state.loginState
    this.appendNavigation(action, url, true, null)
    this.currentUrl = url
    this.updateState({
      url: safeDisplayUrl(url),
      displayUrl: safeDisplayUrl(url),
      loggedIn: loginState === 'logged_in' ? true : loginState === 'logged_out' ? false : null,
      loginState,
      canGoBack: this.view?.webContents.canGoBack() ?? false,
      canGoForward: this.view?.webContents.canGoForward() ?? false,
      state: this.state.state === 'blocked' ? 'blocked' : this.state.state,
      error: isLoginPage ? '请在官方登录页手动完成登录；账号、密码和 Cookie 不会写入日志' : null
    })
  }

  private appendNavigation(
    action: PortalNavigationEvent['action'],
    url: string,
    allowed: boolean,
    reason: string | null
  ): void {
    const displayUrl = safeDisplayUrl(url)
    const event: PortalNavigationEvent = {
      id: randomUUID(),
      at: new Date().toISOString(),
      action,
      url: displayUrl,
      displayUrl,
      allowed,
      reason
    }
    this.state = {
      ...this.state,
      navigationLog: [event, ...this.state.navigationLog].slice(0, 30)
    }
  }

  private updateState(patch: Partial<PortalState>): void {
    this.state = { ...this.state, ...patch }
    const contents = this.view?.webContents
    if (contents) {
      this.state.canGoBack = contents.canGoBack()
      this.state.canGoForward = contents.canGoForward()
    }
    this.emit()
  }

  private emit(): void {
    const window = this.getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send('event:portal-state', this.state)
    }
  }

  private destroyView(): void {
    if (!this.view) return
    const window = this.getWindow()
    const view = this.view
    this.view = null
    try {
      if (window && !window.isDestroyed()) {
        window.contentView.removeChildView(view)
      }
    } catch {
      // The window may already be closing.
    }
    if (!view.webContents.isDestroyed()) {
      view.webContents.close()
    }
  }
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.round(value), min), max)
}
