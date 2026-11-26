import { app, BrowserWindow, dialog, net, WebContentsView, session, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'
import type {
  BatchRetryResult,
  MaterialLocalFile,
  PortalAutoLoginResult,
  PortalDownload,
  PortalLoginState,
  PortalNavigationEvent,
  PortalState,
  PortalUploadEvent
} from '@shared/types'
import { PORTAL_PARTITION } from '@shared/constants'
import { IPC } from '@shared/ipc'
import { downloadSourceKey, selectRetryableFailedDownloads } from '@shared/materials'
import type { StudyNextStore } from '../storage/store'
import { errorMessage, UserFacingError } from '../lib/errors'
import {
  buildPortalSecurityState,
  buildPortalWebPreferences,
  isAllowedPortalUrl,
  isPortalNavigationAllowed,
  safeDisplayUrl,
  upgradePortalHttpUrl
} from './security'
import {
  buildCredentialFillScript,
  buildCredentialLoginScript,
  buildLoginErrorScript,
  isChaoxingLoginUrl
} from './autofill'
import { describeUploadCompletion, describeUploadError } from './upload-events'
import { recoverDownloads } from './download-recovery'
import { resolveDownloadFinishState } from './download-state'
import { isProtectedWorkUrl } from './guards'
import { resolvePortalNavigation } from './navigation'
import { resolveMaterialDownloadSource } from '../materials/download-source'
import {
  invalidateMissingDownloadLocalFile,
  recordCompletedMaterialLocalFile,
  resolveVerifiedMaterialLocalFile,
  resolveVerifiedMaterialLocalFiles
} from '../materials/local-files'

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('请求已取消')
  error.name = 'AbortError'
  throw error
}

const SYNC_RESTORE_TIMEOUT_MS = 5_000
import {
  buildAttachmentPreviewUrl,
  parseAttachmentDownloadUrl,
  resolveTaskAttachmentSource
} from '../integrations/chaoxing/attachment-download'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface SyncNavigationResult {
  restored: boolean
  message: string | null
}

export interface SyncNavigationGuard {
  begin: (operationId?: string) => Promise<void>
  end: (operationId?: string) => Promise<SyncNavigationResult>
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
  private userNavigationVersion = 0
  private lastUserNavigationAt = 0

  private userNavigationRecent(): boolean {
    return Date.now() - this.lastUserNavigationAt < 8000
  }

  /**
   * Every user-driven view change (opening an entry, switching away, closing the
   * overlay, or using the in-page navigation controls) advances the navigation
   * version so that an in-flight sync read can never restore a page the user has
   * already left. Hidden sync reads intentionally do not call this.
   */
  private noteUserNavigation(): void {
    this.userNavigationVersion += 1
    this.lastUserNavigationAt = Date.now()
  }
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private portalSurfaceActive = false
  private sessionConfigured = false
  private currentUrl = ''
  private readonly downloads = new Map<string, PortalDownload>()
  private readonly downloadItems = new Map<string, Electron.DownloadItem>()
  private readonly downloadRequests = new Map<string, { abort: () => void }>()
  private readonly cancelledDownloads = new Set<string>()
  private readonly downloadRetryUrls = new Map<string, string>()
  private readonly cdnReferers = new Map<string, string>()
  private readonly downloadRetryReferers = new Map<string, string>()
  private readonly reservedFilenames = new Set<string>()
  private downloadsHydrated = false
  private lastSubmitDetectedAt = 0
  private syncNavigationSnapshot: string | null = null
  private syncNavigationActive = false
  private syncNavigationOwner: string | null = null
  private syncNavigationStartedAt = 0
  private syncNavigationVersion = 0
  private syncUserInteracted = false
  private autoLoginGeneration = 0
  private activeUploads = 0
  private writesSuspended = false

  /**
   * Freeze all Portal-side persistence before an account switch. This is
   * intentionally irreversible for the current process; the app relaunches
   * into the target workspace instead of trying to hot-swap live services.
   */
  suspendWritesForAccountSwitch(): void {
    this.writesSuspended = true
    for (const request of this.downloadRequests.values()) {
      try {
        request.abort()
      } catch {
        // The request may already have completed.
      }
    }
    this.downloadRequests.clear()
    this.downloadItems.clear()
    this.cancelledDownloads.clear()
    this.downloads.clear()
  }

  constructor(
    private readonly store: StudyNextStore,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly getCredentials?: (
      accountId?: string
    ) => Promise<{ username: string; password: string } | null>
  ) {
    this.hydrateDownloads()
  }

  getState(): PortalState {
    return { ...this.state, navigationLog: [...this.state.navigationLog] }
  }

  /**
   * Account switching may clear the isolated session, so it must never run
   * while the user is editing/submitting a homework page or uploading a file.
   */
  canSwitchAccount(): { ok: boolean; reason: string | null } {
    const contents = this.view?.webContents
    const url = contents && !contents.isDestroyed() ? contents.getURL() : ''
    if (isProtectedWorkUrl(url)) {
      return {
        ok: false,
        reason: '当前正在作业页面，可能有未保存内容；请先保存或离开作业页后再切换账号。'
      }
    }
    // 作业编辑器可能在跨域 iframe 中，顶层 URL 不能代表编辑状态。
    // 无法证明安全时按未保存处理，避免静默中断用户正在编辑的内容。
    const frames = contents && !contents.isDestroyed() ? contents.mainFrame.framesInSubtree : []
    if (frames.some((frame) => isProtectedWorkUrl(frame.url))) {
      return {
        ok: false,
        reason: '当前页面包含官方作业编辑器，可能有未保存内容；请先保存或离开作业页后再切换账号。'
      }
    }
    if (this.activeUploads > 0) {
      return { ok: false, reason: '当前有附件正在上传，请等待上传完成后再切换账号。' }
    }
    return { ok: true, reason: null }
  }

