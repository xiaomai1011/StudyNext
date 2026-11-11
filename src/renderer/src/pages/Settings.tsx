import { useEffect, useRef, useState } from 'react'
import {
  BellRing,
  BrainCircuit,
  Database,
  Download,
  FolderOpen,
  Globe2,
  Import,
  KeyRound,
  Laptop,
  LockKeyhole,
  Moon,
  Plus,
  RefreshCw,
  Save,
  Sun,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import type {
  AiConfig,
  AppInfo,
  AppSettings,
  BootstrapData,
  ImportResult,
  OfficialEntry,
  OfficialEntryInput,
  PortalSecurityState,
  SnapshotImportResult,
  SyncStatus,
  ThemeMode
} from '@shared/types'
import { REMINDER_MAX_MINUTES, REMINDER_MIN_MINUTES, REMINDER_PRESETS } from '@shared/constants'
import { normalizeReminderOffsets } from '@shared/domain'
import type { ToastKind } from '../components/ToastStack'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { errorMessage, reminderOffsetLabel } from '../lib/format'

interface SettingsProps {
  settings: AppSettings
  syncStatus: SyncStatus
  entries: OfficialEntry[]
  appInfo: AppInfo
  reminderRuntime: BootstrapData['reminderRuntime']
  onUpdateSettings: (patch: Partial<AppSettings>) => Promise<void>
  onResetDemo: () => Promise<void>
  onCreateEntry: (input: OfficialEntryInput) => Promise<void>
  onToggleEntry: (entry: OfficialEntry, enabled: boolean) => Promise<void>
  onRemoveEntry: (entry: OfficialEntry) => Promise<void>
  onSyncRun: () => Promise<SyncStatus>
  onImported: () => Promise<void>
  notify: (kind: ToastKind, message: string) => void
}

const ENTRY_KIND_LABEL: Record<OfficialEntry['kind'], string> = {
  home: '首页',
  course: '课程',
  task: '作业',
  exam: '考试',
  notice: '通知',
  calendar: '课表',
  custom: '自定义'
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

function snapshotSyncStateLabel(state: SyncStatus['state']): string {
  return SNAPSHOT_SYNC_STATE_LABEL[state]
}

export function Settings({
  settings,
  syncStatus,
  entries,
  appInfo,
  reminderRuntime,
  onUpdateSettings,
  onResetDemo,
  onCreateEntry,
  onToggleEntry,
  onRemoveEntry,
  onSyncRun,
  onImported,
  notify
}: SettingsProps) {
  const [security, setSecurity] = useState<PortalSecurityState | null>(null)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [snapshotImporting, setSnapshotImporting] = useState(false)
  const [snapshotResult, setSnapshotResult] = useState<SnapshotImportResult | null>(null)
  const [aiConfig, setAiConfig] = useState<AiConfig | null>(null)
  const [aiEnabled, setAiEnabled] = useState(false)
  const [aiBaseUrl, setAiBaseUrl] = useState('https://api.openai.com/v1')
  const [aiModel, setAiModel] = useState('gpt-4o-mini')
  const [aiKey, setAiKey] = useState('')
  const [clearAiKey, setClearAiKey] = useState(false)
  const [aiSaving, setAiSaving] = useState(false)
  const [confirm, setConfirm] = useState<'reset' | 'clear' | null>(null)
  const [busy, setBusy] = useState(false)
  const [entryLabel, setEntryLabel] = useState('')
  const [entryUrl, setEntryUrl] = useState('')
  const [entryKind, setEntryKind] = useState<OfficialEntry['kind']>('custom')
  const fileInput = useRef<HTMLInputElement | null>(null)
  const snapshotInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    let alive = true
    void window.studynext.portal
      .securityState()
      .then((next) => {
        if (alive) setSecurity(next)
      })
      .catch(() => undefined)
    void window.studynext.ai
      .getConfig()
      .then((config) => {
        if (!alive) return
        setAiConfig(config)
        setAiEnabled(config.enabled)
        setAiBaseUrl(config.baseUrl)
        setAiModel(config.model)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const update = async (patch: Partial<AppSettings>, message?: string): Promise<void> => {
    try {
      await onUpdateSettings(patch)
      if (message) notify('success', message)
    } catch (error) {
      notify('error', errorMessage(error))
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

  const saveAiConfig = async (): Promise<void> => {
    setAiSaving(true)
    try {
      const config = await window.studynext.ai.updateConfig({
        enabled: aiEnabled,
        baseUrl: aiBaseUrl,
        model: aiModel,
        ...(aiKey.trim() ? { apiKey: aiKey.trim() } : {}),
        ...(aiKey.trim() ? {} : { clearApiKey: clearAiKey })
      })
      setAiConfig(config)
      setAiKey('')
      setClearAiKey(false)
      notify('success', 'AI 助手配置已保存')
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setAiSaving(false)
    }
  }

  const addEntry = async (): Promise<void> => {
    if (!entryLabel.trim() || !entryUrl.trim()) {
      notify('error', '请填写入口名称和官方 URL')
      return
    }
    try {
      await onCreateEntry({
        label: entryLabel.trim(),
        description: '用户添加的官方入口',
        url: entryUrl.trim(),
        kind: entryKind
      })
      setEntryLabel('')
      setEntryUrl('')
      setEntryKind('custom')
      notify('success', '官方入口已添加')
    } catch (error) {
      notify('error', errorMessage(error))
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
    try {
      const status = await onSyncRun()
      if (status.state === 'not_configured') {
        notify('info', '学习通授权数据源尚未配置，未执行同步。')
      } else if (status.state === 'failure') {
        notify('error', status.message)
      } else if (status.state === 'partial') {
        notify('info', status.message)
      } else {
        notify('success', status.message)
      }
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page settings-page">
      <header className="page-header">
        <div className="page-header-copy">
          <div className="eyebrow">
            <Laptop size={12} /> 设置
          </div>
          <h1 className="page-title">偏好与数据</h1>
          <p className="page-subtitle">
            控制外观、通知、提醒规则和学习通兼容层。所有设置保存在本机。
          </p>
        </div>
      </header>

      <div className="settings-layout">
        <nav className="card settings-nav">
          <button
            type="button"
            onClick={() =>
              document.getElementById('settings-appearance')?.scrollIntoView({ behavior: 'smooth' })
            }
          >
            外观
          </button>
          <button
            type="button"
            onClick={() =>
              document.getElementById('settings-behavior')?.scrollIntoView({ behavior: 'smooth' })
            }
          >
            行为
          </button>
          <button
            type="button"
            onClick={() =>
              document.getElementById('settings-reminders')?.scrollIntoView({ behavior: 'smooth' })
            }
          >
            提醒
          </button>
          <button
            type="button"
            onClick={() =>
              document.getElementById('settings-portal')?.scrollIntoView({ behavior: 'smooth' })
            }
          >
            学习通
          </button>
          <button
            type="button"
            onClick={() =>
              document.getElementById('settings-ai')?.scrollIntoView({ behavior: 'smooth' })
            }
          >
            AI 助手
          </button>
          <button
            type="button"
            onClick={() =>
              document.getElementById('settings-import')?.scrollIntoView({ behavior: 'smooth' })
            }
          >
            导入
          </button>
          <button
            type="button"
            onClick={() =>
              document.getElementById('settings-about')?.scrollIntoView({ behavior: 'smooth' })
            }
          >
            数据
          </button>
        </nav>

        <div>
          <section className="card settings-section" id="settings-appearance">
            <div className="settings-section-head">
              <h3>外观</h3>
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
                      <span
                        className={value === 'system' ? 'theme-swatch' : `theme-swatch ${value}`}
                      />
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <Icon size={11} /> {label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="card settings-section" id="settings-behavior">
            <div className="settings-section-head">
              <h3>应用行为</h3>
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

          <section className="card settings-section" id="settings-reminders">
            <div className="settings-section-head">
              <h3>DDL 提醒</h3>
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
              <div className="setting-row">
                <div className="setting-copy">
                  <div className="setting-label">提醒时间范围</div>
                  <div className="setting-desc">
                    支持提前 {REMINDER_MIN_MINUTES} 分钟至 {Math.round(REMINDER_MAX_MINUTES / 1440)}{' '}
                    天。应用完全退出后不会发送提醒， 重新打开时会补发最近 10 分钟内错过的项目。
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="card settings-section" id="settings-portal">
            <div className="settings-section-head">
              <h3>学习通与同步</h3>
              <p>官方页面在隔离视图中运行；数据同步需要已授权的适配器。</p>
            </div>
            <div className="settings-rows">
              <div
                className="sync-banner"
                style={
                  syncStatus.state === 'failure' ? { background: 'var(--danger-soft)' } : undefined
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
              </div>

              <div style={{ marginTop: 14 }}>
                <div className="setting-label" style={{ marginBottom: 7 }}>
                  官方入口管理
                </div>
                {entries.map((entry) => (
                  <div className="entry-row" key={entry.id}>
                    <span className="portal-entry-icon" style={{ width: 28, height: 28 }}>
                      <Globe2 size={13} />
                    </span>
                    <div className="entry-main">
                      <div className="entry-label">
                        {entry.label}{' '}
                        <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>
                          · {ENTRY_KIND_LABEL[entry.kind]}
                        </span>
                      </div>
                      <div className="entry-url">{entry.url}</div>
                    </div>
                    <button
                      type="button"
                      className={entry.enabled ? 'switch on' : 'switch'}
                      aria-label={entry.enabled ? '禁用入口' : '启用入口'}
                      onClick={() => {
                        void onToggleEntry(entry, !entry.enabled).catch((error: unknown) =>
                          notify('error', errorMessage(error))
                        )
                      }}
                    />
                    {entry.isBuiltin ? (
                      <span style={{ width: 27, color: 'var(--text-faint)', fontSize: 9 }}>
                        内置
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="task-row-action danger"
                        aria-label="删除入口"
                        onClick={() => {
                          void onRemoveEntry(entry)
                            .then(() => notify('success', '入口已删除'))
                            .catch((error: unknown) => notify('error', errorMessage(error)))
                        }}
                      >
                        <Trash2 />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div
                className="import-zone"
                style={{ marginTop: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}
              >
                <Globe2 />
                <div className="import-copy">
                  <div className="import-title">添加官方入口</div>
                  <div className="import-desc">
                    仅接受 https 且属于 chaoxing.com / xuexitong.com 的地址。
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', width: '100%' }}>
                  <input
                    className="input"
                    style={{ flex: '0 1 160px' }}
                    placeholder="入口名称"
                    value={entryLabel}
                    onChange={(event) => setEntryLabel(event.target.value)}
                  />
                  <input
                    className="input"
                    style={{ flex: '1 1 240px' }}
                    placeholder="https://…"
                    value={entryUrl}
                    onChange={(event) => setEntryUrl(event.target.value)}
                  />
                  <select
                    className="select"
                    value={entryKind}
                    onChange={(event) => setEntryKind(event.target.value as OfficialEntry['kind'])}
                  >
                    {(
                      Object.entries(ENTRY_KIND_LABEL) as Array<[OfficialEntry['kind'], string]>
                    ).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="btn small" onClick={() => void addEntry()}>
                    <Plus size={13} /> 添加
                  </button>
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
                  <button type="button" className="btn small" onClick={() => setConfirm('clear')}>
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

          <section className="card settings-section" id="settings-ai">
            <div className="settings-section-head">
              <h3>AI 解题助手</h3>
              <p>
                可选功能，使用你自己的 OpenAI 兼容接口。API Key 通过系统安全存储加密，不写入日志。
              </p>
            </div>
            <div className="settings-rows">
              <div className="setting-row">
                <div className="setting-copy">
                  <div className="setting-label">启用 AI 助手</div>
                  <div className="setting-desc">
                    关闭时题目助手仍可手动整理题目，只有生成答案需要调用外部服务。
                  </div>
                </div>
                <button
                  type="button"
                  className={aiEnabled ? 'switch on' : 'switch'}
                  aria-label="切换 AI 助手"
                  aria-pressed={aiEnabled}
                  onClick={() => setAiEnabled((value) => !value)}
                />
              </div>
              <div className="settings-form">
                <label className="field">
                  <span className="label">API 地址</span>
                  <input
                    className="input"
                    value={aiBaseUrl}
                    onChange={(event) => setAiBaseUrl(event.target.value)}
                    placeholder="https://api.openai.com/v1"
                    spellCheck={false}
                  />
                  <span className="hint">必须使用 HTTPS；本机 localhost 调试可使用 HTTP。</span>
                </label>
                <label className="field">
                  <span className="label">模型</span>
                  <input
                    className="input"
                    value={aiModel}
                    onChange={(event) => setAiModel(event.target.value)}
                    placeholder="gpt-4o-mini"
                    spellCheck={false}
                  />
                </label>
                <label className="field full">
                  <span className="label">
                    <KeyRound size={13} /> API Key
                  </span>
                  <input
                    className="input"
                    type="password"
                    value={aiKey}
                    onChange={(event) => {
                      setAiKey(event.target.value)
                      if (event.target.value.trim()) setClearAiKey(false)
                    }}
                    placeholder={
                      aiConfig?.hasApiKey ? '已保存，留空表示不修改' : '粘贴你的 API Key'
                    }
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span className="hint">
                    {aiConfig?.keyStorageAvailable
                      ? 'Key 使用 Electron safeStorage 加密后保存于本地数据库。'
                      : '当前系统安全存储不可用，无法保存 API Key。'}
                  </span>
                </label>
              </div>
              <div className="settings-actions">
                {aiConfig?.hasApiKey ? (
                  <label className="checkbox-line">
                    <input
                      type="checkbox"
                      checked={clearAiKey}
                      onChange={(event) => setClearAiKey(event.target.checked)}
                    />
                    删除已保存的 Key
                  </label>
                ) : (
                  <span className="setting-desc">尚未保存 API Key</span>
                )}
                <button
                  type="button"
                  className="btn primary small"
                  onClick={() => void saveAiConfig()}
                  disabled={aiSaving}
                >
                  <Save size={14} /> {aiSaving ? '保存中…' : '保存 AI 配置'}
                </button>
              </div>
              <div className="info-box">
                <span>隐私</span>
                <strong>
                  只有你主动点击“生成思路”时，题目才会发送到你配置的 API
                  地址；本地题目卡不会自动上传。
                </strong>
              </div>
            </div>
          </section>

          <section className="card settings-section" id="settings-import">
            <div className="settings-section-head">
              <h3>手动导入</h3>
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
                    学习点 {snapshotResult.importedPoints} · 任务 {snapshotResult.importedTasks}
                  </div>
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

          <section className="card settings-section" id="settings-about">
            <div className="settings-section-head">
              <h3>数据与关于</h3>
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
                  <span>数据目录</span>
                  <strong>{appInfo.dataPath}</strong>
                </div>
              </div>
              <div className="setting-row" style={{ marginTop: 5 }}>
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
                    当前未配置授权适配器。应用不会使用私有接口或绕过登录限制，同步按钮会如实返回“未配置”。
                  </div>
                </div>
                <span className="portal-status">未配置</span>
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
