import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  BellRing,
  Database,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  Import,
  KeyRound,
  Laptop,
  LockKeyhole,
  Minus,
  Moon,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Sun,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import type {
  AppInfo,
  AppSettings,
  BootstrapData,
  ChaoxingCredentialStatus,
  ChaoxingSessionStatus,
  ImportResult,
  PortalSecurityState,
  SnapshotImportResult,
  SyncProgressEvent,
  SyncStatus,
  ThemeMode
} from '@shared/types'
import {
  REMINDER_MAX_MINUTES,
  REMINDER_MIN_MINUTES,
  REMINDER_PRESETS,
  UI_ZOOM_MAX,
  UI_ZOOM_MIN,
  UI_ZOOM_PRESETS,
  UI_ZOOM_STEP
} from '@shared/constants'
import { isSyncStale, normalizeReminderOffsets } from '@shared/domain'
import type { ToastKind } from '../components/ToastStack'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { errorMessage, formatOptionalDateTime, reminderOffsetLabel } from '../lib/format'
import { PageHeader } from '../ui/primitives'
import { SETTINGS_SECTION_IDS, type SettingsSectionId } from '@shared/settings-scroll-spy'
import type { ManualSyncResult, SyncRunResult } from '@shared/sync-controller'
import { ensureActiveNavVisible } from './settings/active-nav-visibility'
import { useSettingsScrollSpy } from './settings/use-settings-scroll-spy'

interface SettingsProps {
  settings: AppSettings
  syncStatus: SyncStatus
  chaoxing: ChaoxingSessionStatus
  appInfo: AppInfo
  reminderRuntime: BootstrapData['reminderRuntime']
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<void>
  onResetDemo: () => Promise<void>
  onSyncRun: () => Promise<SyncRunResult>
  onChaoxingCheck: () => Promise<ChaoxingSessionStatus>
  onChaoxingSync: (force?: boolean) => Promise<ManualSyncResult>
  onCancelSync?: () => Promise<boolean>
  onSessionCleared?: () => Promise<void> | void
  onImported: () => Promise<void>
  notify: (kind: ToastKind, message: string) => void
}

const SYNC_STATE_LABEL: Record<SyncStatus['state'], string> = {
  not_configured: '未配置',
  syncing: '同步中',
  success: '成功',
  partial: '部分成功',
  failure: '失败'
}

const SNAPSHOT_SYNC_STATE_LABEL: Record<SyncStatus['state'], string> = {
  not_configured: '本地快照',
  syncing: '导入中',
  success: '快照已导入',
  partial: '快照部分导入',
  failure: '快照导入失败'
}

const AUTH_STATE_LABEL: Record<ChaoxingSessionStatus['authState'], string> = {
  unknown: '未检查',
  logged_out: '未登录',
  authenticated: '已登录',
  expired: '登录已过期'
}

function authStateColor(state: ChaoxingSessionStatus['authState']): string {
  if (state === 'authenticated') return 'var(--success)'
  if (state === 'expired' || state === 'logged_out') return 'var(--warning)'
  return 'var(--text-faint)'
}

const SETTINGS_NAV_GROUPS: Array<{
  label: string
  items: Array<{ id: SettingsSectionId; label: string; icon: typeof Sun }>
}> = [
  {
    label: '偏好',
    items: [
      { id: 'settings-appearance', label: '外观', icon: Sun },
      { id: 'settings-behavior', label: '应用行为', icon: Laptop },
      { id: 'settings-reminders', label: 'DDL 提醒', icon: BellRing }
    ]
  },
  {
    label: '连接',
    items: [{ id: 'settings-portal', label: '学习通与同步', icon: RefreshCw }]
  },
  {
    label: '数据',
    items: [
      { id: 'settings-import', label: '手动导入', icon: Import },
      { id: 'settings-about', label: '数据与关于', icon: Database }
    ]
  }
]

function snapshotSyncStateLabel(state: SyncStatus['state']): string {
  return SNAPSHOT_SYNC_STATE_LABEL[state]
}

