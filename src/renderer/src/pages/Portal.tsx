import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Globe2,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UploadCloud,
  X
} from 'lucide-react'
import type {
  OfficialEntry,
  PortalDownload,
  PortalSecurityState,
  PortalState,
  PortalUploadEvent
} from '@shared/types'
import type { ToastKind } from '../components/ToastStack'
import { hasOpenModal } from '../components/modal-focus'
import { errorMessage } from '../lib/format'

interface PortalProps {
  entries: OfficialEntry[]
  launchEntryId: string | null
  uiZoom?: number
  onLaunchHandled: () => void
  onClose: () => void
  onSessionCleared?: () => Promise<void> | void
  notify: (kind: ToastKind, message: string) => void
}

const EMPTY_STATE: PortalState = {
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

const NAV_ACTION_LABEL: Record<string, string> = {
  open: '打开',
  navigate: '跳转',
  blocked: '拦截',
  popup: '弹窗'
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function Portal({
  entries,
  launchEntryId,
  uiZoom = 1,
  onLaunchHandled,
  onClose,
  onSessionCleared,
  notify
}: PortalProps): JSX.Element {
  const [state, setState] = useState<PortalState>(EMPTY_STATE)
  const [security, setSecurity] = useState<PortalSecurityState | null>(null)
  const [boundsReady, setBoundsReady] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [busy, setBusy] = useState(false)
  const [downloads, setDownloads] = useState<PortalDownload[]>([])
  const [showDownloads, setShowDownloads] = useState(false)
  const [showTools, setShowTools] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<PortalUploadEvent | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const api = window.studynext

  useEffect(() => {
    let alive = true
    void api.portal
      .state()
      .then((next) => {
        if (alive) setState(next)
      })
      .catch((error: unknown) => notify('error', errorMessage(error)))
    void api.portal
      .securityState()
      .then((next) => {
        if (alive) setSecurity(next)
      })
      .catch(() => undefined)
    const unsubscribe = api.portal.onState((next) => setState(next))
    const unsubscribeDownload = api.portal.onDownload((item) => {
      setDownloads((current) => {
        const next = current.filter((entry) => entry.id !== item.id)
        return [item, ...next]
      })
    })
    const unsubscribeUpload = api.portal.onUpload((event) => setUploadStatus(event))
    void api.portal
      .downloads()
      .then((items) => {
        if (alive) setDownloads(items)
      })
      .catch(() => undefined)
    return () => {
      alive = false
      unsubscribe()
      unsubscribeDownload()
      unsubscribeUpload()
      void api.portal.hide()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (hasOpenModal()) return
      if (confirmClear) {
        event.preventDefault()
        event.stopPropagation()
        setConfirmClear(false)
        return
      }
      if (showDownloads) {
        event.preventDefault()
        event.stopPropagation()
        setShowDownloads(false)
        return
      }
      if (showTools) {
        event.preventDefault()
        event.stopPropagation()
        setShowTools(false)
        return
      }
      event.preventDefault()
      event.stopPropagation()
      void api.portal.hide()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [api.portal, confirmClear, onClose, showDownloads, showTools])

  useEffect(() => {
    if (!uploadStatus || uploadStatus.state === 'started') return
    const timer = window.setTimeout(() => setUploadStatus(null), 4000)
    return () => window.clearTimeout(timer)
  }, [uploadStatus])

  useLayoutEffect(() => {
    const node = stageRef.current
    if (!node) {
      setBoundsReady(false)
      return
    }
    const syncBounds = (): void => {
      const rect = node.getBoundingClientRect()
      if (rect.width < 8 || rect.height < 8) return
      setBoundsReady(true)
      void api.portal
        .setBounds({
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        })
        .catch(() => undefined)
    }
    syncBounds()
    const frame = window.requestAnimationFrame(syncBounds)
    const retryTimer = window.setTimeout(syncBounds, 260)
    const observer = new ResizeObserver(syncBounds)
    observer.observe(node)
    window.addEventListener('resize', syncBounds)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(retryTimer)
      observer.disconnect()
      window.removeEventListener('resize', syncBounds)
    }
  }, [api.portal, state.url, showDownloads, showTools, uploadStatus, uiZoom])

  useEffect(() => {
    if (!launchEntryId || !boundsReady) return
    onLaunchHandled()
    void api.portal
      .open(launchEntryId)
      .catch((error: unknown) => notify('error', errorMessage(error)))
  }, [launchEntryId, boundsReady, api.portal, notify, onLaunchHandled])

  const active = state.url.length > 0 && state.state !== 'idle'
  const activeEntry = entries.find((entry) => entry.id === state.entryId)
  const isLoading = state.state === 'loading'
  const activeDownloadCount = downloads.filter((item) => item.state === 'progressing').length

  const openEntry = async (entry: OfficialEntry): Promise<void> => {
    setBusy(true)
    setShowTools(false)
    try {
      await api.portal.open(entry.id)
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const runAction = async (action: () => Promise<void>, success?: string): Promise<void> => {
    setBusy(true)
    try {
      await action()
      if (success) notify('success', success)
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setBusy(false)
      setConfirmClear(false)
    }
  }

  const handleClose = (): void => {
    void api.portal.hide()
    onClose()
  }

  const loginLabel =
    state.loginState === 'logged_in' || state.loggedIn === true
      ? '已登录'
      : state.loginState === 'logged_out' || state.loggedIn === false
        ? '未登录'
        : null

  const cleanUrl = (state.displayUrl || '').replace(/^https?:\/\//i, '')

  return (
    <div className="studio-portal">
      <div className="studio-portal-bar">
        <button
          type="button"
          className="portal-return-btn"
          onClick={handleClose}
          title="返回 StudyNext（Esc）"
        >
          <ArrowLeft size={14} />
          <span>返回应用</span>
        </button>

        <span className="studio-portal-sep" aria-hidden="true" />

        <div className="studio-portal-nav-group" role="group" aria-label="页面导航">
          <button
            type="button"
            className="studio-portal-icon"
            onClick={() => void runAction(() => api.portal.back())}
            disabled={!active || !state.canGoBack || busy}
            title="后退"
            aria-label="后退"
          >
            <ChevronLeft size={15} />
          </button>
          <button
            type="button"
            className="studio-portal-icon"
            onClick={() => void runAction(() => api.portal.forward())}
            disabled={!active || !state.canGoForward || busy}
            title="前进"
            aria-label="前进"
          >
            <ChevronRight size={15} />
          </button>
          <button
            type="button"
            className="studio-portal-icon"
            onClick={() => void runAction(() => api.portal.reload())}
            disabled={!active || busy}
            title="刷新页面"
            aria-label="刷新"
          >
            <RefreshCw size={13} className={isLoading ? 'spin' : undefined} />
          </button>
        </div>

        <div className="studio-portal-omnibox" title={state.url || '学习通隔离会话'}>
          <ShieldCheck
            size={13}
            className={
              state.state === 'error' || state.state === 'blocked'
                ? 'omnibox-lock error'
                : 'omnibox-lock'
            }
          />
          {state.title ? <span className="omnibox-title">{state.title}</span> : null}
          {state.title && cleanUrl ? <span className="omnibox-sep">·</span> : null}
          <span className="omnibox-url">{cleanUrl || '正在准备学习通官方页面…'}</span>
          {isLoading ? (
            <span className="omnibox-pill loading">加载中</span>
          ) : state.state === 'blocked' ? (
            <span className="omnibox-pill danger">已拦截</span>
          ) : state.state === 'error' ? (
            <span className="omnibox-pill danger">加载失败</span>
          ) : loginLabel ? (
            <span className={loginLabel === '已登录' ? 'omnibox-pill ok' : 'omnibox-pill'}>
              {loginLabel}
            </span>
          ) : null}
        </div>

        <div className="studio-portal-actions">
          <button
            type="button"
            className={showDownloads ? 'studio-portal-btn active' : 'studio-portal-btn'}
            onClick={() => {
              setShowDownloads((open) => !open)
              setShowTools(false)
            }}
            aria-expanded={showDownloads}
            title="下载管理器"
          >
            <Download size={13} />
            <span>下载</span>
            {activeDownloadCount > 0 ? (
              <span className="studio-pill-badge">{activeDownloadCount}</span>
            ) : null}
          </button>

          <button
            type="button"
            className="studio-portal-btn"
            onClick={() => void runAction(() => api.portal.openInitialInBrowser())}
            disabled={!active || busy}
            title="在系统默认浏览器中打开当前页面"
          >
            <ExternalLink size={13} />
            <span>浏览器打开</span>
          </button>

          <button
            type="button"
            className={showTools ? 'studio-portal-icon active' : 'studio-portal-icon'}
            onClick={() => {
              setShowTools((open) => !open)
              setShowDownloads(false)
            }}
            aria-expanded={showTools}
            aria-label="页面入口与会话诊断"
            title="快捷入口与会话诊断"
          >
            <SlidersHorizontal size={14} />
          </button>
        </div>

        {isLoading ? <span className="studio-portal-progress" aria-hidden="true" /> : null}
      </div>

      {uploadStatus ? (
        <div className={`studio-portal-banner ${uploadStatus.state}`}>
          <UploadCloud size={14} />
          <span>
            <strong>
              {uploadStatus.state === 'started'
                ? '附件上传中'
                : uploadStatus.state === 'completed'
                  ? '附件上传成功'
                  : '附件上传失败'}
            </strong>{' '}
            {uploadStatus.message}
          </span>
        </div>
      ) : null}

      {state.error ? (
        <div
          className={
            state.state === 'error' || state.state === 'blocked'
              ? 'studio-portal-banner error'
              : 'studio-portal-banner'
          }
        >
          <LockKeyhole size={14} />
          <span>
            {state.state === 'blocked' ? (
              <strong>已阻止不安全跳转：</strong>
            ) : state.state === 'error' ? (
              <strong>官方页面未能完成加载：</strong>
            ) : null}
            {state.error}
          </span>
          {state.state === 'error' ? (
            <button
              type="button"
              className="studio-action-pill"
              onClick={() => void runAction(() => api.portal.openInitialInBrowser())}
            >
              改用系统浏览器
            </button>
          ) : null}
        </div>
      ) : null}

      {showDownloads ? (
        <section className="studio-portal-drawer">
          <div className="studio-portal-drawer-head">
            <div>
              <strong>下载管理</strong>
              <span>文件保存在系统下载目录 / StudyNext，携带当前隔离会话登录态。</span>
            </div>
            <div className="studio-portal-drawer-actions">
              <button
                type="button"
                className="text-link"
                disabled={downloads.every((item) => item.state === 'progressing')}
                onClick={() => {
                  void api.portal
                    .clearDownloads()
                    .then(() => api.portal.downloads())
                    .then(setDownloads)
                    .catch((error: unknown) => notify('error', errorMessage(error)))
                }}
              >
                清空已完成
              </button>
              <button
                type="button"
                className="studio-portal-icon"
                aria-label="关闭下载面板"
                onClick={() => setShowDownloads(false)}
              >
                <X size={14} />
              </button>
            </div>
          </div>
          {downloads.length === 0 ? (
            <div className="studio-portal-drawer-empty">暂无下载任务。</div>
          ) : (
            <div className="portal-download-list">
              {downloads.map((item) => {
                const percent =
                  item.totalBytes > 0
                    ? Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100))
                    : null
                return (
                  <div className="portal-download-row" key={item.id}>
                    <div className="portal-download-name" title={item.filename}>
                      {item.filename}
                    </div>
                    <div className="portal-download-state">
                      {item.state === 'progressing'
                        ? percent === null
                          ? formatBytes(item.receivedBytes)
                          : `${percent}% · ${formatBytes(item.receivedBytes)} / ${formatBytes(item.totalBytes)}`
                        : item.state === 'completed'
                          ? `已完成 · ${formatBytes(item.receivedBytes)}`
                          : item.state === 'cancelled'
                            ? '已取消'
                            : '中断'}
                    </div>
                    <div className="portal-download-actions">
                      {item.state === 'completed' ? (
                        <>
                          <button
                            type="button"
                            className="text-link"
                            onClick={() =>
                              void api.portal
                                .openDownload(item.id)
                                .catch((error: unknown) => notify('error', errorMessage(error)))
                            }
                          >
                            打开
                          </button>
                          <button
                            type="button"
                            className="text-link"
                            onClick={() =>
                              void api.portal
                                .revealDownload(item.id)
                                .catch((error: unknown) => notify('error', errorMessage(error)))
                            }
                          >
                            文件夹
                          </button>
                        </>
                      ) : item.state === 'progressing' ? (
                        <button
                          type="button"
                          className="text-link"
                          onClick={() =>
                            void api.portal
                              .cancelDownload(item.id)
                              .catch((error: unknown) => notify('error', errorMessage(error)))
                          }
                        >
                          取消
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="text-link"
                          onClick={() => {
                            void api.portal
                              .retryDownload(item.id)
                              .then(() => api.portal.downloads())
                              .then(setDownloads)
                              .catch((error: unknown) => notify('error', errorMessage(error)))
                          }}
                        >
                          重试
                        </button>
                      )}
                      {item.state !== 'progressing' ? (
                        <button
                          type="button"
                          className="text-link danger-link"
                          onClick={() => {
                            void api.portal
                              .deleteDownload(item.id)
                              .then(() => api.portal.downloads())
                              .then(setDownloads)
                              .catch((error: unknown) => notify('error', errorMessage(error)))
                          }}
                        >
                          删除
                        </button>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      ) : null}

      {showTools ? (
        <section className="studio-portal-drawer">
          <div className="studio-portal-drawer-head">
            <div>
              <strong>快捷入口与会话安全</strong>
              <span>
                隔离分区：{security?.partition ?? 'persist:studynext-portal'} ·
                仅允许学习通官方及可信校园域名
              </span>
            </div>
            <div className="studio-portal-drawer-actions">
              {confirmClear ? (
                <>
                  <button
                    type="button"
                    className="btn small danger"
                    onClick={() =>
                      void runAction(async () => {
                        await api.portal.clearSession()
                        await onSessionCleared?.()
                      }, '隔离会话已清除')
                    }
                    disabled={busy}
                  >
                    确认清除会话
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => setConfirmClear(false)}
                  >
                    取消
                  </button>
                </>
              ) : (
                <button type="button" className="btn small" onClick={() => setConfirmClear(true)}>
                  <Trash2 size={12} /> 清除会话 Cookie
                </button>
              )}
              <button
                type="button"
                className="studio-portal-icon"
                aria-label="关闭工具面板"
                onClick={() => setShowTools(false)}
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="studio-portal-quick-entries">
            {entries
              .filter((entry) => entry.enabled)
              .map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={
                    state.entryId === entry.id ? 'studio-action-pill primary' : 'studio-action-pill'
                  }
                  onClick={() => void openEntry(entry)}
                  disabled={busy}
                >
                  <Globe2 size={12} /> {entry.label}
                </button>
              ))}
          </div>

          {state.navigationLog.length > 0 ? (
            <div className="studio-portal-log">
              <div className="studio-portal-log-head">
                <span>最近跳转（{state.navigationLog.length}）</span>
                <button
                  type="button"
                  className="text-link"
                  onClick={() => {
                    void api.portal
                      .clearNavigationLog()
                      .then(() => api.portal.state())
                      .then(setState)
                      .catch((error: unknown) => notify('error', errorMessage(error)))
                  }}
                >
                  清空记录
                </button>
              </div>
              {state.navigationLog.slice(0, 6).map((item) => (
                <div className={`portal-audit-row ${item.allowed ? '' : 'blocked'}`} key={item.id}>
                  <span className="portal-audit-action">
                    {NAV_ACTION_LABEL[item.action] ?? item.action}
                  </span>
                  <span className="portal-audit-url" title={item.displayUrl}>
                    {item.displayUrl}
                  </span>
                  <span className="portal-audit-state">
                    {item.allowed ? '允许' : `拦截：${item.reason ?? '未授权'}`}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="studio-portal-stage" ref={stageRef}>
        <div className="portal-placeholder">
          <Globe2 size={24} />
          <div className="portal-placeholder-title">
            {activeEntry?.label ?? state.title ?? '学习通官方页面'}
          </div>
          <div className="portal-placeholder-sub">
            {isLoading ? '正在加载学习通官方页面…' : '页面视图准备就绪'}
          </div>
        </div>
      </div>
    </div>
  )
}
