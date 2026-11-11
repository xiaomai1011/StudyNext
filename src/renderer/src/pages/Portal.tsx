import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe2,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react'
import type { OfficialEntry, PortalSecurityState, PortalState } from '@shared/types'
import type { ToastKind } from '../components/ToastStack'
import { errorMessage } from '../lib/format'

interface PortalProps {
  entries: OfficialEntry[]
  launchEntryId: string | null
  onLaunchHandled: () => void
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
  error: null
}

export function Portal({ entries, launchEntryId, onLaunchHandled, notify }: PortalProps) {
  const [state, setState] = useState<PortalState>(EMPTY_STATE)
  const [security, setSecurity] = useState<PortalSecurityState | null>(null)
  const [boundsReady, setBoundsReady] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [busy, setBusy] = useState(false)
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
    return () => {
      alive = false
      unsubscribe()
      void api.portal.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    const observer = new ResizeObserver(syncBounds)
    observer.observe(node)
    window.addEventListener('resize', syncBounds)
    const scrollParent = node.closest('.main-scroll')
    scrollParent?.addEventListener('scroll', syncBounds, { passive: true })
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncBounds)
      scrollParent?.removeEventListener('scroll', syncBounds)
    }
  }, [api.portal, state.url])

  useEffect(() => {
    if (!launchEntryId || !boundsReady) return
    onLaunchHandled()
    void api.portal
      .open(launchEntryId)
      .catch((error: unknown) => notify('error', errorMessage(error)))
  }, [launchEntryId, boundsReady, api.portal, notify, onLaunchHandled])

  const active = state.url.length > 0 && state.state !== 'idle'
  const activeEntry = entries.find((entry) => entry.id === state.entryId)

  const openEntry = async (entry: OfficialEntry): Promise<void> => {
    setBusy(true)
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

  const loginLabel =
    state.loggedIn === true ? '已登录' : state.loggedIn === false ? '未登录' : '登录状态未知'
  const statusClass =
    state.state === 'ready'
      ? 'ready'
      : state.state === 'error' || state.state === 'blocked'
        ? 'error'
        : ''

  return (
    <div className="portal-page">
      <header className="page-header" style={{ marginBottom: 12 }}>
        <div className="page-header-copy">
          <div className="eyebrow">
            <Globe2 size={12} /> 学习通兼容层
          </div>
          <h1 className="page-title">官方页面</h1>
          <p className="page-subtitle">
            在隔离的浏览器视图中手动登录学习通。远程页面无法访问本机 Node.js、数据库或文件系统。
          </p>
        </div>
        <div className="header-actions">
          <span className="hero-note">
            <LockKeyhole size={13} /> 隔离会话 · 手动登录
          </span>
        </div>
      </header>

      <div className="portal-toolbar">
        <button
          type="button"
          className="portal-nav-btn"
          onClick={() => void runAction(() => api.portal.back())}
          disabled={!active || !state.canGoBack || busy}
          aria-label="后退"
        >
          <ArrowLeft />
        </button>
        <button
          type="button"
          className="portal-nav-btn"
          onClick={() => void runAction(() => api.portal.forward())}
          disabled={!active || !state.canGoForward || busy}
          aria-label="前进"
        >
          <ArrowRight />
        </button>
        <button
          type="button"
          className="portal-nav-btn"
          onClick={() => void runAction(() => api.portal.reload())}
          disabled={!active || busy}
          aria-label="刷新"
        >
          <RefreshCw />
        </button>
        <div className="portal-url" title={state.url || '尚未打开官方页面'}>
          <ShieldCheck />
          <span>{state.displayUrl || '尚未打开官方页面'}</span>
        </div>
        <span className={`portal-status ${statusClass}`}>
          {state.state === 'loading'
            ? '加载中'
            : state.state === 'ready'
              ? '已加载'
              : state.state === 'blocked'
                ? '已拦截'
                : state.state === 'error'
                  ? '加载失败'
                  : '待访问'}
        </span>
        <span className={`portal-status ${state.loggedIn === true ? 'ready' : ''}`}>
          {loginLabel}
        </span>
        <button
          type="button"
          className="portal-nav-btn"
          onClick={() => void runAction(() => api.portal.openInitialInBrowser())}
          disabled={!active || busy}
          title="在系统浏览器中打开当前页面"
          aria-label="在系统浏览器中打开"
        >
          <ExternalLink />
        </button>
        {confirmClear ? (
          <>
            <button
              type="button"
              className="btn small danger"
              onClick={() => void runAction(() => api.portal.clearSession(), '隔离会话已清除')}
              disabled={busy}
            >
              确认清除
            </button>
            <button
              type="button"
              className="btn small"
              onClick={() => setConfirmClear(false)}
              disabled={busy}
            >
              取消
            </button>
          </>
        ) : (
          <button
            type="button"
            className="portal-nav-btn"
            onClick={() => setConfirmClear(true)}
            title="清除隔离会话中的 Cookie 与缓存"
            aria-label="清除隔离会话"
          >
            <Trash2 />
          </button>
        )}
        <button
          type="button"
          className="portal-nav-btn"
          onClick={() => void runAction(() => api.portal.close())}
          disabled={!active || busy}
          title="关闭当前官方页面"
          aria-label="关闭当前页面"
        >
          <X />
        </button>
      </div>

      {state.error ? (
        <div className="sync-banner" style={{ marginBottom: 10 }}>
          <LockKeyhole />
          <span>
            <strong>
              {state.state === 'blocked' ? '已阻止不安全跳转。' : '官方页面未能完成加载。'}
            </strong>{' '}
            {state.error}
            {state.state === 'error' ? (
              <button
                type="button"
                className="text-link"
                style={{ marginLeft: 8 }}
                onClick={() => void runAction(() => api.portal.openInitialInBrowser())}
              >
                改用系统浏览器
              </button>
            ) : null}
          </span>
        </div>
      ) : null}

      {active ? (
        <div className="portal-stage" ref={stageRef} style={{ minHeight: 320 }}>
          <div className="portal-placeholder">
            <Globe2 />
            <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--text-soft)' }}>
              {activeEntry?.label ?? state.title ?? '学习通官方页面'}
            </div>
            <div style={{ marginTop: 5, fontSize: 10.5 }}>
              {state.state === 'loading' ? '正在加载官方页面…' : '页面视图正在同步位置'}
            </div>
          </div>
        </div>
      ) : (
        <div className="portal-landing">
          <div className="portal-intro">
            <div className="portal-intro-icon">
              <ShieldCheck />
            </div>
            <div>
              <h3>使用你的学习通账号手动登录</h3>
              <p>
                点击任一官方入口后，页面将在独立的持久化会话中打开。账号、密码与 Cookie
                不会写入应用日志， 也不会进入本地 SQLite
                数据库。若页面无法加载，可随时改用系统浏览器。
              </p>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              marginBottom: 10
            }}
          >
            <h3 style={{ margin: 0, fontSize: 13.5 }}>官方入口</h3>
            <span style={{ color: 'var(--text-faint)', fontSize: 10.5 }}>
              仅允许 chaoxing.com 与 xuexitong.com
            </span>
          </div>
          <div className="portal-entry-grid">
            {entries
              .filter((entry) => entry.enabled)
              .map((entry) => (
                <button
                  type="button"
                  className="portal-entry"
                  key={entry.id}
                  onClick={() => void openEntry(entry)}
                  disabled={busy}
                >
                  <span className="portal-entry-icon">
                    <Globe2 />
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span className="portal-entry-name" style={{ display: 'block' }}>
                      {entry.label}
                    </span>
                    <span className="portal-entry-desc" style={{ display: 'block' }}>
                      {entry.description}
                    </span>
                  </span>
                  <ExternalLink
                    size={13}
                    style={{ marginLeft: 'auto', color: 'var(--text-faint)' }}
                  />
                </button>
              ))}
          </div>

          <div className="security-card">
            <div className="security-title">
              <ShieldCheck /> 网页隔离安全状态
            </div>
            <div className="security-grid">
              <div className="security-item">
                <strong>sandbox</strong>
                {security ? String(security.sandbox) : '检查中'}
              </div>
              <div className="security-item">
                <strong>contextIsolation</strong>
                {security ? String(security.contextIsolation) : '检查中'}
              </div>
              <div className="security-item">
                <strong>nodeIntegration</strong>
                {security ? String(security.nodeIntegration) : '检查中'}
              </div>
              <div className="security-item">
                <strong>preload</strong>
                {security ? (security.hasPreload ? '存在（需复核）' : '未注入') : '检查中'}
              </div>
            </div>
            <p
              style={{
                margin: '9px 0 0',
                color: 'var(--text-faint)',
                fontSize: 9.5,
                lineHeight: 1.6
              }}
            >
              会话分区：{security?.partition ?? 'persist:studynext-portal'}
              。登录由官方页面处理，本应用只展示页面本身； 不读取账号密码，不调用学习通私有接口。
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