export function Settings({
  settings,
  syncStatus,
  chaoxing,
  appInfo,
  reminderRuntime,
  onUpdateSettings,
  onResetDemo,
  onSyncRun,
  onChaoxingCheck,
  onChaoxingSync,
  onCancelSync,
  onSessionCleared,
  onImported,
  notify
}: SettingsProps) {
  const [security, setSecurity] = useState<PortalSecurityState | null>(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [snapshotImporting, setSnapshotImporting] = useState(false)
  const [snapshotResult, setSnapshotResult] = useState<SnapshotImportResult | null>(null)
  const [confirm, setConfirm] = useState<'reset' | 'clear' | null>(null)
  const [busy, setBusy] = useState(false)
  const [syncingChaoxing, setSyncingChaoxing] = useState(false)
  const [syncProgress, setSyncProgress] = useState<SyncProgressEvent | null>(null)
  const [systemReminderStatus, setSystemReminderStatus] = useState(reminderRuntime.system)
  const [systemReminderBusy, setSystemReminderBusy] = useState(false)
  const [ssoDomainsText, setSsoDomainsText] = useState(settings.trustedSsoDomains.join('\n'))
  const [ssoSaving, setSsoSaving] = useState(false)
  const [credential, setCredential] = useState<ChaoxingCredentialStatus | null>(null)
  const [credentialUser, setCredentialUser] = useState('')
  const [credentialPassword, setCredentialPassword] = useState('')
  const [credentialBusy, setCredentialBusy] = useState(false)
  const [showCredentialPassword, setShowCredentialPassword] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const snapshotInput = useRef<HTMLInputElement | null>(null)
  const navRef = useRef<HTMLElement | null>(null)
  const { activeId, scrollToSection } = useSettingsScrollSpy({
    sectionIds: SETTINGS_SECTION_IDS,
    navRef
  })

  useEffect(() => {
    const nav = navRef.current
    if (!nav) return

    ensureActiveNavVisible(nav, activeId)
    // A width change can switch the rail between vertical and horizontal
    // layouts without changing activeId, so watch the nav itself as well.
    const observer = new ResizeObserver(() => {
      ensureActiveNavVisible(nav, activeId)
    })
    observer.observe(nav)
    return () => observer.disconnect()
  }, [activeId])

  useEffect(() => {
    let alive = true
    void window.studynext.portal
      .securityState()
      .then((next) => {
        if (alive) setSecurity(next)
      })
      .catch(() => undefined)
    void window.studynext.chaoxing
      .credentialsStatus()
      .then((status) => {
        if (alive) setCredential(status)
      })
      .catch(() => undefined)
    if (chaoxing.authState === 'unknown') {
      // Opening Settings after a fresh login should not require an extra click.
      void onChaoxingCheck()
    }
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.studynext.chaoxing.onSyncProgress((event) => {
      setSyncProgress(event)
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    setSsoDomainsText(settings.trustedSsoDomains.join('\n'))
  }, [settings.trustedSsoDomains])

  useEffect(() => {
    setSystemReminderStatus(reminderRuntime.system)
  }, [reminderRuntime.system])

  const update = async (patch: Partial<AppSettings>, message?: string): Promise<void> => {
    try {
      await onUpdateSettings(patch)
      if (message) notify('success', message)
    } catch (error) {
      notify('error', errorMessage(error))
    }
  }

  const repairSystemReminder = async (): Promise<void> => {
    setSystemReminderBusy(true)
    try {
      const status = await window.studynext.notifications.repairSystemTask()
      setSystemReminderStatus(status)
      notify(
        'success',
        status.registered ? 'Windows 系统级提醒任务已重新注册' : '系统级提醒任务已更新'
      )
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setSystemReminderBusy(false)
    }
  }

  const toggleDefaultReminder = (minutes: number): void => {
    const next = settings.defaultReminderOffsets.includes(minutes)
      ? settings.defaultReminderOffsets.filter((value) => value !== minutes)
      : normalizeReminderOffsets([...settings.defaultReminderOffsets, minutes])
    void update({ defaultReminderOffsets: next })
  }

  const handleImport = async (file: File): Promise<void> => {
    setImporting(true)
    setImportResult(null)
    try {
      const content = await file.text()
      const result = await window.studynext.imports.csvIcs({ fileName: file.name, content })
      setImportResult(result)
      await onImported()
      notify(
        result.state === 'failure' ? 'error' : result.state === 'partial' ? 'info' : 'success',
        result.message
      )
    } catch (error) {
      const message = errorMessage(error)
      setImportResult({
        state: 'failure',
        importedCourses: 0,
        importedTasks: 0,
        skipped: 0,
        warnings: [],
        message
      })
      notify('error', message)
    } finally {
      setImporting(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const handleSnapshotImport = async (file: File): Promise<void> => {
    setSnapshotImporting(true)
    setSnapshotResult(null)
    try {
      const content = await file.text()
      const result = await window.studynext.imports.snapshot({ fileName: file.name, content })
      setSnapshotResult(result)
      await onImported()
      notify(
        result.state === 'failure' ? 'error' : result.state === 'partial' ? 'info' : 'success',
        result.message
      )
    } catch (error) {
      const message = errorMessage(error)
      notify('error', message)
    } finally {
      setSnapshotImporting(false)
      if (snapshotInput.current) snapshotInput.current.value = ''
    }
  }

  const runReset = async (): Promise<void> => {
    setBusy(true)
    try {
      await onResetDemo()
      notify('success', '演示数据已恢复：5 门课程、15 项任务')
      setConfirm(null)
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const clearSession = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.studynext.portal.clearSession()
      await onSessionCleared?.()
      notify('success', '学习通隔离会话中的 Cookie 与缓存已清除')
      setConfirm(null)
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const runSync = async (): Promise<void> => {
    setBusy(true)
    setSyncingChaoxing(true)
    try {
      const result = await onSyncRun()
      notify(result.toastKind, result.message)
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setBusy(false)
      setSyncingChaoxing(false)
    }
  }

  const checkChaoxing = async (): Promise<void> => {
    setBusy(true)
    try {
      const status = await onChaoxingCheck()
      if (status.authState === 'authenticated') {
        notify(
          'success',
          `已确认学习通登录态${status.displayName ? `：${status.displayName}` : ''}`
        )
      } else if (status.authState === 'expired') {
        notify('info', '学习通登录态已过期，请在 Portal 中重新登录。')
      } else if (status.authState === 'logged_out') {
        notify('info', '尚未在 Portal 登录学习通。')
      } else {
        notify('info', status.message)
      }
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const syncChaoxing = async (): Promise<void> => {
    setBusy(true)
    setSyncingChaoxing(true)
    try {
      const result = await onChaoxingSync(true)
      notify(result.toastKind, result.message)
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setBusy(false)
      setSyncingChaoxing(false)
    }
  }

  const cancelChaoxingSync = async (): Promise<void> => {
    try {
      if (onCancelSync) {
        await onCancelSync()
      } else {
        await window.studynext.chaoxing.cancel()
        notify('info', '正在请求取消当前同步…')
      }
    } catch (error) {
      notify('error', errorMessage(error))
    }
  }

  const chooseDownloadDirectory = async (): Promise<void> => {
    try {
      const directory = await window.studynext.portal.chooseDownloadDirectory()
      if (!directory) return
      await onUpdateSettings({ downloadDirectory: directory })
      notify('success', `资料下载目录已更新：${directory}`)
    } catch (error) {
      notify('error', errorMessage(error))
    }
  }

  const saveCredentials = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!credentialUser.trim() || !credentialPassword) return
    setCredentialBusy(true)
    try {
      const status = await window.studynext.chaoxing.saveCredentials({
        username: credentialUser.trim(),
        password: credentialPassword
      })
      setCredential(status)
      setCredentialPassword('')
      notify('success', '账号已加密保存在本机，仅用于官方登录页自动填充。')
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setCredentialBusy(false)
    }
  }

  const clearCredentials = async (): Promise<void> => {
    setCredentialBusy(true)
    try {
      const status = await window.studynext.chaoxing.clearCredentials()
      setCredential(status)
      setCredentialUser('')
      setCredentialPassword('')
      notify('success', '已清除本机保存的学习通账号。')
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setCredentialBusy(false)
    }
  }

  const fillCredentials = async (): Promise<void> => {
    setCredentialBusy(true)
    try {
      const filled = await window.studynext.chaoxing.fillCredentials()
      if (filled) {
        notify('success', '已填充官方登录页，请核对后手动点击登录。')
      } else {
        notify('info', '当前不在学习通登录页，或本机尚未保存账号。')
      }
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setCredentialBusy(false)
    }
  }

  const activateCredentialAccount = async (id: string): Promise<void> => {
    setCredentialBusy(true)
    try {
      const status = await window.studynext.chaoxing.switchAccount(id)
      setCredential(status)
      const result = await window.studynext.chaoxing.autoLogin()
      if (result.ok) {
        notify('success', '已切换账号并自动登录成功。')
      } else {
        notify('info', `账号已切换，自动登录未完成：${result.message}`)
      }
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setCredentialBusy(false)
    }
  }

  const removeCredentialAccount = async (id: string): Promise<void> => {
    setCredentialBusy(true)
    try {
      const status = await window.studynext.chaoxing.removeAccount(id)
      setCredential(status)
      notify('success', '已从本机删除该学习通账号。')
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setCredentialBusy(false)
    }
  }

  const saveSsoDomains = async (): Promise<void> => {
    const domains = [
      ...new Set(
        ssoDomainsText
          .split(/[\s,;]+/)
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
      )
    ]
    setSsoSaving(true)
    try {
      await onUpdateSettings({ trustedSsoDomains: domains })
      notify('success', domains.length > 0 ? '校园 SSO 域名已保存' : '校园 SSO 域名已清空')
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setSsoSaving(false)
    }
  }

  return (
    <div className="page settings-page ds-settings-page">
      <PageHeader
        title="偏好与数据"
        subtitle="控制外观、通知、提醒规则、学习通账号与本地数据。所有设置保存在本机。"
      />

      <div className="settings-layout">
        <nav ref={navRef} className="settings-nav" aria-label="设置分区">
          {SETTINGS_NAV_GROUPS.map((group) => (
            <div key={group.label} className="settings-nav-group">
              <div className="settings-nav-label">{group.label}</div>
              {group.items.map((item) => {
                const Icon = item.icon
                const active = activeId === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={active ? 'settings-nav-item active' : 'settings-nav-item'}
                    aria-controls={item.id}
                    aria-current={active ? 'location' : undefined}
                    data-settings-nav={item.id}
                    onClick={() => scrollToSection(item.id)}
                  >
                    <Icon size={15} strokeWidth={1.7} aria-hidden="true" />
                    <span>{item.label}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        <div className="settings-content">
          <section
            className="settings-section"
            id="settings-appearance"
            aria-labelledby="settings-appearance-title"
          >
            <div className="settings-section-head">
              <h2 id="settings-appearance-title">外观</h2>
              <p>主题会立即应用；跟随系统会随 Windows 深浅色设置切换。</p>
            </div>
            <div className="settings-rows">
              <div className="setting-row">
                <div className="setting-copy">
                  <div className="setting-label">主题模式</div>
                  <div className="setting-desc">界面配色与原生窗口背景同步更新。</div>
                </div>
                <div className="theme-options">
                  {(
                    [
                      ['system', '跟随系统', Laptop],
                      ['light', '浅色', Sun],
                      ['dark', '深色', Moon]
                    ] as Array<[ThemeMode, string, typeof Sun]>
                  ).map(([value, label, Icon]) => (
                    <button
                      key={value}
                      type="button"
                      className={
                        settings.theme === value
                          ? `theme-option ${value} active`
                          : `theme-option ${value}`
                      }
                      onClick={() => void update({ theme: value })}
                    >
                      <span className="theme-option-label">
                        <Icon size={13} aria-hidden="true" />
                        <span>{label}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="setting-row setting-row-zoom">
                <div className="setting-copy">
                  <div className="setting-label">界面缩放比例</div>
                  <div className="setting-desc">
                    自由调节全局界面大小，高分屏推荐 85%–95%。支持 Ctrl + / Ctrl - / Ctrl 0
                    快捷缩放。
                  </div>
                </div>
                <div className="zoom-setting-controls">
                  <div className="zoom-stepper" role="group" aria-label="微调界面缩放">
                    <button
                      type="button"
                      className="zoom-step-btn"
                      aria-label="缩小界面"
                      disabled={settings.uiZoom <= UI_ZOOM_MIN + 0.001}
                      onClick={() => {
                        const next = Math.max(
                          UI_ZOOM_MIN,
                          Math.round((settings.uiZoom - UI_ZOOM_STEP) * 100) / 100
                        )
                        void update({ uiZoom: next })
                      }}
                    >
                      <Minus size={12} />
                    </button>
                    <span className="zoom-readout">{Math.round(settings.uiZoom * 100)}%</span>
                    <button
                      type="button"
                      className="zoom-step-btn"
                      aria-label="放大界面"
                      disabled={settings.uiZoom >= UI_ZOOM_MAX - 0.001}
                      onClick={() => {
                        const next = Math.min(
                          UI_ZOOM_MAX,
                          Math.round((settings.uiZoom + UI_ZOOM_STEP) * 100) / 100
                        )
                        void update({ uiZoom: next })
                      }}
                    >
                      <Plus size={12} />
                    </button>
                    <button
                      type="button"
                      className="zoom-reset-btn"
                      aria-label="重置缩放为 100%"
                      title="重置为 100%"
                      disabled={Math.abs(settings.uiZoom - 1) < 0.005}
                      onClick={() => void update({ uiZoom: 1 })}
                    >
                      <RotateCcw size={11} />
                      重置
                    </button>
                  </div>
                  <div className="zoom-presets" role="group" aria-label="选择界面缩放预设">
                    {UI_ZOOM_PRESETS.map((preset) => {
                      const active = Math.abs(settings.uiZoom - preset) < 0.005
                      return (
                        <button
                          key={preset}
                          type="button"
                          className={active ? 'zoom-preset-btn active' : 'zoom-preset-btn'}
                          aria-pressed={active}
                          onClick={() => void update({ uiZoom: preset })}
                        >
                          {Math.round(preset * 100)}%
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section
            className="settings-section"
            id="settings-behavior"
            aria-labelledby="settings-behavior-title"
          >
            <div className="settings-section-head">
              <h2 id="settings-behavior-title">应用行为</h2>
              <p>控制关闭窗口、开机启动和提示方式。</p>
            </div>
            <div className="settings-rows">
              <div className="setting-row">
                <div className="setting-copy">
                  <div className="setting-label">关闭窗口时最小化到托盘</div>
                  <div className="setting-desc">
                    关闭后应用仍在运行，DDL 提醒可继续触发；可从托盘菜单彻底退出。
                  </div>
                </div>
                <button
                  type="button"
                  className={settings.closeToTray ? 'switch on' : 'switch'}
                  aria-label="切换关闭到托盘"
                  aria-pressed={settings.closeToTray}
                  onClick={() => void update({ closeToTray: !settings.closeToTray })}
                />
              </div>
              <div className="setting-row">
                <div className="setting-copy">
                  <div className="setting-label">开机时启动</div>
                  <div className="setting-desc">
                    登录 Windows 后自动启动；设置只在打包版本中注册系统登录项。
                  </div>
                </div>
                <button
                  type="button"
                  className={settings.launchAtLogin ? 'switch on' : 'switch'}
                  aria-label="切换开机启动"
                  aria-pressed={settings.launchAtLogin}
                  onClick={() => void update({ launchAtLogin: !settings.launchAtLogin })}
                />
              </div>
              <div className="setting-row">
                <div className="setting-copy">
                  <div className="setting-label">启用系统通知</div>
                  <div className="setting-desc">
                    关闭后不会发送 DDL 提醒；任务仍会保留并显示在仪表盘。
                  </div>
                </div>
                <button
                  type="button"
                  className={settings.notificationsEnabled ? 'switch on' : 'switch'}
                  aria-label="切换系统通知"
                  aria-pressed={settings.notificationsEnabled}
                  onClick={() =>
                    void update({ notificationsEnabled: !settings.notificationsEnabled })
                  }
                />
              </div>
              <div className="setting-row">
                <div className="setting-copy">
                  <div className="setting-label">启动时补发错过的提醒</div>
                  <div className="setting-desc">
                    应用重启时，仅补发最近 10 分钟内本应触发的提醒，避免旧提醒集中弹出。
                  </div>
                </div>
                <button
                  type="button"
                  className={settings.catchUpMissedReminders ? 'switch on' : 'switch'}
                  aria-label="切换启动补发提醒"
                  aria-pressed={settings.catchUpMissedReminders}
                  onClick={() =>
                    void update({ catchUpMissedReminders: !settings.catchUpMissedReminders })
                  }
                />
              </div>
              <div className="setting-row">
                <div className="setting-copy">
                  <div className="setting-label">每周起始日</div>
                  <div className="setting-desc">影响日历月视图与周视图的排列方式。</div>
                </div>
                <select
                  className="select"
                  value={settings.calendarWeekStartsOn}
                  onChange={(event) =>
                    void update({ calendarWeekStartsOn: Number(event.target.value) === 0 ? 0 : 1 })
                  }
                >
                  <option value={1}>周一</option>
                  <option value={0}>周日</option>
                </select>
              </div>
            </div>
          </section>

          <section
            className="settings-section"
            id="settings-reminders"
            aria-labelledby="settings-reminders-title"
          >
            <div className="settings-section-head">
              <h2 id="settings-reminders-title">DDL 提醒</h2>
              <p>新建任务时默认勾选这些提前量；每个任务仍可单独调整。</p>
            </div>
            <div className="settings-rows">
              <div className="setting-row" style={{ alignItems: 'flex-start' }}>
                <div className="setting-copy">
                  <div className="setting-label">默认提醒时间</div>
                  <div className="setting-desc">可多选。自定义提醒在编辑任务时按分钟添加。</div>
                  <div className="reminder-options" style={{ marginTop: 9 }}>
                    {REMINDER_PRESETS.map((preset) => (
                      <button
                        key={preset.minutes}
                        type="button"
                        className={
                          settings.defaultReminderOffsets.includes(preset.minutes)
                            ? 'reminder-option active'
                            : 'reminder-option'
                        }
                        onClick={() => toggleDefaultReminder(preset.minutes)}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="setting-row">
                <div className="setting-copy">
                  <div className="setting-label">提醒运行状态</div>
                  <div className="setting-desc">
                    {reminderRuntime.note}
                    {reminderRuntime.nextReminderAt
                      ? ` 下一条提醒：${new Date(reminderRuntime.nextReminderAt).toLocaleString('zh-CN')}。`
                      : ' 当前没有待触发的提醒。'}
                    {reminderRuntime.startupCatchUpCount > 0
                      ? ` 本次启动已补发 ${reminderRuntime.startupCatchUpCount} 条。`
                      : ''}
                    {reminderRuntime.systemNotificationsSupported
                      ? ''
                      : ' 当前系统不支持桌面通知，提醒仍会在应用内显示。'}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    void window.studynext.settings
                      .testNotification()
                      .then(() => notify('success', '测试通知已发送'))
                      .catch((error: unknown) => notify('error', errorMessage(error)))
                  }}
                >
                  <BellRing size={13} /> 发送测试通知
                </button>
              </div>
              <div className="setting-row setting-row-stack">
                <div className="setting-copy">
                  <div className="setting-label">Windows 系统级提醒</div>
                  <div className="setting-desc">
                    {!settings.notificationsEnabled
                      ? '系统通知已关闭，不会注册 Windows 检查任务。'
                      : !systemReminderStatus.supported
                        ? '当前运行环境不支持系统级任务；打包后的 Windows 版本会启用。'
                        : systemReminderStatus.registered
                          ? `已注册计划任务：${systemReminderStatus.taskName ?? 'Windows 任务'}。`
                          : '计划任务尚未注册，应用完全退出后可能无法提醒。'}
                    {systemReminderStatus.nextRunAt
                      ? ` 下一次 Windows 检查：${formatOptionalDateTime(systemReminderStatus.nextRunAt)}。`
                      : ''}
                    {systemReminderStatus.lastCheckAt
                      ? ` 最近检查：${formatOptionalDateTime(systemReminderStatus.lastCheckAt)}。`
                      : ''}
                    {systemReminderStatus.lastDeliveryError
                      ? ` 通知发送失败：${systemReminderStatus.lastDeliveryError}`
                      : ''}
                    {systemReminderStatus.lastScheduleError
                      ? ` 计划任务错误：${systemReminderStatus.lastScheduleError}`
                      : ''}
                    {!systemReminderStatus.lastDeliveryError &&
                    !systemReminderStatus.lastScheduleError &&
                    systemReminderStatus.lastError
                      ? ` 最近错误：${systemReminderStatus.lastError}`
                      : ''}
                  </div>
                  <div className="settings-inline-note">
                    计划任务注册成功只代表 Windows 已接受任务，不代表通知已经实际送达。
                  </div>
                </div>
                <button
                  type="button"
                  className="btn small"
                  disabled={systemReminderBusy || !systemReminderStatus.supported}
                  onClick={() => void repairSystemReminder()}
                >
                  <RefreshCw size={13} /> {systemReminderBusy ? '正在注册…' : '重新注册'}
                </button>
              </div>
              <div className="setting-row">
                <div className="setting-copy">
                  <div className="setting-label">提醒时间范围</div>
                  <div className="setting-desc">
                    支持提前 {REMINDER_MIN_MINUTES} 分钟至 {Math.round(REMINDER_MAX_MINUTES / 1440)}{' '}
                    天。启用系统级提醒后，完全退出应用仍可由 Windows
                    任务计划程序检查；应用重启时会补发最近 10 分钟内错过的项目。
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section
            className="settings-section"
            id="settings-portal"
            aria-labelledby="settings-portal-title"
          >
            <div className="settings-section-head">
              <h2 id="settings-portal-title">学习通与同步</h2>
              <p>官方页面在隔离视图中运行；登录后可在本页检查状态并手动同步课程与作业。</p>
            </div>
            <div className="settings-rows">
              <div className="chaoxing-card">
                <div className="chaoxing-card-head">
                  <div>
                    <div className="setting-label">学习通连接</div>
                    <div className="setting-desc">
                      连接方式：Web Session（用户本人在 Portal 登录，应用只读同步） · 传输：
                      {chaoxing.transport === 'none'
                        ? '未建立'
                        : chaoxing.transport === 'session_fetch'
                          ? 'session.fetch'
                          : 'net.request'}
                    </div>
                  </div>
                  <span className="chaoxing-badge">
                    <span
                      className="dot"
                      style={{ background: authStateColor(chaoxing.authState) }}
                    />
                    {AUTH_STATE_LABEL[chaoxing.authState]}
                  </span>
                </div>
                <div className="chaoxing-grid">
                  <div>
                    <span>账号</span>
                    <strong>{chaoxing.displayName ?? '—'}</strong>
                  </div>
                  <div>
                    <span>学校</span>
                    <strong>{chaoxing.school ?? '—'}</strong>
                  </div>
                  <div>
                    <span>最近检查</span>
                    <strong>{formatOptionalDateTime(chaoxing.checkedAt)}</strong>
                  </div>
                  <div>
                    <span>最近同步</span>
                    <strong>{formatOptionalDateTime(chaoxing.lastSyncAt)}</strong>
                  </div>
                  <div>
                    <span>已同步课程</span>
                    <strong>{chaoxing.syncedCourses}</strong>
                  </div>
                  <div>
                    <span>已同步作业</span>
                    <strong>{chaoxing.syncedTasks}</strong>
                  </div>
                  <div>
                    <span>数据新鲜度</span>
                    <strong>
                      {!chaoxing.lastSyncAt
                        ? '尚未同步'
                        : settings.autoRefreshMinutes === 0
                          ? '自动刷新已关闭'
                          : isSyncStale(chaoxing.lastSyncAt, settings.autoRefreshMinutes)
                            ? '数据已过期'
                            : '数据新鲜'}
                    </strong>
                  </div>
                </div>
                {chaoxing.lastSyncAt ? (
                  <div className="setting-desc" style={{ marginTop: 8 }}>
                    最近一次覆盖：{chaoxing.syncedCourses} 门课程 · {chaoxing.syncedTasks} 项作业 ·{' '}
                    {chaoxing.syncedChapters} 个章节 · {chaoxing.syncedExams} 场考试 ·{' '}
                    {chaoxing.syncedNotices} 条通知 · {chaoxing.syncedMaterials} 个资料
                  </div>
                ) : null}
                <div className="setting-desc" style={{ marginTop: 8 }}>
                  {chaoxing.message}
                  {chaoxing.detail ? ` ${chaoxing.detail}` : ''}
                </div>
                <div className="chaoxing-actions">
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => void checkChaoxing()}
                    disabled={busy}
                  >
                    <ShieldCheck size={13} /> 检查登录状态
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => void syncChaoxing()}
                    disabled={busy || chaoxing.authState !== 'authenticated'}
                  >
                    <RefreshCw size={13} /> 仅同步学习通
                  </button>
                  {syncingChaoxing ? (
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => void cancelChaoxingSync()}
                    >
                      取消同步
                    </button>
                  ) : null}
                </div>
                <div className="setting-desc" style={{ marginTop: 8 }}>
                  同步会短暂切换官方页面读取数据；结束后会尝试恢复同步前的页面。如果同步期间你主动操作了页面，应用不会覆盖你的操作。
                </div>
                {syncProgress ? (
                  <div className="chaoxing-progress">
                    <span>{syncProgress.message}</span>
                    <span>
                      {syncProgress.total > 0
                        ? `${syncProgress.current}/${syncProgress.total}`
                        : ''}
                    </span>
                  </div>
                ) : null}
                <div className="setting-row">
                  <div className="setting-copy">
                    <div className="setting-label">自动刷新</div>
                    <div className="setting-desc">
                      前台运行时按间隔检查学习通数据；从后台恢复或启动时也会检查一次。设为关闭后仍可手动同步。
                    </div>
                  </div>
                  <select
                    className="select"
                    value={settings.autoRefreshMinutes}
                    onChange={(event) =>
                      void onUpdateSettings({ autoRefreshMinutes: Number(event.target.value) })
                    }
                    aria-label="自动刷新间隔"
                  >
                    <option value={0}>关闭</option>
                    <option value={3}>每 3 分钟</option>
                    <option value={5}>每 5 分钟</option>
                    <option value={10}>每 10 分钟</option>
                    <option value={15}>每 15 分钟</option>
                  </select>
                </div>
                <div className="setting-row">
                  <div className="setting-copy">
                    <div className="setting-label">资料下载目录</div>
                    <div className="setting-desc">
                      {settings.downloadDirectory || '默认保存在系统下载目录下的 StudyNext 文件夹'}
                    </div>
                  </div>
                  <div className="chaoxing-actions">
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => void chooseDownloadDirectory()}
                    >
                      <FolderOpen size={13} /> 选择目录
                    </button>
                    {settings.downloadDirectory ? (
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => void onUpdateSettings({ downloadDirectory: '' })}
                      >
                        恢复默认
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="chaoxing-credentials">
                  <div className="chaoxing-credentials-head">
                    <div>
                      <div className="setting-label">记住账号密码</div>
                      <div className="setting-desc">
                        使用 Windows DPAPI
                        加密保存在本机，仅用于官方登录页自动填充；不会上传，也不会写入日志或导出文件。可保存多个账号。
                      </div>
                    </div>
                    {credential && credential.accounts.length > 0 ? (
                      <span className="chaoxing-badge">{credential.accounts.length} 个账号</span>
                    ) : null}
                  </div>
                  {credential && credential.accounts.length > 0 ? (
                    <div className="chaoxing-account-list">
                      {credential.accounts.map((account) => (
                        <div
                          className={
                            account.id === credential.activeAccountId
                              ? 'chaoxing-account-row active'
                              : 'chaoxing-account-row'
                          }
                          key={account.id}
                        >
                          <div className="chaoxing-account-info">
                            <strong>{account.displayName || account.username}</strong>
                            <span>{account.username}</span>
                            {account.school ? <small>{account.school}</small> : null}
                          </div>
                          <div className="chaoxing-account-actions">
                            {account.id === credential.activeAccountId ? (
                              <span className="chaoxing-badge">当前</span>
                            ) : (
                              <button
                                type="button"
                                className="btn small"
                                onClick={() => void activateCredentialAccount(account.id)}
                                disabled={credentialBusy}
                              >
                                使用
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn small danger-link"
                              onClick={() => void removeCredentialAccount(account.id)}
                              disabled={credentialBusy}
                            >
                              删除
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <form
                    className="chaoxing-credential-form"
                    onSubmit={(event) => void saveCredentials(event)}
                  >
                    <input
                      type="text"
                      value={credentialUser}
                      onChange={(event) => setCredentialUser(event.target.value)}
                      placeholder="学习通账号（手机号或邮箱）"
                      autoComplete="username"
                      disabled={credentialBusy}
                    />
                    <div className="password-field">
                      <input
                        type={showCredentialPassword ? 'text' : 'password'}
                        value={credentialPassword}
                        onChange={(event) => setCredentialPassword(event.target.value)}
                        placeholder="密码"
                        autoComplete="current-password"
                        disabled={credentialBusy}
                      />
                      <button
                        type="button"
                        className="password-toggle"
                        onClick={() => setShowCredentialPassword((visible) => !visible)}
                        aria-label={showCredentialPassword ? '隐藏密码' : '显示密码'}
                        title={showCredentialPassword ? '隐藏密码' : '显示密码'}
                        disabled={credentialBusy}
                      >
                        {showCredentialPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                    <button
                      type="submit"
                      className="btn small"
                      disabled={credentialBusy || !credentialUser.trim() || !credentialPassword}
                    >
                      <Save size={13} /> {credential?.accounts.length ? '添加账号' : '保存'}
                    </button>
                  </form>
                  {credential && credential.accounts.length > 0 ? (
                    <div className="chaoxing-actions">
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => void fillCredentials()}
                        disabled={credentialBusy}
                      >
                        <KeyRound size={13} /> 填充当前登录页
                      </button>
                      <button
                        type="button"
                        className="btn small danger-link"
                        onClick={() => void clearCredentials()}
                        disabled={credentialBusy}
                      >
                        <Trash2 size={13} /> 清除全部账号
                      </button>
                    </div>
                  ) : null}
                  {credential && !credential.encryptionAvailable ? (
                    <div className="setting-desc">当前系统未提供 DPAPI 加密，账号不会被保存。</div>
                  ) : null}
                </div>
              </div>

              {!(
                chaoxing.authState === 'authenticated' && syncStatus.state === 'not_configured'
              ) ? (
                <div
                  className="sync-banner"
                  style={
                    syncStatus.state === 'failure'
                      ? { background: 'var(--danger-soft)' }
                      : undefined
                  }
                >
                  <TriangleAlert />
                  <span>
                    <strong>
                      {syncStatus.source === 'import'
                        ? snapshotSyncStateLabel(syncStatus.state)
                        : SYNC_STATE_LABEL[syncStatus.state]}
                      ：
                    </strong>{' '}
                    {syncStatus.message}{' '}
                    {syncStatus.lastSuccessAt
                      ? `${syncStatus.source === 'import' ? '上次导入' : '上次成功'}：${new Date(syncStatus.lastSuccessAt).toLocaleString('zh-CN')}。`
                      : ''}
                  </span>
                  <button
                    type="button"
                    className="btn small"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => void runSync()}
                    disabled={busy}
                  >
                    <RefreshCw size={13} /> 检查同步
                  </button>
                  {syncingChaoxing ? (
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => void cancelChaoxingSync()}
                    >
                      取消同步
                    </button>
                  ) : null}
                </div>
              ) : null}

              <div className="settings-form" style={{ marginTop: 14 }}>
                <div className="field full">
                  <label className="label" htmlFor="sso-domains">
                    校园 SSO 域名（可选）
                  </label>
                  <textarea
                    id="sso-domains"
                    className="textarea"
                    rows={4}
                    value={ssoDomainsText}
                    onChange={(event) => setSsoDomainsText(event.target.value)}
                    placeholder={'例如：sso.example.edu.cn\n多个域名可换行或逗号分隔'}
                  />
                  <div className="hint">
                    仅用于允许官方登录页跳转到你所在学校的 HTTPS 统一认证域名；支持子域，不支持
                    http、通配符或任意第三方站点。登录仍由你在官方页面手动完成。
                  </div>
                </div>
                <div className="settings-actions">
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => void saveSsoDomains()}
                    disabled={ssoSaving}
                  >
                    <Save size={13} /> {ssoSaving ? '保存中…' : '保存 SSO 域名'}
                  </button>
                  <span className="hint">留空表示只允许学习通官方域名。</span>
                </div>
              </div>

              <div className="security-card">
                <div className="security-title">
                  <LockKeyhole /> 兼容层安全基线
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
                    <strong>会话分区</strong>
                    {security?.partition ?? 'persist:studynext-portal'}
                  </div>
                </div>
                <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className="btn small danger-link"
                    onClick={() => setConfirm('clear')}
                  >
                    <Trash2 size={13} /> 清除登录会话
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      void window.studynext.app
                        .openDataDirectory()
                        .catch((error: unknown) => notify('error', errorMessage(error)))
                    }}
                  >
                    <FolderOpen size={13} /> 打开数据目录
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section
            className="settings-section"
            id="settings-import"
            aria-labelledby="settings-import-title"
          >
            <div className="settings-section-head">
              <h2 id="settings-import-title">手动导入</h2>
              <p>
                不依赖学习通账号的稳定数据入口，支持 CSV、ICS 日历文件，以及从其他工具导出的 JSON
                学习快照。
              </p>
            </div>
            <div className="settings-rows">
              <div className="import-zone">
                <Import />
                <div className="import-copy">
                  <div className="import-title">导入任务文件</div>
                  <div className="import-desc">
                    CSV 字段：标题、截止时间、课程、备注、优先级、类型、提醒。ICS 会读取 VEVENT
                    的截止时间与描述。 文件只在本机解析，不会上传。
                  </div>
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".csv,.ics,text/csv,text/calendar"
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void handleImport(file)
                  }}
                />
                <button
                  type="button"
                  className="btn small primary"
                  onClick={() => fileInput.current?.click()}
                  disabled={importing}
                >
                  <Download size={13} /> {importing ? '导入中…' : '选择文件'}
                </button>
              </div>
              {importResult ? (
                <div
                  className={`import-result ${importResult.state === 'failure' ? 'failure' : importResult.state === 'partial' ? '' : 'success'}`}
                >
                  <div>{importResult.message}</div>
                  <div style={{ marginTop: 4 }}>
                    新增课程 {importResult.importedCourses} · 新增任务 {importResult.importedTasks}{' '}
                    · 跳过 {importResult.skipped}
                  </div>
                  {importResult.warnings.length > 0 ? (
                    <div className="import-warning">
                      {importResult.warnings.slice(0, 5).join('；')}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="import-zone">
                <FolderOpen />
                <div className="import-copy">
                  <div className="import-title">导入学习快照（JSON）</div>
                  <div className="import-desc">
                    合并课程、章节、学习点和截止任务；以外部 ID
                    去重。数据只在本机解析，不会访问学习通。
                  </div>
                </div>
                <input
                  ref={snapshotInput}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void handleSnapshotImport(file)
                  }}
                />
                <button
                  type="button"
                  className="btn small ghost"
                  onClick={() => snapshotInput.current?.click()}
                  disabled={snapshotImporting}
                >
                  <Download size={13} /> {snapshotImporting ? '导入中…' : '选择 JSON'}
                </button>
              </div>
              {snapshotResult ? (
                <div
                  className={`import-result ${snapshotResult.state === 'failure' ? 'failure' : snapshotResult.state === 'partial' ? '' : 'success'}`}
                >
                  <div>{snapshotResult.message}</div>
                  <div style={{ marginTop: 4 }}>
                    新增课程 {snapshotResult.importedCourses} · 更新课程{' '}
                    {snapshotResult.updatedCourses} · 章节 {snapshotResult.importedChapters} ·
                    学习点 {snapshotResult.importedPoints} · 新增任务 {snapshotResult.importedTasks}{' '}
                    · 更新任务 {snapshotResult.updatedTasks}
                  </div>
                  {snapshotResult.deadlineChanges > 0 || snapshotResult.conflicts > 0 ? (
                    <div style={{ marginTop: 4 }}>
                      截止时间变化 {snapshotResult.deadlineChanges} · 保留本地修改{' '}
                      {snapshotResult.conflicts}
                    </div>
                  ) : null}
                  {snapshotResult.warnings.length > 0 ? (
                    <div className="import-warning">
                      {snapshotResult.warnings.slice(0, 5).join('；')}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="info-grid" style={{ marginTop: 12 }}>
                <div className="info-box">
                  <span>CSV</span>
                  <strong>UTF-8 编码，首行为字段名；标题和截止时间必填。</strong>
                </div>
                <div className="info-box">
                  <span>ICS</span>
                  <strong>支持本地时间、UTC Z 时间与 TZID；重复事件暂按单次处理。</strong>
                </div>
                <div className="info-box">
                  <span>JSON 快照</span>
                  <strong>需包含 courses，可选 chapters/points/homeworks/exams；最大 2 MB。</strong>
                </div>
              </div>
            </div>
          </section>

          <section
            className="settings-section"
            id="settings-about"
            aria-labelledby="settings-about-title"
          >
            <div className="settings-section-head">
              <h2 id="settings-about-title">数据与关于</h2>
              <p>本地数据位置、演示数据恢复和应用版本信息。</p>
            </div>
            <div className="settings-rows">
              <div className="info-grid">
                <div className="info-box">
                  <span>应用版本</span>
                  <strong>StudyNext {appInfo.version}</strong>
                </div>
                <div className="info-box">
                  <span>运行平台</span>
                  <strong>
                    {appInfo.platform} · {appInfo.isPackaged ? '安装版' : '开发版'}
                  </strong>
                </div>
                <div className="info-box" style={{ gridColumn: '1 / -1' }}>
                  <span>数据工作区</span>
                  <strong>
                    {appInfo.workspace.mode === 'local'
                      ? '本机工作区（未绑定学习通账号）'
                      : appInfo.workspace.mode === 'readonly'
                        ? '历史数据（只读）'
                        : `账号独立数据库 · ${appInfo.workspace.id}`}
                  </strong>
                </div>
                <div className="info-box" style={{ gridColumn: '1 / -1' }}>
                  <span>数据目录</span>
                  <strong>{appInfo.dataPath}</strong>
                </div>
              </div>
              <div className="settings-danger-zone">
                <h3 className="settings-subhead">危险操作</h3>
                <div className="setting-row setting-row-danger">
                  <div className="setting-copy">
                    <div className="setting-label">恢复演示数据</div>
                    <div className="setting-desc">
                      将清空当前课程、任务与提醒，并重建 5 门模拟课程和 15
                      项任务。官方入口设置会保留。
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn small danger"
                    onClick={() => setConfirm('reset')}
                  >
                    <RefreshCw size={13} /> 恢复演示数据
                  </button>
                </div>
              </div>
              <div className="setting-row">
                <div className="setting-copy">
                  <div className="setting-label">打开本地数据目录</div>
                  <div className="setting-desc">
                    SQLite 数据库、窗口状态与会话数据均保存在此目录，不会自动上传。
                  </div>
                </div>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    void window.studynext.app
                      .openDataDirectory()
                      .catch((error: unknown) => notify('error', errorMessage(error)))
                  }}
                >
                  <Database size={13} /> 打开目录
                </button>
              </div>
              <div className="setting-row">
                <div className="setting-copy">
                  <div className="setting-label">学习通数据接入</div>
                  <div className="setting-desc">
                    使用你在 Portal 中本人登录后建立的 Web
                    Session，只读读取课程与作业；应用不保存账号密码，也不会绕过验证码或风控。登录状态以受保护页面的实际请求结果为准。
                  </div>
                </div>
                <span className="portal-status">{AUTH_STATE_LABEL[chaoxing.authState]}</span>
              </div>
            </div>
          </section>
        </div>
      </div>

      {confirm === 'reset' ? (
        <ConfirmDialog
          title="恢复演示数据？"
          message="当前所有课程、任务和提醒规则将被删除，并替换为内置演示数据。该操作无法撤销。"
          warning="App 设置、官方入口与学习通隔离会话不受影响。"
          confirmLabel="恢复演示数据"
          danger
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void runReset()}
        />
      ) : null}
      {confirm === 'clear' ? (
        <ConfirmDialog
          title="清除学习通隔离会话？"
          message="将清除内置浏览器视图中的 Cookie、LocalStorage 与缓存。下次打开官方页面时需要重新登录。"
          warning="本地任务、课程、设置与应用数据库不会被删除。"
          confirmLabel="清除会话"
          danger
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void clearSession()}
        />
      ) : null}
    </div>
  )
}