  /**
   * Records the page the user is on before a background sync starts. The
   * restore step only runs when the sync left the Portal on a known sync page;
   * if the user navigated somewhere meaningful, their page is left untouched.
   */
  createSyncNavigationGuard(): SyncNavigationGuard {
    return {
      begin: async (operationId?: string) => {
        const contents = this.view?.webContents
        this.syncNavigationSnapshot = contents && !contents.isDestroyed() ? contents.getURL() : null
        this.syncNavigationActive = true
        this.syncNavigationOwner = operationId ?? null
        this.syncNavigationStartedAt = Date.now()
        this.syncNavigationVersion = this.userNavigationVersion
        this.syncUserInteracted = false
      },
      end: async (operationId?: string) => {
        const owner = this.syncNavigationOwner
        if (owner && operationId && owner !== operationId) {
          return { restored: false, message: '旧同步操作已结束，未恢复当前页面' }
        }
        const snapshot = this.syncNavigationSnapshot
        const startedAt = this.syncNavigationStartedAt
        const navigationVersion = this.syncNavigationVersion
        const userInteracted =
          this.syncUserInteracted || navigationVersion !== this.userNavigationVersion
        const clear = (): void => {
          this.syncNavigationSnapshot = null
          this.syncNavigationActive = false
          this.syncNavigationOwner = null
          this.syncNavigationStartedAt = 0
          this.syncUserInteracted = false
        }
        if (!snapshot) {
          clear()
          return { restored: true, message: null }
        }
        if (Date.now() - startedAt > 60_000) {
          clear()
          return { restored: false, message: '同步超过恢复时限，未自动恢复原页面' }
        }
        if (userInteracted) {
          clear()
          return { restored: false, message: '同步期间检测到你的页面操作，未自动恢复原页面' }
        }
        const contents = this.view?.webContents
        if (!contents || contents.isDestroyed()) {
          clear()
          return { restored: false, message: '官方页面已关闭，未恢复同步前页面' }
        }
        const current = contents.getURL()
        if (current === snapshot) {
          clear()
          return { restored: true, message: null }
        }
        if (/passport|login|signin/i.test(current)) {
          clear()
          return { restored: false, message: '登录状态已过期，未恢复同步前页面；请重新登录学习通' }
        }
        if (!this.isSyncGeneratedPage(current)) {
          clear()
          return { restored: false, message: '同步期间页面已被切换，未自动恢复原页面' }
        }
        if (!isAllowedPortalUrl(snapshot)) {
          clear()
          return { restored: false, message: '同步前页面不属于学习通官方域名，未恢复' }
        }
        let timedOut = false
        let timer: ReturnType<typeof setTimeout> | null = null
        try {
          const timeout = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), SYNC_RESTORE_TIMEOUT_MS)
          })
          const result = await Promise.race([
            contents.loadURL(snapshot).then(() => 'loaded' as const),
            timeout
          ])
          if (result === 'timeout') {
            timedOut = true
            try {
              contents.stop()
            } catch {
              // The view may have been destroyed while the timeout fired.
            }
            return { restored: false, message: '同步原页面恢复超时，已停止恢复' }
          }
          // 恢复期间用户可能已经导航或开始新操作；迟到结果不得覆盖新页面。
          if (
            this.userNavigationVersion !== navigationVersion ||
            this.syncUserInteracted ||
            (operationId && this.syncNavigationOwner && this.syncNavigationOwner !== operationId)
          ) {
            return { restored: false, message: '同步期间页面已切换，未覆盖当前页面' }
          }
          return { restored: true, message: null }
        } catch {
          if (timedOut) {
            return { restored: false, message: '同步原页面恢复超时，已停止恢复' }
          }
          return { restored: false, message: '同步完成，但原页面恢复失败' }
        } finally {
          if (timer) clearTimeout(timer)
          if (this.syncNavigationOwner === owner) clear()
        }
      }
    }
  }

  /**
   * 章节/资料读取结束后的局部恢复也必须服从中央同步导航所有权：
   * 同一 owner、用户导航版本、5 秒恢复时限，并响应本次操作的 AbortSignal。
   * 不再在调用方 finally 里直接 loadURL 绕过 guard。
   */
  private async restoreSyncPage(previousUrl: string, signal?: AbortSignal): Promise<void> {
    if (!previousUrl || !isAllowedPortalUrl(previousUrl)) return
    if (!this.syncNavigationActive || signal?.aborted) return
    const owner = this.syncNavigationOwner
    const navigationVersion = this.syncNavigationVersion
    if (this.userNavigationVersion !== navigationVersion || this.syncUserInteracted) {
      return
    }
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed()) return
    const current = contents.getURL()
    if (current === previousUrl) return
    if (!this.isSyncGeneratedPage(current)) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let timedOut = false
    const stop = (): void => {
      try {
        contents.stop()
      } catch {
        // The view may already be destroyed.
      }
    }
    signal?.addEventListener('abort', stop, { once: true })
    try {
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), SYNC_RESTORE_TIMEOUT_MS)
      })
      const result = await Promise.race([
        contents.loadURL(previousUrl).then(() => 'loaded' as const),
        timeout
      ])
      if (result === 'timeout') {
        timedOut = true
        stop()
        return
      }
      if (
        this.userNavigationVersion !== navigationVersion ||
        this.syncUserInteracted ||
        (owner !== null && this.syncNavigationOwner !== owner) ||
        signal?.aborted
      ) {
        stop()
      }
    } catch {
      if (timedOut) stop()
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
    }
  }

  private isSyncGeneratedPage(url: string): boolean {
    return [
      /mooc2-ans\.chaoxing\.com\/mooc2-ans\/mycourse\/stu\b/i,
      /mooc2-ans\.chaoxing\.com\/mooc2-ans\/mycourse\/studentcourse\b/i,
      /kb\.chaoxing\.com\/res\/pc\/curriculum\/schedule\.html/i,
      /exam-ans\/exam\/test\/examcode\/examlist/i,
      /notice\.chaoxing\.com\/pc\/notice\/myNotice/i,
      /mooc2-ans\.chaoxing\.com\/mooc2-ans\/coursedata\/stu-datalist/i,
      /i\.chaoxing\.com\/base/i
    ].some((pattern) => pattern.test(url))
  }

  getSecurityState() {
    return buildPortalSecurityState()
  }

  setBounds(bounds: Rect): void {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return
    const content = window.getContentBounds()
    const zoom = window.webContents.getZoomFactor() || 1
    const x = clampNumber(Math.round(bounds.x * zoom), 0, Math.max(0, content.width - 1))
    const y = clampNumber(Math.round(bounds.y * zoom), 0, Math.max(0, content.height - 1))
    const width = clampNumber(Math.round(bounds.width * zoom), 0, Math.max(0, content.width - x))
    const height = clampNumber(Math.round(bounds.height * zoom), 0, Math.max(0, content.height - y))
    this.bounds = { x, y, width, height }
    this.portalSurfaceActive = true
    if (this.view) {
      this.view.setBounds(this.bounds)
      this.view.setVisible(true)
    }
  }

  async readAvatarDataUrl(uid: string): Promise<string | null> {
    if (!/^\d{1,32}$/.test(uid)) return null
    const target = `https://photo.chaoxing.com/p/${uid}_80?temp=${Date.now()}`
    if (!isAllowedPortalUrl(target)) return null
    try {
      const portalSession = session.fromPartition(PORTAL_PARTITION)
      const response = await portalSession.fetch(target, {
        credentials: 'include',
        cache: 'no-store',
        headers: { Referer: 'https://i.chaoxing.com/base' }
      })
      if (response.ok) {
        const contentType = response.headers.get('content-type') ?? ''
        if (contentType.startsWith('image/')) {
          const buffer = Buffer.from(await response.arrayBuffer())
          if (buffer.length >= 32 && buffer.length <= 2 * 1024 * 1024) {
            return `data:${contentType};base64,${buffer.toString('base64')}`
          }
        }
      }
      const fromNet = await new Promise<string | null>((resolve) => {
        const request = net.request({
          url: target,
          session: portalSession,
          useSessionCookies: true,
          redirect: 'follow'
        })
        request.setHeader('Referer', 'https://i.chaoxing.com/base')
        request.on('response', (avatarResponse) => {
          const contentType = String(avatarResponse.headers['content-type'] ?? '')
          if (avatarResponse.statusCode !== 200 || !contentType.startsWith('image/')) {
            avatarResponse.on('data', () => undefined)
            avatarResponse.on('end', () => resolve(null))
            return
          }
          const chunks: Buffer[] = []
          avatarResponse.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
          avatarResponse.on('end', () => {
            const buffer = Buffer.concat(chunks)
            resolve(
              buffer.length >= 32 && buffer.length <= 2 * 1024 * 1024
                ? `data:${contentType};base64,${buffer.toString('base64')}`
                : null
            )
          })
          avatarResponse.on('error', () => resolve(null))
        })
        request.on('error', () => resolve(null))
        request.end()
      })
      if (fromNet) return fromNet
      const contents = this.view?.webContents
      if (!contents || contents.isDestroyed()) return null
      try {
        const rect = (await contents.executeJavaScript(
          `(() => {
            const image = document.querySelector('img.icon-head, img.head-img')
            if (!image) return null
            const box = image.getBoundingClientRect()
            return {
              x: Math.max(0, Math.floor(box.x)),
              y: Math.max(0, Math.floor(box.y)),
              width: Math.max(1, Math.floor(box.width)),
              height: Math.max(1, Math.floor(box.height))
            }
          })()`
        )) as { x: number; y: number; width: number; height: number } | null
        if (!rect) return null
        const image = await contents.capturePage(rect)
        return image.isEmpty() ? null : image.toDataURL()
      } catch {
        return null
      }
    } catch {
      return null
    }
  }

  async openUrl(url: string): Promise<void> {
    this.noteUserNavigation()
    const target = upgradePortalHttpUrl(url) ?? url
    if (!isAllowedPortalUrl(target)) {
      throw new UserFacingError('PORTAL_URL_BLOCKED', '仅支持在学习通官方页面中打开')
    }
    if (!this.view) await this.open('entry-home')
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed()) {
      throw new UserFacingError('PORTAL_NOT_OPEN', '官方页面尚未打开')
    }
    this.appendNavigation('navigate', target, true, null)
    // openUrl 也常用于从学习中心/课程详情进入官方页面；若此前的 hide()
    // 让视图保持隐藏，这里必须恢复显示，否则会出现“页面标题正确但内容空白”。
    this.portalSurfaceActive = true
    if (this.bounds.width > 0 && this.bounds.height > 0) this.view?.setBounds(this.bounds)
    this.view?.setVisible(true)
    await contents.loadURL(target)
    const landedUrl = !contents.isDestroyed() ? contents.getURL() : ''
    if (landedUrl && landedUrl !== this.currentUrl) {
      this.applyNavigatedUrl(landedUrl, 'navigate')
    }
    if (this.bounds.width > 0 && this.bounds.height > 0) this.view?.setBounds(this.bounds)
    this.view?.setVisible(true)
  }

  async open(
    entryId: string,
    options: { visible?: boolean; signal?: AbortSignal } = {}
  ): Promise<void> {
    throwIfAborted(options.signal)
    // 用户主动打开快捷入口/切换视图时推进导航版本；同步读取的隐藏页不改变用户视图。
    if (options.visible !== false) {
      this.noteUserNavigation()
    }
    const navigationVersion = this.userNavigationVersion
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
    const showView = options.visible !== false || this.portalSurfaceActive
    view.webContents.on('before-input-event', (_event, input) => {
      if (!this.syncNavigationActive) return
      if (input.type === 'mouseDown' || input.type === 'keyDown') {
        this.syncUserInteracted = true
      }
    })
    this.attachSecurityHandlers(view)
    window.contentView.addChildView(view)
    view.setVisible(showView)
    if (showView && this.bounds.width > 0 && this.bounds.height > 0) {
      view.setBounds(this.bounds)
    }
    if (navigationVersion !== this.userNavigationVersion) {
      this.destroyView()
      return
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
    const signal = options.signal
    let removeAbortListener: () => void = () => undefined
    try {
      const load = view.webContents.loadURL(entry.url)
      if (!signal) {
        await load
      } else {
        const aborted = new Promise<never>((_resolve, reject) => {
          const onAbort = (): void => {
            try {
              view.webContents.stop()
            } catch {
              // The view may already be gone.
            }
            const error = new Error('请求已取消')
            error.name = 'AbortError'
            reject(error)
          }
          if (signal.aborted) {
            onAbort()
            return
          }
          signal.addEventListener('abort', onAbort, { once: true })
          removeAbortListener = () => signal.removeEventListener('abort', onAbort)
        })
        try {
          await Promise.race([load, aborted])
        } finally {
          removeAbortListener()
        }
      }
      throwIfAborted(signal)
    } catch (error) {
      if (signal?.aborted) throwIfAborted(signal)
      const message = error instanceof Error ? error.message : '官方页面加载失败'
      if (!message.includes('ERR_ABORTED')) {
        this.updateState({ state: 'error', error: '官方页面加载失败，可尝试在系统浏览器中打开' })
      }
    }
  }

  hide(): void {
    this.noteUserNavigation()
    this.portalSurfaceActive = false
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.setVisible(false)
    }
  }

  close(): void {
    this.noteUserNavigation()
    this.portalSurfaceActive = false
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
    if (contents?.canGoBack()) {
      this.noteUserNavigation()
      contents.goBack()
    }
  }

  async forward(): Promise<void> {
    const contents = this.view?.webContents
    if (contents?.canGoForward()) {
      this.noteUserNavigation()
      contents.goForward()
    }
  }

  async reload(): Promise<void> {
    if (!this.view) return
    this.noteUserNavigation()
    this.view.webContents.reload()
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
   * Logs in with the active saved account inside the isolated portal session.
   * The page is opened invisibly; the caller only sees the official page if
   * Chaoxing asks for a captcha or another manual verification step.
   */
  async autoLogin(accountId?: string, signal?: AbortSignal): Promise<PortalAutoLoginResult> {
    throwIfAborted(signal)
    const generation = ++this.autoLoginGeneration
    const stale = (): PortalAutoLoginResult => ({
      ok: false,
      message: '登录请求已被更新的登录操作替代，本次结果已丢弃。',
      needsManual: true
    })
    const credentials = await this.getCredentials?.(accountId)
    throwIfAborted(signal)
    if (!credentials) {
      throw new UserFacingError(
        'CHAOXING_CREDENTIAL_MISSING',
        '请先在账号菜单中保存学习通账号和密码'
      )
    }
    // SEC-002: 不能因为 Portal 仍处于 logged_in 就把当前会话当作目标账号。
    // 每次明确发起自动登录前都先清除隔离会话，再让目标账号重新登录。
    if (this.state.loginState === 'logged_in' || this.view) {
      const safety = this.canSwitchAccount()
      if (!safety.ok) {
        return { ok: false, message: safety.reason ?? '当前页面不适宜切换账号', needsManual: true }
      }
      await this.clearSession(signal)
    }
    throwIfAborted(signal)
    if (generation !== this.autoLoginGeneration) return stale()
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed() || !isChaoxingLoginUrl(contents.getURL())) {
      await this.open('entry-home', { visible: false, ...(signal ? { signal } : {}) })
    }
    throwIfAborted(signal)
    if (generation !== this.autoLoginGeneration) return stale()
    if (!(await this.waitForLoginPage(12_000, signal))) {
      return {
        ok: false,
        message: '未能打开学习通登录页，请手动完成登录。',
        needsManual: true
      }
    }
    throwIfAborted(signal)
    if (generation !== this.autoLoginGeneration) return stale()
    if (!(await this.fillAndSubmitLogin(credentials.username, credentials.password, signal))) {
      return {
        ok: false,
        message: '未找到学习通登录表单，请手动完成登录。',
        needsManual: true
      }
    }
    throwIfAborted(signal)
    const result = await this.waitForLoginResult(25_000, signal)
    throwIfAborted(signal)
    return generation === this.autoLoginGeneration ? result : stale()
  }

  private async waitForLoginPage(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      const contents = this.view?.webContents
      if (contents && !contents.isDestroyed() && isChaoxingLoginUrl(contents.getURL())) return true
      if (this.state.loginState === 'logged_in') return false
      await delay(250)
    }
    throwIfAborted(signal)
    return false
  }

  private async fillAndSubmitLogin(
    username: string,
    password: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    throwIfAborted(signal)
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed()) return false
    const script = buildCredentialLoginScript(username, password)
    const mainFrame = contents.mainFrame
    const frames = [mainFrame, ...mainFrame.framesInSubtree.filter((frame) => frame !== mainFrame)]
    for (const frame of frames) {
      throwIfAborted(signal)
      try {
        if ((await frame.executeJavaScript(script, true)) === true) {
          throwIfAborted(signal)
          return true
        }
      } catch (error) {
        if (signal?.aborted) throw error
        // The login form may live in a nested frame; try the next one.
      }
    }
    return false
  }

  private async waitForLoginResult(
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<PortalAutoLoginResult> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      if (this.state.loginState === 'logged_in') {
        return { ok: true, message: '学习通登录成功', needsManual: false }
      }
      const error = await this.readLoginError(signal)
      throwIfAborted(signal)
      if (error) return { ok: false, message: error, needsManual: true }
      await delay(500)
    }
    throwIfAborted(signal)
    return {
      ok: false,
      message: '登录未完成，可能需要验证码或二次验证，请在官方页面完成。',
      needsManual: true
    }
  }

  private async readLoginError(signal?: AbortSignal): Promise<string | null> {
    throwIfAborted(signal)
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed()) return null
    const script = buildLoginErrorScript()
    const mainFrame = contents.mainFrame
    const frames = [mainFrame, ...mainFrame.framesInSubtree.filter((frame) => frame !== mainFrame)]
    for (const frame of frames) {
      throwIfAborted(signal)
      try {
        const text = (await frame.executeJavaScript(script, true)) as unknown
        throwIfAborted(signal)
        if (typeof text === 'string' && text.trim().length > 0) return text.trim()
      } catch (error) {
        if (signal?.aborted) throw error
        // Ignore inaccessible frames.
      }
    }
    return null
  }

  /**
   * Reads the course grid from the Portal's own frames. The personal-space
   * page builds the iframe src in JavaScript, and the isolated HTTP client can
   * be blocked by Chromium for that cross-subdomain frame; the visible Portal
   * frame already has the authenticated DOM, so use it as the read-only source.
   */
  async readCoursePageHtml(signal?: AbortSignal): Promise<string | null> {
    throwIfAborted(signal)
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed()) return null
    const mainFrame = contents.mainFrame
    const frames = [mainFrame, ...mainFrame.framesInSubtree.filter((frame) => frame !== mainFrame)]
    let best: string | null = null
    let bestCount = 0
    for (const frame of frames) {
      throwIfAborted(signal)
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
   * 打开某门课程的章节页，读取已渲染的章节目录 DOM。
   * 章节页在 mooc2-ans 子 frame 中，主进程 HTTP 请求会被 Chromium 拦截；
   * 这里只读取 Portal 已经渲染的 frame，不提交、不点击任务点。
   */
  async readChapterHtml(courseUrl: string, signal?: AbortSignal): Promise<string | null> {
    throwIfAborted(signal)
    if (this.userNavigationRecent()) return null
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed() || !isAllowedPortalUrl(courseUrl)) return null
    let previous = ''
    try {
      previous = contents.getURL()
    } catch {
      return null
    }
    if (this.userNavigationRecent()) return null
    try {
      await contents.loadURL(courseUrl)
    } catch {
      return null
    }
    try {
      for (let attempt = 0; attempt < 15; attempt += 1) {
        throwIfAborted(signal)
        if (contents.isDestroyed()) return null
        if (attempt === 0 || attempt === 4) {
          try {
            await contents.mainFrame.executeJavaScript(
              "(() => { const el = Array.from(document.querySelectorAll('span.nav_content, a')).find((item) => item.textContent.trim() === '章节'); if (el) { el.click(); return true } return false })()",
              true
            )
          } catch {
            // Navigation may be mid-load; the next attempt retries.
          }
        }
        const frames = [
          contents.mainFrame,
          ...contents.mainFrame.framesInSubtree.filter((frame) => frame !== contents.mainFrame)
        ]
        let best: string | null = null
        let bestCount = 0
        let bestUrl = ''
        for (const frame of frames) {
          try {
            const count = (await frame.executeJavaScript(
              "document.querySelectorAll('.chapter_item, .catalog_name').length",
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
                bestUrl = /^https?:\/\//.test(frame.url) ? frame.url : ''
              }
            }
          } catch {
            // Frame may be detached or still loading.
          }
        }
        if (best && bestCount > 0) {
          return `<div data-studynext-chapter-url="${encodeURIComponent(bestUrl)}"></div>${best}`
        }
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
      return null
    } finally {
      await this.restoreSyncPage(previous, signal)
    }
  }

  /**
   * 打开课程“资料”页并读取文件列表 DOM。
   * “资料”是课程页里的另一个子 frame，只有点击顶部导航后才会加载；
   * 只读取行内容，不打开、不下载任何文件。
   */
  async readMaterialHtml(courseUrl: string, signal?: AbortSignal): Promise<string | null> {
    throwIfAborted(signal)
    if (this.userNavigationRecent()) return null
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed() || !isAllowedPortalUrl(courseUrl)) return null
    let previous = ''
    try {
      previous = contents.getURL()
    } catch {
      return null
    }
    if (this.userNavigationRecent()) return null
    try {
      await contents.loadURL(courseUrl)
    } catch {
      return null
    }
    try {
      let lastCount = 0
      let stableRounds = 0
      for (let attempt = 0; attempt < 20; attempt += 1) {
        throwIfAborted(signal)
        if (contents.isDestroyed()) return null
        if (attempt === 0 || attempt === 4) {
          try {
            await contents.mainFrame.executeJavaScript(
              "(() => { const el = Array.from(document.querySelectorAll('span.nav_content, a')).find((item) => item.textContent.trim() === '资料'); if (el) { el.click(); return true } return false })()",
              true
            )
          } catch {
            // Navigation may be mid-load; retry below.
          }
        }
        const frames = [
          contents.mainFrame,
          ...contents.mainFrame.framesInSubtree.filter((frame) => frame !== contents.mainFrame)
        ]
        let best: string | null = null
        let bestFrame: {
          executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>
        } | null = null
        let bestCount = 0
        let bestTotal = 0
        for (const frame of frames) {
          try {
            const info = (await frame.executeJavaScript(
              `(() => {
                const count = document.querySelectorAll('ul.dataBody_td').length
                const match = (document.body && document.body.innerText || '').match(/当前页共\\s*(\\d+)\\s*个/)
                return { count, total: match ? Number(match[1]) : 0 }
              })()`,
              true
            )) as { count?: number; total?: number }
            const count = typeof info?.count === 'number' ? info.count : 0
            if (count > bestCount) {
              const html = (await frame.executeJavaScript(
                'document.documentElement.outerHTML',
                true
              )) as string
              if (typeof html === 'string' && html.length > 0) {
                best = html
                bestCount = count
                bestFrame = frame
                bestTotal = typeof info?.total === 'number' ? info.total : 0
              }
            }
          } catch {
            // Frame may be detached or still loading.
          }
        }
        if (best && bestCount > 0) {
          stableRounds = bestCount === lastCount ? stableRounds + 1 : 0
          lastCount = bestCount
          if ((bestTotal > 0 && bestCount >= bestTotal) || stableRounds >= 1) {
            const extra = bestFrame ? await this.collectMaterialPages(bestFrame) : ''
            return extra ? `${best}<div data-studynext-more="1">${extra}</div>` : best
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
      return null
    } finally {
      await this.restoreSyncPage(previous, signal)
    }
  }

  /**
   * 资料列表可能分页。只在当前 iframe 内点击页码并合并后续页的条目，
   * 不访问新的域名，也不触发下载。
   */
  private async collectMaterialPages(frame: {
    executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>
  }): Promise<string> {
    try {
      const extra = (await frame.executeJavaScript(
        `(async () => {
          const numeric = (el) => /^\\s*\\d+\\s*$/.test((el && el.textContent) || '')
          const pages = Array.from(document.querySelectorAll('a, button, li'))
            .filter((el) => numeric(el) && Number(el.textContent.trim()) > 1 && Number(el.textContent.trim()) <= 30)
            .map((el) => Number(el.textContent.trim()))
          const unique = Array.from(new Set(pages)).sort((a, b) => a - b).slice(0, 10)
          if (unique.length === 0) return ''
          let html = ''
          for (const page of unique) {
            const target = Array.from(document.querySelectorAll('a, button, li')).find(
              (el) => numeric(el) && Number(el.textContent.trim()) === page
            )
            if (!target) continue
            target.click()
            await new Promise((resolve) => setTimeout(resolve, 900))
            html += Array.from(document.querySelectorAll('ul.dataBody_td'))
              .map((el) => el.outerHTML)
              .join('')
          }
          return html
        })()`,
        true
      )) as string
      return typeof extra === 'string' ? extra : ''
    } catch {
      return ''
    }
  }

  /**
   * 同步时 Portal 可能还没打开，或课程 iframe 仍在加载。这里按需打开个人空间，
   * 轮询等待课程网格渲染完成；只读取 DOM，不注入任何脚本逻辑。
   */
  async ensureCoursePageHtml(signal?: AbortSignal): Promise<string | null> {
    throwIfAborted(signal)
    if (this.userNavigationRecent()) return null
    const existing = await this.readCoursePageHtml(signal)
    if (existing) return existing
    const currentUrl = this.view?.webContents.getURL() ?? ''
    if (this.userNavigationRecent()) return null
    if (!this.view || !currentUrl.startsWith('https://i.chaoxing.com/')) {
      const entries = this.store.listOfficialEntries(false)
      const home =
        entries.find((entry) => entry.id === 'entry-home') ??
        entries.find((entry) => entry.url.includes('i.chaoxing.com'))
      if (!home) return null
      if (this.userNavigationRecent()) return null
      try {
        await this.open(home.id, { visible: false, ...(signal ? { signal } : {}) })
      } catch {
        return null
      }
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      throwIfAborted(signal)
      await new Promise((resolve) => setTimeout(resolve, 500))
      const html = await this.readCoursePageHtml(signal)
      if (html) return html
    }
    return null
  }

  /**
   * 课表页与个人空间同属学习通登录态。HTTP 客户端请求 kb.chaoxing.com 会被
   * Chromium 拦截（ERR_BLOCKED_BY_CLIENT），但课表页自身的同源 fetch 可用；
   * 这里在课表页上下文内逐周拉取，返回不含 Cookie 的 JSON 字符串。
   */
  async readScheduleFromPage(signal?: AbortSignal): Promise<string | null> {
    throwIfAborted(signal)
    if (this.userNavigationRecent()) return null
    const entries = this.store.listOfficialEntries(false)
    const calendar = entries.find((entry) => entry.id === 'entry-calendar')
    if (!calendar) return null
    const contents = this.view?.webContents
    const alreadyOpen =
      contents &&
      !contents.isDestroyed() &&
      contents.getURL().startsWith('https://kb.chaoxing.com/res/pc/curriculum/schedule.html')
    if (!alreadyOpen) {
      if (this.userNavigationRecent()) return null
      try {
        await this.open(calendar.id, { visible: false, ...(signal ? { signal } : {}) })
      } catch {
        return null
      }
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      throwIfAborted(signal)
      const current = this.view?.webContents
      if (!current || current.isDestroyed()) return null
      if (current.getURL().startsWith('https://kb.chaoxing.com/res/pc/curriculum/schedule.html')) {
        const abortPageLoop = (): void => {
          try {
            void current
              .executeJavaScript(
                'window.__studyNextSyncAbort = true; window.__studyNextSyncController?.abort()'
              )
              .catch(() => {})
          } catch {
            // The page may already be gone while a sync is being cancelled.
          }
        }
        signal?.addEventListener('abort', abortPageLoop, { once: true })
        try {
          const result = (await current.executeJavaScript(
            `(async () => {
              window.__studyNextSyncAbort = false
              window.__studyNextSyncController = new AbortController()
              const post = async (body) => {
                if (window.__studyNextSyncAbort) return null
                const response = await fetch('/pc/curriculum/getMyLessons', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                  body,
                  credentials: 'include',
                  signal: window.__studyNextSyncController.signal
                })
                return response.json()
              }
              const first = await post('')
              const maxWeek = Math.min(Number(first && first.data && first.data.curriculum && first.data.curriculum.maxWeek) || 20, 30)
              const weeks = []
              for (let week = 1; week <= maxWeek; week += 1) {
                if (window.__studyNextSyncAbort) break
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
        } finally {
          signal?.removeEventListener('abort', abortPageLoop)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    return null
  }

  /**
   * 考试列表页同样依赖登录态与页面上下文。优先在已打开（或按需打开）的
   * 考试列表页内用同源 fetch 读取全量列表（status=-1），返回纯 HTML 字符串。
   * 不点击“进入考试”，不读取或提交任何答案。
   */
  async readExamListFromPage(signal?: AbortSignal): Promise<string | null> {
    throwIfAborted(signal)
    if (this.userNavigationRecent()) return null
    const entries = this.store.listOfficialEntries(false)
    const exams = entries.find((entry) => entry.id === 'entry-exams')
    if (!exams) return null
    const contents = this.view?.webContents
    const alreadyOpen =
      contents &&
      !contents.isDestroyed() &&
      contents.getURL().includes('/exam-ans/exam/test/examcode/examlist')
    if (!alreadyOpen) {
      if (this.userNavigationRecent()) return null
      try {
        await this.open(exams.id, { visible: false, ...(signal ? { signal } : {}) })
      } catch {
        return null
      }
    }
    for (let attempt = 0; attempt < 25; attempt += 1) {
      throwIfAborted(signal)
      const current = this.view?.webContents
      if (!current || current.isDestroyed()) return null
      if (current.getURL().includes('/exam-ans/exam/test/examcode/examlist')) {
        const abortPageLoop = (): void => {
          try {
            void current
              .executeJavaScript(
                'window.__studyNextSyncAbort = true; window.__studyNextSyncController?.abort()'
              )
              .catch(() => {})
          } catch {
            // The page may already be gone while a sync is being cancelled.
          }
        }
        signal?.addEventListener('abort', abortPageLoop, { once: true })
        try {
          const html = (await current.executeJavaScript(
            `(async () => {
              window.__studyNextSyncAbort = false
              window.__studyNextSyncController = new AbortController()
              const response = await fetch('/exam-ans/exam/test/examcode/examlist?status=-1', {
                method: 'GET',
                credentials: 'include',
                headers: { Accept: 'text/html' },
                signal: window.__studyNextSyncController.signal
              })
              return response.text()
            })()`,
            true
          )) as unknown
          if (typeof html === 'string' && html.length > 0) return html
        } catch {
          // Page may still be loading; retry below.
        } finally {
          signal?.removeEventListener('abort', abortPageLoop)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    return null
  }

  async readNoticeListFromPage(signal?: AbortSignal): Promise<string | null> {
    throwIfAborted(signal)
    if (this.userNavigationRecent()) return null
    const entry = this.store.listOfficialEntries(false).find((item) => item.id === 'entry-notices')
    if (!entry) return null
    const contents = this.view?.webContents
    const alreadyOpen =
      contents &&
      !contents.isDestroyed() &&
      contents.getURL().includes('notice.chaoxing.com/pc/notice/myNotice')
    if (!alreadyOpen) {
      if (this.userNavigationRecent()) return null
      try {
        await this.open(entry.id, { visible: false, ...(signal ? { signal } : {}) })
      } catch {
        return null
      }
    }
    for (let attempt = 0; attempt < 25; attempt += 1) {
      throwIfAborted(signal)
      const current = this.view?.webContents
      if (!current || current.isDestroyed()) return null
      if (current.getURL().includes('notice.chaoxing.com')) {
        const abortPageLoop = (): void => {
          try {
            void current
              .executeJavaScript(
                'window.__studyNextSyncAbort = true; window.__studyNextSyncController?.abort()'
              )
              .catch(() => {})
          } catch {
            // The page may already be gone while a sync is being cancelled.
          }
        }
        signal?.addEventListener('abort', abortPageLoop, { once: true })
        try {
          const raw = (await current.executeJavaScript(
            `(async () => {
              window.__studyNextSyncAbort = false
              window.__studyNextSyncController = new AbortController()
              const all = [];
              let lastValue = 0;
              for (let page = 0; page < 3; page += 1) {
                if (window.__studyNextSyncAbort) break
                const response = await fetch('/pc/notice/getNoticeList', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'include',
                  signal: window.__studyNextSyncController.signal,
                  body: JSON.stringify({ type: 0, notice_type: 0, lastValue, sort: 0, folderUUID: '', kw: '', startTime: '', endTime: '', gKw: '', gName: '', year: '', tag: '', fidsCode: '', filterSenderPuids: '', filterTags: '' })
                });
                const data = await response.json();
                const list = Array.isArray(data?.notices?.list) ? data.notices.list : [];
                all.push(...list);
                const next = Number(data?.notices?.lastGetId ?? 0);
                if (list.length === 0 || !Number.isFinite(next) || next <= 0 || next === lastValue) break;
                lastValue = next;
              }
              return JSON.stringify({ notices: { list: all } });
            })()`,
            true
          )) as unknown
          if (typeof raw === 'string' && raw.length > 0) return raw
        } catch {
          // Page may still be loading; retry below.
        } finally {
          signal?.removeEventListener('abort', abortPageLoop)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    return null
  }

  async clearSession(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    const portalSession = session.fromPartition(PORTAL_PARTITION)
    await portalSession.clearStorageData()
    throwIfAborted(signal)
    await portalSession.clearCache()
    throwIfAborted(signal)
    this.close()
  }

  async clearNavigationLog(): Promise<void> {
    this.updateState({ navigationLog: [] })
  }

  destroy(): void {
    this.destroyView()
  }

  listDownloads(): PortalDownload[] {
    this.hydrateDownloads()
    return [...this.downloads.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  getDownloadDirectoryPath(): string {
    return this.resolveDownloadDirectory()
  }

  async chooseDownloadDirectory(): Promise<string | null> {
    const window = this.getWindow()
    const options: { title: string; properties: Array<'openDirectory' | 'createDirectory'> } = {
      title: '选择资料下载目录',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  }

  async download(url: string): Promise<void> {
    const target = this.normalizeDownloadUrl(url)
    const contents = this.view?.webContents
    if (contents && !contents.isDestroyed()) {
      contents.downloadURL(target)
      return
    }
    session.fromPartition(PORTAL_PARTITION).downloadURL(target)
  }

  async downloadFile(
    url: string,
    suggestedName: string,
    referer = 'https://pan-yz.chaoxing.com/',
    materialId: string | null = null,
    options: {
      allowCdn?: boolean
      attachment?: {
        taskId: string
        objectId: string
        fileName: string
        index?: number | null
      } | null
    } = {}
  ): Promise<PortalDownload> {
    if (materialId) {
      const active = [...this.downloads.values()].find(
        (item) => item.materialId === materialId && item.state === 'progressing'
      )
      if (active) {
        throw new UserFacingError('DOWNLOAD_BUSY', '该资料正在下载，请等待当前任务完成')
      }
    }
    if (options.attachment) {
      const attachment = options.attachment
      const active = [...this.downloads.values()].find(
        (item) =>
          item.attachmentTaskId === attachment.taskId &&
          item.attachmentObjectId === attachment.objectId &&
          item.state === 'progressing'
      )
      if (active) {
        throw new UserFacingError('DOWNLOAD_BUSY', '该附件正在下载，请等待当前任务完成')
      }
    }
    const target = this.normalizeDownloadUrl(url, { allowCdn: options.allowCdn === true })
    const normalizedReferer = this.normalizeDownloadUrl(referer)
    // 学习通下载接口依赖 Portal 分区内的登录 Cookie。入口预热不能阻塞下载
    // 任务的创建：网络较慢或处于离线状态时，等待页面加载会让用户看不到任何
    // 进度。会话 Cookie 本身已持久化，预热只是补充页面上下文。
    if (!this.view) {
      void this.open('entry-home', { visible: false }).catch(() => undefined)
    }
    const directory = this.resolveDownloadDirectory()
    // 初始化阶段必须在创建下载记录前完成；失败直接向 IPC 传播，避免 UI
    // 显示“已开始下载”但队列里没有记录。
    mkdirSync(directory, { recursive: true })
    const filename = uniqueFilename(directory, suggestedName || 'download', this.reservedFilenames)
    this.reservedFilenames.add(filename)
    const savePath = join(directory, filename)
    const id = randomUUID()
    const record: PortalDownload = {
      id,
      filename,
      url: safeDisplayUrl(target),
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: 0,
      startedAt: new Date().toISOString(),
      completedAt: null,
      savePath,
      materialId,
      ...(options.attachment
        ? {
            attachmentTaskId: options.attachment.taskId,
            attachmentObjectId: options.attachment.objectId,
            attachmentFileName: options.attachment.fileName,
            attachmentIndex: options.attachment.index ?? null
          }
        : {})
    }
    this.recordDownload(record)
    this.downloadRetryUrls.set(id, target)
    this.downloadRetryReferers.set(id, normalizedReferer)
    const portalSession = session.fromPartition(PORTAL_PARTITION)
    const request = net.request({
      url: target,
      session: portalSession,
      useSessionCookies: true,
      redirect: 'follow'
    })
    request.setHeader(
      'User-Agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
    )
    request.setHeader('Accept', '*/*')
    request.setHeader('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8')
    const cdnDownload = new URL(target).hostname.toLowerCase().endsWith('cldisk.com')
    if (cdnDownload) {
      // Electron net.request 直接设置跨源 Referer 会被 Chromium 以
      // ERR_BLOCKED_BY_CLIENT 拒绝；在 session 层注入，既保留防盗链语义，
      // 又不影响其他下载目标。
      this.cdnReferers.set(target, normalizedReferer)
    } else {
      request.setHeader('Referer', normalizedReferer)
    }
    this.downloadRequests.set(id, request)
    const completion = new Promise<void>((resolve) => {
      let settled = false
      let received = 0
      let stream: ReturnType<typeof createWriteStream> | null = null
      const fail = (): void => {
        if (settled) return
        settled = true
        if (stream) stream.destroy()
        if (existsSync(savePath)) {
          try {
            unlinkSync(savePath)
          } catch {
            // 保留原始错误语义：下载失败时只清理临时文件。
          }
        }
        this.finishDownload(id, 'interrupted')
        resolve()
      }
      request.on('redirect', (_status, _method, redirectUrl) => {
        try {
          this.normalizeDownloadUrl(redirectUrl, { allowCdn: true })
        } catch {
          request.abort()
          fail()
        }
      })
      request.on('response', (response) => {
        const status = response.statusCode
        const contentType = String(response.headers['content-type'] ?? '').toLowerCase()
        if (status >= 400 || contentType.includes('text/html')) {
          ;(response as unknown as { resume: () => void }).resume()
          fail()
          return
        }
        const total = Number(response.headers['content-length'] ?? 0)
        const current = this.downloads.get(id)
        if (current) this.recordDownload({ ...current, totalBytes: total || 0 })
        if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
        stream = createWriteStream(savePath)
        let lastEmitted = 0
        response.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received - lastEmitted < 256 * 1024) return
          lastEmitted = received
          const item = this.downloads.get(id)
          if (item) this.recordDownload({ ...item, receivedBytes: received })
        })
        response.on('error', fail)
        stream.on('error', fail)
        stream.on('finish', () => {
          if (settled) return
          settled = true
          this.downloadRetryUrls.delete(id)
          this.downloadRetryReferers.delete(id)
          this.finishDownload(id, 'completed', received)
          resolve()
        })
        ;(response as unknown as NodeJS.ReadableStream).pipe(stream)
      })
      request.on('error', fail)
      request.on('abort', fail)
      request.end()
    })
    void completion
      .finally(() => {
        this.downloadRequests.delete(id)
        this.reservedFilenames.delete(filename)
        this.cdnReferers.delete(target)
      })
      .catch(() => undefined)
    return record
  }

  /**
   * 作业附件下载。先通过 Portal 会话读取官方预览页，再解析平台签发的
   * cldisk 下载链接；仅此内部路径允许 cldisk 初始目标，公开下载接口仍受
   * Portal 域名白名单约束。
   */
  async downloadAttachment(
    taskId: string,
    attachmentIndex: number,
    objectId: string,
    fileName: string,
    referer: string
  ): Promise<PortalDownload> {
    const previewUrl = buildAttachmentPreviewUrl(objectId, fileName)
    const normalizedReferer = this.normalizeDownloadUrl(referer)
    const portalSession = session.fromPartition(PORTAL_PARTITION)
    const response = await portalSession.fetch(previewUrl, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Referer: normalizedReferer }
    })
    if (!response.ok) {
      throw new UserFacingError(
        'ATTACHMENT_PREVIEW_FAILED',
        `附件预览页读取失败（HTTP ${response.status}），请确认登录状态后重试。`
      )
    }
    const html = await response.text()
    const downloadUrl = parseAttachmentDownloadUrl(html)
    // downloadFile 现在只等待目录、记录和请求初始化，不等待整段传输；
    // 初始化失败会向上抛给 IPC，传输阶段由下载队列继续更新。
    return await this.downloadFile(downloadUrl, fileName, previewUrl, null, {
      allowCdn: true,
      attachment: {
        taskId,
        objectId,
        fileName,
        index: attachmentIndex
      }
    })
  }

  listMaterialLocalFiles(): MaterialLocalFile[] {
    return resolveVerifiedMaterialLocalFiles(this.store, this.resolveDownloadDirectory())
  }

  async openMaterialLocalFile(materialId: string): Promise<void> {
    const local = resolveVerifiedMaterialLocalFile(
      this.store,
      this.resolveDownloadDirectory(),
      materialId
    )
    if (!local) {
      this.emitMaterialLocalFiles()
      throw new UserFacingError('DOWNLOAD_FILE_MISSING', '文件已被移动或删除，请重新下载')
    }
    const error = await shell.openPath(local.savePath)
    if (error) throw new UserFacingError('DOWNLOAD_OPEN_FAILED', error)
  }

  async revealMaterialLocalFile(materialId: string): Promise<void> {
    const local = resolveVerifiedMaterialLocalFile(
      this.store,
      this.resolveDownloadDirectory(),
      materialId
    )
    if (!local) {
      this.emitMaterialLocalFiles()
      throw new UserFacingError('DOWNLOAD_FILE_MISSING', '文件已被移动或删除，请重新下载')
    }
    shell.showItemInFolder(local.savePath)
  }

  async openDownload(id: string): Promise<void> {
    const item = this.downloads.get(id)
    if (!item) throw new UserFacingError('DOWNLOAD_NOT_FOUND', '下载记录不存在')
    if (item.state !== 'completed')
      throw new UserFacingError('DOWNLOAD_NOT_READY', '文件尚未下载完成')
    const path = this.downloadPath(id)
    if (!existsSync(path)) {
      if (
        invalidateMissingDownloadLocalFile(this.store, this.resolveDownloadDirectory(), item, path)
      ) {
        this.emitMaterialLocalFiles()
      }
      throw new UserFacingError('DOWNLOAD_FILE_MISSING', '文件已被移动或删除，请重新下载')
    }
    const error = await shell.openPath(path)
    if (error) throw new UserFacingError('DOWNLOAD_OPEN_FAILED', error)
  }

  async revealDownload(id: string): Promise<void> {
    const item = this.downloads.get(id)
    if (!item) throw new UserFacingError('DOWNLOAD_NOT_FOUND', '下载记录不存在')
    const path = this.downloadPath(id)
    if (existsSync(path)) {
      shell.showItemInFolder(path)
    } else {
      if (
        invalidateMissingDownloadLocalFile(this.store, this.resolveDownloadDirectory(), item, path)
      ) {
        this.emitMaterialLocalFiles()
      }
      throw new UserFacingError('DOWNLOAD_FILE_MISSING', '文件已被移动或删除，请重新下载')
    }
  }

  cancelDownload(id: string): void {
    const item = this.downloadItems.get(id)
    const request = this.downloadRequests.get(id)
    const progressing = this.downloads.get(id)?.state === 'progressing'
    if (!item && !request && !progressing) return
    // Both Electron DownloadItem.cancel() and net.request.abort() may report
    // as interrupted. Remember the explicit user intent so the final record is
    // persisted as cancelled rather than as a failed download.
    this.cancelledDownloads.add(id)
    if (item) item.cancel()
    if (request) request.abort()
  }

  async retryDownload(id: string): Promise<PortalDownload | null> {
    const item =
      this.downloads.get(id) ?? this.store.listDownloads().find((entry) => entry.id === id)
    if (!item) throw new UserFacingError('DOWNLOAD_NOT_FOUND', '下载记录不存在')
    if (item.state === 'progressing') {
      throw new UserFacingError('DOWNLOAD_BUSY', '该下载仍在进行中')
    }
    if (item.materialId) {
      // Retry / download-again resolves a fresh source from the current
      // account workspace. Temporary signed URLs are never persisted and are
      // not required after the original attempt or an application restart.
      const source = resolveMaterialDownloadSource(this.store, item.materialId)
      return await this.downloadFile(source.url, item.filename, source.referer, source.materialId)
    }
    if (item.attachmentTaskId) {
      if (!item.attachmentObjectId) {
        throw new UserFacingError(
          'ATTACHMENT_SOURCE_UNVERIFIABLE',
          '此下载记录缺少可验证的附件来源，请从任务详情重新发起下载。'
        )
      }
      const source = resolveTaskAttachmentSource(
        this.store.getTask(item.attachmentTaskId),
        item.attachmentObjectId
      )
      if (!source) {
        throw new UserFacingError(
          'ATTACHMENT_SOURCE_EXPIRED',
          '原附件已不存在或来源已变更，请返回任务详情重新选择附件。'
        )
      }
      return await this.downloadAttachment(
        source.taskId,
        source.index,
        source.objectId,
        source.fileName,
        source.referer
      )
    }
    const target = this.downloadRetryUrls.get(id)
    if (!target) {
      throw new UserFacingError(
        'DOWNLOAD_EXPIRED',
        '该历史下载记录没有关联资料，且原下载地址已失效，请从资料中心重新下载'
      )
    }
    const referer = this.downloadRetryReferers.get(id) ?? 'https://pan-yz.chaoxing.com/'
    return await this.downloadFile(target, item.filename, referer, null)
  }

  /**
   * Main-process enforced batch retry for failed downloads:
   * - Respects optional `courseId` scope strictly.
   * - Deduplicates by source so the same material/attachment is retried at most once.
   * - Excludes sources already progressing, already having a verified local file on disk,
   *   or already recovered by a newer completed download.
   */
  async retryFailedDownloads(
    options: {
      courseId?: string | null | undefined
      downloadIds?: string[] | undefined
    } = {}
  ): Promise<BatchRetryResult> {
    this.hydrateDownloads()
    const courseId = options.courseId?.trim() || null
    const materials = this.store.listMaterials()
    const localFiles = this.listMaterialLocalFiles()
    const allDownloads = this.listDownloads()
    const requestedIds = options.downloadIds ? new Set(options.downloadIds) : undefined

    const eligible = selectRetryableFailedDownloads(allDownloads, localFiles, {
      courseId,
      materials,
      requestedIds
    })
    const eligibleIdSet = new Set(eligible.map((item) => item.id))

    const skipped: BatchRetryResult['skipped'] = []
    if (requestedIds) {
      const materialById = new Map(materials.map((item) => [item.id, item]))
      const localMaterialIds = new Set(localFiles.map((item) => item.materialId))
      const activeSources = new Set(
        allDownloads
          .filter((item) => item.state === 'progressing')
          .map((item) => downloadSourceKey(item))
      )
      const eligibleSources = new Set(eligible.map((item) => downloadSourceKey(item)))
      for (const reqId of requestedIds) {
        if (eligibleIdSet.has(reqId)) continue
        const record = allDownloads.find((item) => item.id === reqId)
        if (!record || record.state !== 'interrupted') {
          skipped.push({ id: reqId, reason: 'out_of_scope' })
          continue
        }
        if (courseId) {
          const mat = record.materialId ? materialById.get(record.materialId) : null
          if (!mat || mat.courseId !== courseId) {
            skipped.push({ id: reqId, reason: 'out_of_scope' })
            continue
          }
        }
        const key = downloadSourceKey(record)
        if (activeSources.has(key)) {
          skipped.push({ id: reqId, reason: 'in_progress' })
          continue
        }
        if (record.materialId && localMaterialIds.has(record.materialId)) {
          skipped.push({ id: reqId, reason: 'already_local' })
          continue
        }
        if (eligibleSources.has(key)) {
          skipped.push({ id: reqId, reason: 'duplicate_source' })
          continue
        }
        skipped.push({ id: reqId, reason: 'already_recovered' })
      }
    }

    const startedDownloadIds: string[] = []
    const startedMaterialIds: string[] = []
    const startedItems: BatchRetryResult['startedItems'] = []
    const failed: BatchRetryResult['failed'] = []
    const retriedSources = new Set<string>()

    for (const item of eligible) {
      const key = downloadSourceKey(item)
      if (retriedSources.has(key)) {
        skipped.push({ id: item.id, reason: 'duplicate_source' })
        continue
      }
      retriedSources.add(key)
      try {
        const created = await this.retryDownload(item.id)
        if (created) {
          startedDownloadIds.push(created.id)
          if (created.materialId) startedMaterialIds.push(created.materialId)
          startedItems.push({
            downloadId: created.id,
            materialId: created.materialId ?? null,
            filename: created.filename
          })
        }
      } catch (error) {
        failed.push({
          id: item.id,
          filename: item.filename,
          materialId: item.materialId ?? null,
          error: errorMessage(error)
        })
      }
    }

    return { startedDownloadIds, startedMaterialIds, startedItems, skipped, failed }
  }

  deleteDownload(id: string): void {
    const item = this.downloads.get(id)
    if (item?.state === 'progressing') {
      throw new UserFacingError('DOWNLOAD_BUSY', '该下载仍在进行中，不能删除记录')
    }
    this.downloads.delete(id)
    this.cancelledDownloads.delete(id)
    this.downloadRetryUrls.delete(id)
    this.downloadRetryReferers.delete(id)
    this.store.deleteDownload(id)
  }

  clearDownloads(): void {
    const removable: string[] = []
    for (const [id, item] of this.downloads) {
      if (item.state === 'progressing') continue
      this.downloads.delete(id)
      this.cancelledDownloads.delete(id)
      this.downloadRetryUrls.delete(id)
      this.downloadRetryReferers.delete(id)
      removable.push(id)
    }
    this.store.deleteFinishedDownloads(removable)
  }

  private downloadPath(id: string): string {
    const item = this.downloads.get(id)
    if (!item) return ''
    return item.savePath ?? join(this.resolveDownloadDirectory(), item.filename)
  }

  private resolveDownloadDirectory(): string {
    const configured = this.store.getSettings().downloadDirectory.trim()
    const directory =
      configured && isAbsolute(configured)
        ? configured
        : join(app.getPath('downloads'), 'StudyNext')
    mkdirSync(directory, { recursive: true })
    return directory
  }

  private normalizeDownloadUrl(raw: string, options: { allowCdn?: boolean } = {}): string {
    const target = upgradePortalHttpUrl(raw) ?? raw
    const parsed = new URL(target)
    if (!target.startsWith('https://')) {
      throw new UserFacingError('PORTAL_URL_BLOCKED', '仅支持从学习通官方 HTTPS 域名下载')
    }
    if (parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) {
      throw new UserFacingError('PORTAL_URL_BLOCKED', '下载地址包含不允许的凭据或端口')
    }
    const host = parsed.hostname.toLowerCase()
    const allowed =
      isAllowedPortalUrl(target) ||
      (options.allowCdn === true && (host === 'cldisk.com' || host.endsWith('.cldisk.com')))
    if (!allowed) {
      throw new UserFacingError('PORTAL_URL_BLOCKED', '仅支持从学习通官方 HTTPS 域名下载')
    }
    return target
  }

  private hydrateDownloads(): void {
    if (this.downloadsHydrated) return
    this.downloadsHydrated = true
    this.downloads.clear()
    this.cancelledDownloads.clear()
    for (const [id, record] of recoverDownloads(this.store)) {
      this.downloads.set(id, record)
    }
  }

  private recordDownload(item: PortalDownload): void {
    if (this.writesSuspended) return
    this.downloads.set(item.id, item)
    if (!this.store.readOnly) this.store.upsertDownload(item)
    this.emitDownload(item)
  }

  private emitDownload(item: PortalDownload): void {
    const window = this.getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC.portalDownloadEvent, item)
    }
  }

  private emitMaterialLocalFiles(): void {
    const window = this.getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC.materialsLocalFilesEvent, this.listMaterialLocalFiles())
    }
  }

  private emitUpload(event: PortalUploadEvent): void {
    const window = this.getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC.portalUploadEvent, event)
    }
  }

  private finishDownload(id: string, state: PortalDownload['state'], receivedBytes?: number): void {
    const current = this.downloads.get(id)
    const cancelledByUser = this.cancelledDownloads.delete(id)
    this.downloadRequests.delete(id)
    if (!current) return
    const next: PortalDownload = {
      ...current,
      state: resolveDownloadFinishState(state, cancelledByUser),
      receivedBytes: receivedBytes ?? current.receivedBytes,
      completedAt: new Date().toISOString()
    }
    this.recordDownload(next)
    if (next.state === 'completed' && next.materialId) {
      recordCompletedMaterialLocalFile(this.store, next)
      this.emitMaterialLocalFiles()
    }
  }

  private configureSession(): void {
    if (this.sessionConfigured) return
    this.sessionConfigured = true
    const portalSession = session.fromPartition(PORTAL_PARTITION)
    portalSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })
    portalSession.setPermissionCheckHandler(() => false)
    portalSession.webRequest.onCompleted(
      { urls: ['https://mooc1.chaoxing.com/mooc-ans/work/addStudentWorkNewWeb*'] },
      (details) => {
        if (details.method !== 'POST') return
        this.maybeEmitSubmitDetected(details.url, true)
      }
    )
    const uploadUrls = [
      'https://mooc1.chaoxing.com/upload-ans/ueditorupload/*',
      'https://mooc1.chaoxing.com/upload-ans/*'
    ]
    portalSession.webRequest.onBeforeRequest({ urls: uploadUrls }, (details, callback) => {
      if (details.method === 'POST') {
        this.activeUploads += 1
        this.emitUpload({
          state: 'started',
          url: safeDisplayUrl(details.url),
          statusCode: null,
          message: '附件上传中…',
          detectedAt: new Date().toISOString()
        })
      }
      callback({})
    })
    portalSession.webRequest.onCompleted({ urls: uploadUrls }, (details) => {
      if (details.method !== 'POST') return
      this.activeUploads = Math.max(0, this.activeUploads - 1)
      const outcome = describeUploadCompletion(details.statusCode)
      this.emitUpload({
        state: outcome.state,
        url: safeDisplayUrl(details.url),
        statusCode: details.statusCode,
        message: outcome.message,
        detectedAt: new Date().toISOString()
      })
    })
    portalSession.webRequest.onErrorOccurred({ urls: uploadUrls }, (details) => {
      if (details.method !== 'POST') return
      this.activeUploads = Math.max(0, this.activeUploads - 1)
      const outcome = describeUploadError(details.error)
      this.emitUpload({
        state: outcome.state,
        url: safeDisplayUrl(details.url),
        statusCode: null,
        message: outcome.message,
        detectedAt: new Date().toISOString()
      })
    })
    portalSession.webRequest.onBeforeSendHeaders(
      { urls: ['https://cldisk.com/*', 'https://*.cldisk.com/*'] },
      (details, callback) => {
        details.requestHeaders.Referer =
          this.cdnReferers.get(details.url) ?? 'https://mooc1.chaoxing.com/'
        callback({ requestHeaders: details.requestHeaders })
      }
    )
    portalSession.on('will-download', (_event, item) => {
      const directory = this.resolveDownloadDirectory()
      const filename = uniqueFilename(directory, item.getFilename(), this.reservedFilenames)
      this.reservedFilenames.add(filename)
      const savePath = join(directory, filename)
      item.setSavePath(savePath)
      const id = randomUUID()
      const record: PortalDownload = {
        id,
        filename,
        url: safeDisplayUrl(item.getURL()),
        state: 'progressing',
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        startedAt: new Date().toISOString(),
        completedAt: null,
        savePath
      }
      this.recordDownload(record)
      this.downloadItems.set(id, item)
      item.on('updated', (_event, state) => {
        const current = this.downloads.get(id)
        if (!current) return
        const next: PortalDownload = {
          ...current,
          state: state === 'progressing' ? 'progressing' : 'interrupted',
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes()
        }
        this.recordDownload(next)
      })
      item.once('done', (_event, state) => {
        const current = this.downloads.get(id)
        const cancelledByUser = this.cancelledDownloads.delete(id)
        if (!current) return
        const next: PortalDownload = {
          ...current,
          state: resolveDownloadFinishState(
            state === 'completed'
              ? 'completed'
              : state === 'cancelled'
                ? 'cancelled'
                : 'interrupted',
            cancelledByUser
          ),
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
          completedAt: new Date().toISOString()
        }
        this.recordDownload(next)
        this.downloadItems.delete(id)
      })
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
      this.maybeEmitSubmitDetected(url)
    })
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return
      this.applyNavigatedUrl(url, 'navigate')
      this.maybeEmitSubmitDetected(url)
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

  private maybeEmitSubmitDetected(url: string, isSubmitPost = false): void {
    const isPromptPage = url.includes('/mooc-ans/mooc2/work/prompt') || url.includes('/work/prompt')
    if (!isPromptPage && !isSubmitPost) return
    if (isSubmitPost && url.includes('saveStatus=1')) return
    const now = Date.now()
    if (now - this.lastSubmitDetectedAt < 5000) return
    this.lastSubmitDetectedAt = now
    let platformCourseId: string | null = null
    let platformClazzId: string | null = null
    let platformWorkId: string | null = null
    try {
      const parsed = new URL(url)
      const params = new Map<string, string>()
      for (const [key, value] of parsed.searchParams.entries()) {
        const lower = key.toLowerCase()
        if (!params.has(lower) && value.trim()) params.set(lower, value.trim())
      }
      platformCourseId = params.get('courseid') ?? null
      platformClazzId = params.get('clazzid') ?? params.get('classid') ?? null
      platformWorkId =
        params.get('workid') ??
        params.get('workanswerid') ??
        params.get('answerid') ??
        params.get('taskrefid') ??
        null
    } catch {
      platformCourseId = null
      platformClazzId = null
      platformWorkId = null
    }
    const window = this.getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC.portalSubmitDetected, {
        url: safeDisplayUrl(url),
        platformCourseId,
        platformClazzId,
        platformWorkId,
        detectedAt: new Date().toISOString()
      })
    }
  }

  private applyNavigatedUrl(
    url: string,
    action: PortalNavigationEvent['action'] = 'navigate',
    isMainFrame = true
  ): void {
    if (!this.isNavigationAllowed(url)) {
      if (!isMainFrame) return
      this.appendNavigation('blocked', url, false, '导航离开授权域名')
      this.updateState({
        state: 'blocked',
        error: '已拦截非授权域名的跳转'
      })
      return
    }
    const resolution = resolvePortalNavigation(this.state.loginState, url, isMainFrame)
    if (!resolution) return
    this.appendNavigation(action, resolution.url, true, null)
    this.currentUrl = resolution.url
    this.updateState({
      url: safeDisplayUrl(resolution.url),
      displayUrl: safeDisplayUrl(resolution.url),
      loggedIn:
        resolution.loginState === 'logged_in'
          ? true
          : resolution.loginState === 'logged_out'
            ? false
            : null,
      loginState: resolution.loginState,
      canGoBack: this.view?.webContents.canGoBack() ?? false,
      canGoForward: this.view?.webContents.canGoForward() ?? false,
      state: this.state.state === 'blocked' ? 'blocked' : this.state.state,
      error: resolution.isLoginPage
        ? '请在官方登录页手动完成登录；账号、密码和 Cookie 不会写入日志'
        : null
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function uniqueFilename(directory: string, raw: string, reserved: Set<string> = new Set()): string {
  const trimmed = basename(raw || `download-${Date.now()}`).replace(
    /[<>:"/\\|?*\u0000-\u001f]/g,
    '_'
  )
  const safe = trimmed.trim().slice(0, 140) || `download-${Date.now()}`
  const extension = extname(safe)
  const stem = extension ? safe.slice(0, -extension.length) : safe
  let candidate = safe
  let index = 1
  while (existsSync(join(directory, candidate)) || reserved.has(candidate)) {
    candidate = `${stem} (${index})${extension}`
    index += 1
  }
  return candidate
}
