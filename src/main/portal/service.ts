import { BrowserWindow, WebContentsView, session, shell } from 'electron'
import type { PortalState } from '@shared/types'
import { PORTAL_PARTITION } from '@shared/constants'
import type { StudyNextStore } from '../storage/store'
import { UserFacingError } from '../lib/errors'
import {
  buildPortalSecurityState,
  buildPortalWebPreferences,
  isAllowedPortalUrl,
  safeDisplayUrl
} from './security'

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
  error: null
}

export class PortalService {
  private view: WebContentsView | null = null
  private state: PortalState = { ...IDLE_STATE }
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private sessionConfigured = false

  constructor(
    private readonly store: StudyNextStore,
    private readonly getWindow: () => BrowserWindow | null
  ) {}

  getState(): PortalState {
    return { ...this.state }
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
      url: entry.url,
      displayUrl: safeDisplayUrl(entry.url),
      state: 'loading'
    }
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
    this.state = { ...IDLE_STATE }
    this.emit()
  }

  async openInitialInBrowser(): Promise<void> {
    const target = this.state.url || this.store.listOfficialEntries()[0]?.url
    if (!target || !isAllowedPortalUrl(target)) {
      throw new UserFacingError('PORTAL_URL_BLOCKED', '当前地址不属于学习通官方域名')
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

  async clearSession(): Promise<void> {
    const portalSession = session.fromPartition(PORTAL_PARTITION)
    await portalSession.clearStorageData()
    await portalSession.clearCache()
    this.close()
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
    const blockNavigation = (url: string): boolean => {
      if (isAllowedPortalUrl(url)) return false
      this.updateState({
        state: 'blocked',
        error: '已拦截非学习通官方域名的跳转；可使用系统浏览器打开官方入口'
      })
      return true
    }

    contents.on('will-navigate', (event, url) => {
      if (blockNavigation(url)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      if (blockNavigation(url)) event.preventDefault()
    })
    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedPortalUrl(url)) {
        void contents.loadURL(url)
      } else {
        this.updateState({
          state: 'blocked',
          error: '已拦截弹窗跳转；可使用系统浏览器打开官方入口'
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
    contents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return
        this.updateState({
          state: 'error',
          url: validatedUrl,
          displayUrl: safeDisplayUrl(validatedUrl),
          error: `页面加载失败（${errorDescription || errorCode}），可尝试系统浏览器`
        })
      }
    )
    contents.on('did-navigate', (_event, url) => {
      this.applyNavigatedUrl(url)
    })
    contents.on('did-navigate-in-page', (_event, url) => {
      this.applyNavigatedUrl(url)
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

  private applyNavigatedUrl(url: string): void {
    if (!isAllowedPortalUrl(url)) {
      this.updateState({
        state: 'blocked',
        error: '已拦截非学习通官方域名的跳转'
      })
      return
    }
    const hostname = new URL(url).hostname.toLocaleLowerCase()
    const isLoginPage = hostname.startsWith('passport') || /\/login/i.test(url)
    const loggedIn = isLoginPage ? false : hostname === 'i.chaoxing.com' ? true : null
    this.updateState({
      url,
      displayUrl: safeDisplayUrl(url),
      loggedIn,
      canGoBack: this.view?.webContents.canGoBack() ?? false,
      canGoForward: this.view?.webContents.canGoForward() ?? false,
      state: this.state.state === 'blocked' ? 'blocked' : this.state.state,
      error: isLoginPage ? '请在官方登录页手动完成登录，凭据不会写入日志' : null
    })
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
