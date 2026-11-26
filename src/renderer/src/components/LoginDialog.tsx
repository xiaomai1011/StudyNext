import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ExternalLink, LogIn, ShieldCheck, X } from 'lucide-react'
import type { OfficialEntry, PortalState } from '@shared/types'
import type { ToastKind } from './ToastStack'
import { errorMessage } from '../lib/format'

interface LoginDialogProps {
  entries: OfficialEntry[]
  onClose: () => void
  onAuthenticated: () => void
  notify: (kind: ToastKind, message: string) => void
  autoAccountId?: string | null
  autoAccountLabel?: string | null
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

export function LoginDialog({
  entries,
  onClose,
  onAuthenticated,
  notify,
  autoAccountId = null,
  autoAccountLabel = null
}: LoginDialogProps) {
  const api = window.studynext
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<PortalState>(EMPTY_STATE)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'auto' | 'manual'>(autoAccountId ? 'auto' : 'manual')
  const [autoError, setAutoError] = useState<string | null>(null)
  const finishedRef = useRef(false)

  useLayoutEffect(() => {
    const node = stageRef.current
    if (!node) {
      return () => {
        void api.portal.hide()
      }
    }
    const syncBounds = (): void => {
      const rect = node.getBoundingClientRect()
      if (rect.width < 8 || rect.height < 8) return
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
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncBounds)
      void api.portal.hide()
    }
  }, [api.portal, mode])

  useEffect(() => {
    let alive = true
    const unsubscribe = api.portal.onState((next) => {
      if (!alive) return
      setState(next)
      if (next.loginState === 'logged_in' && !finishedRef.current) {
        finishedRef.current = true
        notify('success', '学习通登录成功，正在刷新账号状态…')
        onAuthenticated()
      }
    })
    void api.portal
      .state()
      .then((next) => {
        if (alive) setState(next)
      })
      .catch(() => undefined)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [api.portal, notify, onAuthenticated])

  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      const home = entries.find((entry) => entry.id === 'entry-home') ?? entries[0]
      if (!home) throw new Error('缺少学习通登录入口')
      await api.portal.open(home.id)
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!autoAccountId) {
      void start()
      return
    }
    let alive = true
    setBusy(true)
    void api.chaoxing
      .autoLogin(autoAccountId)
      .then((result) => {
        if (!alive) return
        if (result.ok) {
          finishedRef.current = true
          notify('success', '学习通登录成功，正在刷新账号状态…')
          onAuthenticated()
          return
        }
        setAutoError(result.message)
        setMode('manual')
        notify('info', `自动登录未完成：${result.message} 已切换到官方登录页。`)
        void start()
      })
      .catch((error: unknown) => {
        if (!alive) return
        const message = errorMessage(error)
        setAutoError(message)
        setMode('manual')
        notify('error', message)
        void start()
      })
      .finally(() => {
        if (alive) setBusy(false)
      })
    return () => {
      alive = false
    }
    // start and notify are stable enough for this one-shot flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="login-dialog-backdrop" role="dialog" aria-modal="true" aria-label="登录学习通">
      <div className="login-dialog">
        <header className="login-dialog-head">
          <div>
            <div className="eyebrow">
              <ShieldCheck size={12} /> 隔离会话 · 官方登录页
            </div>
            <h2>
              {mode === 'auto' ? `正在登录 ${autoAccountLabel ?? '学习通账号'}` : '登录学习通'}
            </h2>
            <p>
              {mode === 'auto'
                ? '正在使用本机加密保存的账号自动登录；如需验证码，会立即切换到官方登录页。'
                : '账号密码和扫码都在学习通官方页面完成，StudyNext 不接收你的登录密码。'}
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭登录窗口">
            <X size={16} />
          </button>
        </header>
        <div className="login-dialog-status">
          <span
            className={`status-dot ${state.state === 'ready' ? 'ready' : state.state === 'error' ? 'error' : ''}`}
          />
          <span>
            {mode === 'auto'
              ? (autoError ?? '正在自动登录学习通…')
              : state.state === 'ready'
                ? state.displayUrl || '学习通登录页'
                : '正在打开学习通登录页…'}
          </span>
        </div>
        {mode === 'auto' ? (
          <div className="login-dialog-auto">
            <LogIn size={22} />
            <strong>{autoAccountLabel ?? '学习通账号'}</strong>
            <span>正在本机完成登录，不会打开外部浏览器</span>
          </div>
        ) : (
          <div className="login-dialog-stage" ref={stageRef}>
            {state.state === 'idle' && !busy ? (
              <div className="login-dialog-placeholder">
                <LogIn size={20} />
                <span>登录页准备中</span>
              </div>
            ) : null}
          </div>
        )}
        <footer className="login-dialog-foot">
          <span>
            {mode === 'auto'
              ? '自动登录不会提交验证码；需要验证时会显示学习通官方页面。'
              : '登录成功后会回到当前页面并自动刷新账号信息。'}
          </span>
          <button
            type="button"
            className="btn small"
            onClick={() => {
              void window.studynext.app.openExternal('https://i.chaoxing.com/base')
            }}
          >
            <ExternalLink size={12} /> 在浏览器打开
          </button>
          <button type="button" className="btn small" onClick={onClose}>
            取消
          </button>
        </footer>
      </div>
    </div>
  )
}
