import { app, BrowserWindow, dialog, net, WebContentsView, session, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'
import type {
  PortalDownload,
  PortalLoginState,
  PortalNavigationEvent,
  PortalState
} from '@shared/types'
import { PORTAL_PARTITION } from '@shared/constants'
import { IPC } from '@shared/ipc'
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
  private readonly downloads = new Map<string, PortalDownload>()
  private readonly downloadItems = new Map<string, Electron.DownloadItem>()
  private readonly downloadRequests = new Map<string, { abort: () => void }>()
  private readonly reservedFilenames = new Set<string>()
  private downloadsHydrated = false
  private lastSubmitDetectedAt = 0

  constructor(
    private readonly store: StudyNextStore,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly getCredentials?: () => Promise<{ username: string; password: string } | null>
  ) {
    this.hydrateDownloads()
  }

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

  async openUrl(url: string): Promise<void> {
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
    await contents.loadURL(target)
  }

  async open(entryId: string): Promise<void> {    const entry = this.store.getOfficialEntry(entryId)
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
   * 打开某门课程的章节页，读取已渲染的章节目录 DOM。
   * 章节页在 mooc2-ans 子 frame 中，主进程 HTTP 请求会被 Chromium 拦截；
   * 这里只读取 Portal 已经渲染的 frame，不提交、不点击任务点。
   */
  async readChapterHtml(courseUrl: string): Promise<string | null> {
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed() || !isAllowedPortalUrl(courseUrl)) return null
    const previous = contents.getURL()
    try {
      await contents.loadURL(courseUrl)
    } catch {
      return null
    }
    try {
      for (let attempt = 0; attempt < 15; attempt += 1) {
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
              }
            }
          } catch {
            // Frame may be detached or still loading.
          }
        }
        if (best && bestCount > 0) return best
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
      return null
    } finally {
      if (previous && previous !== courseUrl && isAllowedPortalUrl(previous)) {
        void contents.loadURL(previous).catch(() => undefined)
      }
    }
  }

  /**
   * 打开课程“资料”页并读取文件列表 DOM。
   * “资料”是课程页里的另一个子 frame，只有点击顶部导航后才会加载；
   * 只读取行内容，不打开、不下载任何文件。
   */
  async readMaterialHtml(courseUrl: string): Promise<string | null> {
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed() || !isAllowedPortalUrl(courseUrl)) return null
    const previous = contents.getURL()
    try {
      await contents.loadURL(courseUrl)
    } catch {
      return null
    }
    try {
      let lastCount = 0
      let stableRounds = 0
      for (let attempt = 0; attempt < 20; attempt += 1) {
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
        let bestFrame: { executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown> } | null =
          null
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
      if (previous && previous !== courseUrl && isAllowedPortalUrl(previous)) {
        void contents.loadURL(previous).catch(() => undefined)
      }
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
  async ensureCoursePageHtml(): Promise<string | null> {
    const existing = await this.readCoursePageHtml()
    if (existing) return existing
    const currentUrl = this.view?.webContents.getURL() ?? ''
    if (!this.view || !currentUrl.startsWith('https://i.chaoxing.com/')) {
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

  /**
   * 考试列表页同样依赖登录态与页面上下文。优先在已打开（或按需打开）的
   * 考试列表页内用同源 fetch 读取全量列表（status=-1），返回纯 HTML 字符串。
   * 不点击“进入考试”，不读取或提交任何答案。
   */
  async readExamListFromPage(): Promise<string | null> {
    const entries = this.store.listOfficialEntries(false)
    const exams = entries.find((entry) => entry.id === 'entry-exams')
    if (!exams) return null
    const contents = this.view?.webContents
    const alreadyOpen =
      contents &&
      !contents.isDestroyed() &&
      contents.getURL().includes('/exam-ans/exam/test/examcode/examlist')
    if (!alreadyOpen) {
      try {
        await this.open(exams.id)
      } catch {
        return null
      }
    }
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const current = this.view?.webContents
      if (!current || current.isDestroyed()) return null
      if (current.getURL().includes('/exam-ans/exam/test/examcode/examlist')) {
        try {
          const html = (await current.executeJavaScript(
            `fetch('/exam-ans/exam/test/examcode/examlist?status=-1', {
               method: 'GET', credentials: 'include', headers: { Accept: 'text/html' }
             }).then((response) => response.text())`,
            true
          )) as unknown
          if (typeof html === 'string' && html.length > 0) return html
        } catch {
          // Page may still be loading; retry below.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    return null
  }

  async readNoticeListFromPage(): Promise<string | null> {
    const entry = this.store.listOfficialEntries(false).find((item) => item.id === 'entry-notices')
    if (!entry) return null
    const contents = this.view?.webContents
    const alreadyOpen =
      contents &&
      !contents.isDestroyed() &&
      contents.getURL().includes('notice.chaoxing.com/pc/notice/myNotice')
    if (!alreadyOpen) {
      try {
        await this.open(entry.id)
      } catch {
        return null
      }
    }
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const current = this.view?.webContents
      if (!current || current.isDestroyed()) return null
      if (current.getURL().includes('notice.chaoxing.com')) {
        try {
          const raw = (await current.executeJavaScript(
            `(async () => {
              const all = [];
              let lastValue = 0;
              for (let page = 0; page < 3; page += 1) {
                const response = await fetch('/pc/notice/getNoticeList', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'include',
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

  async downloadFile(url: string, suggestedName: string, referer = 'https://pan-yz.chaoxing.com/'): Promise<void> {
    const target = this.normalizeDownloadUrl(url)
    const directory = this.resolveDownloadDirectory()
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
      savePath
    }
    this.recordDownload(record)
    const portalSession = session.fromPartition(PORTAL_PARTITION)
    const request = net.request({
      url: target,
      session: portalSession,
      useSessionCookies: true,
      redirect: 'follow'
    })
    request.setHeader('Referer', this.normalizeDownloadUrl(referer))
    this.downloadRequests.set(id, request)
    await new Promise<void>((resolve) => {
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
          this.finishDownload(id, 'completed', received)
          resolve()
        })
        ;(response as unknown as NodeJS.ReadableStream).pipe(stream)
      })
      request.on('error', fail)
      request.on('abort', fail)
      request.end()
    }).finally(() => {
      this.downloadRequests.delete(id)
      this.reservedFilenames.delete(filename)
    })
  }

  async openDownload(id: string): Promise<void> {
    const item = this.downloads.get(id)
    if (!item) throw new UserFacingError('DOWNLOAD_NOT_FOUND', '下载记录不存在')
    if (item.state !== 'completed') throw new UserFacingError('DOWNLOAD_NOT_READY', '文件尚未下载完成')
    const path = this.downloadPath(id)
    if (!existsSync(path)) {
      throw new UserFacingError('DOWNLOAD_FILE_MISSING', '文件已被移动或删除，请重新下载')
    }
    const error = await shell.openPath(path)
    if (error) throw new UserFacingError('DOWNLOAD_OPEN_FAILED', error)
  }

  async revealDownload(id: string): Promise<void> {
    const item = this.downloads.get(id)
    if (!item) throw new UserFacingError('DOWNLOAD_NOT_FOUND', '下载记录不存在')
    const path = this.downloadPath(id)
    if (existsSync(path)) shell.showItemInFolder(path)
  }

  cancelDownload(id: string): void {
    const item = this.downloadItems.get(id)
    if (item) item.cancel()
    const request = this.downloadRequests.get(id)
    if (request) request.abort()  }

  clearDownloads(): void {
    const removable: string[] = []
    for (const [id, item] of this.downloads) {
      if (item.state === 'progressing') continue
      this.downloads.delete(id)
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
    for (const item of this.store.listDownloads()) {
      const stale = item.state === 'progressing'
      if (stale && item.savePath && existsSync(item.savePath)) {
        try {
          unlinkSync(item.savePath)
        } catch {
          // 重启恢复时尽力清理未完成的临时文件。
        }
      }
      const record: PortalDownload = stale
        ? { ...item, state: 'interrupted', completedAt: new Date().toISOString() }
        : item
      this.downloads.set(record.id, record)
      if (stale) this.store.upsertDownload(record)
    }
  }

  private recordDownload(item: PortalDownload): void {
    this.downloads.set(item.id, item)
    this.store.upsertDownload(item)
    this.emitDownload(item)
  }

  private emitDownload(item: PortalDownload): void {
    const window = this.getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC.portalDownloadEvent, item)
    }
  }

  private finishDownload(id: string, state: PortalDownload['state'], receivedBytes?: number): void {
    const current = this.downloads.get(id)
    this.downloadRequests.delete(id)
    if (!current) return
    const next: PortalDownload = {
      ...current,
      state,
      receivedBytes: receivedBytes ?? current.receivedBytes,
      completedAt: new Date().toISOString()
    }
    this.recordDownload(next)
    this.emitDownload(next)
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
        if (!current) return
        const next: PortalDownload = {
          ...current,
          state: state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted',
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
    contents.on('did-navigate-in-page', (_event, url) => {
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
    try {
      const parsed = new URL(url)
      platformCourseId = parsed.searchParams.get('courseId') ?? parsed.searchParams.get('courseid')
    } catch {
      platformCourseId = null
    }
    const window = this.getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC.portalSubmitDetected, {
        url: safeDisplayUrl(url),
        platformCourseId,
        detectedAt: new Date().toISOString()
      })
    }
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

function uniqueFilename(directory: string, raw: string, reserved: Set<string> = new Set()): string {
  const trimmed = basename(raw || `download-${Date.now()}`).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
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
