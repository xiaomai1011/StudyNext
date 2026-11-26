import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  BellRing,
  BookOpen,
  CalendarClock,
  ChevronRight,
  Download,
  FileText,
  FolderOpen,
  LayoutDashboard,
  ListChecks,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Sun,
  Terminal,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import type {
  AppNotice,
  Chapter,
  Course,
  Exam,
  Material,
  NavigateTarget,
  Task
} from '@shared/types'
import {
  PALETTE_SCOPES,
  searchCommandPalette,
  splitHighlightSegments,
  type PaletteActionId,
  type PaletteResultItem,
  type PaletteScope
} from '@shared/command-search'
import { hasOpenModal } from './modal-focus'

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  courses: Course[]
  tasks: Task[]
  exams?: Exam[]
  materials: Material[]
  notices: AppNotice[]
  chapters: Chapter[]
  onNavigate: (target: NavigateTarget) => void
  onOpenTask: (task: Task) => void
  onOpenCourse: (course: Course) => void
  onOpenChapter: (courseId: string, chapterId: string) => void
  onOpenMaterial: (material: Material) => void
  onOpenNotice: (notice: AppNotice) => void
  onOpenExam?: (exam: Exam) => void
  onCreateTask: () => void
  onOpenDownloads: () => void
  onRefresh: () => void
  onToggleTheme: () => void
  onZoomIn?: () => void
  onZoomOut?: () => void
  onZoomReset?: () => void
}

function getItemIcon(item: PaletteResultItem): typeof Search {
  switch (item.target.kind) {
    case 'page':
      switch (item.target.target) {
        case 'dashboard':
          return LayoutDashboard
        case 'courses':
          return BookOpen
        case 'tasks':
          return ListChecks
        case 'exams':
          return CalendarClock
        case 'notices':
          return BellRing
        case 'settings':
          return SettingsIcon
        default:
          return LayoutDashboard
      }
    case 'action':
      switch (item.target.actionId) {
        case 'create-task':
          return Plus
        case 'refresh':
          return RefreshCw
        case 'downloads':
          return Download
        case 'toggle-theme':
          return Moon
        case 'zoom-in':
          return ZoomIn
        case 'zoom-out':
          return ZoomOut
        case 'zoom-reset':
          return Sun
      }
      break
    case 'course':
      return BookOpen
    case 'task':
      return ListChecks
    case 'chapter':
      return BookOpen
    case 'material':
      return item.target.material.kind === 'folder' ? FolderOpen : FileText
    case 'exam':
      return CalendarClock
    case 'notice':
      return BellRing
    case 'expand_scope':
    case 'load_more':
      return ChevronRight
  }
  return Search
}

function HighlightText({ text, tokens }: { text: string; tokens: readonly string[] }) {
  const segments = splitHighlightSegments(text, tokens)
  if (segments.length === 1 && !segments[0]?.matched) {
    return <>{text}</>
  }
  return (
    <>
      {segments.map((segment, index) =>
        segment.matched ? (
          <mark key={index} className="command-match">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </>
  )
}

export function CommandPalette({
  open,
  onClose,
  courses,
  tasks,
  exams = [],
  materials,
  notices,
  chapters,
  onNavigate,
  onOpenTask,
  onOpenCourse,
  onOpenChapter,
  onOpenMaterial,
  onOpenNotice,
  onOpenExam,
  onCreateTask,
  onOpenDownloads,
  onRefresh,
  onToggleTheme,
  onZoomIn,
  onZoomOut,
  onZoomReset
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<PaletteScope>('all')
  const [scopeLimit, setScopeLimit] = useState(60)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const emptyActionsRef = useRef<HTMLDivElement | null>(null)
  const pointerLockRef = useRef(false)

  useEffect(() => {
    if (!open) {
      setQuery('')
      setScope('all')
      setScopeLimit(60)
      setActiveIndex(0)
      return
    }
    inputRef.current?.focus()
    const timer = window.setTimeout(() => inputRef.current?.focus(), 24)
    return () => window.clearTimeout(timer)
  }, [open])

  const availableActions = useMemo<Partial<Record<PaletteActionId, boolean>>>(
    () => ({
      'zoom-in': Boolean(onZoomIn),
      'zoom-out': Boolean(onZoomOut),
      'zoom-reset': Boolean(onZoomReset)
    }),
    [onZoomIn, onZoomOut, onZoomReset]
  )

  const searchResult = useMemo(
    () =>
      searchCommandPalette({
        query,
        scope,
        courses,
        tasks,
        exams,
        materials,
        notices,
        chapters,
        availableActions,
        scopeLimit
      }),
    [
      query,
      scope,
      courses,
      tasks,
      exams,
      materials,
      notices,
      chapters,
      availableActions,
      scopeLimit
    ]
  )

  const items = searchResult.items

  useEffect(() => {
    setScopeLimit(60)
    setActiveIndex(0)
  }, [query, scope])

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, items.length - 1)))
  }, [items.length])

  const executeItem = useCallback(
    (item: PaletteResultItem) => {
      const target = item.target
      if (target.kind === 'expand_scope') {
        setScope(target.scope)
        setScopeLimit(60)
        setActiveIndex(0)
        inputRef.current?.focus()
        return
      }
      if (target.kind === 'load_more') {
        setScopeLimit(target.nextLimit)
        inputRef.current?.focus()
        return
      }
      switch (target.kind) {
        case 'page':
          onNavigate(target.target)
          break
        case 'action':
          if (target.actionId === 'create-task') onCreateTask()
          else if (target.actionId === 'refresh') onRefresh()
          else if (target.actionId === 'downloads') onOpenDownloads()
          else if (target.actionId === 'toggle-theme') onToggleTheme()
          else if (target.actionId === 'zoom-in') onZoomIn?.()
          else if (target.actionId === 'zoom-out') onZoomOut?.()
          else if (target.actionId === 'zoom-reset') onZoomReset?.()
          break
        case 'course':
          onOpenCourse(target.course)
          break
        case 'task':
          onOpenTask(target.task)
          break
        case 'chapter':
          onOpenChapter(target.courseId, target.chapterId)
          break
        case 'material':
          onOpenMaterial(target.material)
          break
        case 'exam':
          if (onOpenExam) onOpenExam(target.exam)
          else onNavigate('exams')
          break
        case 'notice':
          onOpenNotice(target.notice)
          break
      }
      onClose()
    },
    [
      onClose,
      onCreateTask,
      onNavigate,
      onOpenChapter,
      onOpenCourse,
      onOpenDownloads,
      onOpenExam,
      onOpenMaterial,
      onOpenNotice,
      onOpenTask,
      onRefresh,
      onToggleTheme,
      onZoomIn,
      onZoomOut,
      onZoomReset
    ]
  )

  const handleSelectScope = useCallback((nextScope: PaletteScope) => {
    setScope(nextScope)
    setScopeLimit(60)
    if (nextScope !== 'command') {
      setQuery((prev) => {
        const trimmed = prev.trimStart()
        if (trimmed.startsWith('>') || trimmed.startsWith('＞')) {
          return trimmed.slice(1).trimStart()
        }
        return prev
      })
    }
    setActiveIndex(0)
    inputRef.current?.focus()
  }, [])

  const cycleCandidates = useMemo(
    () =>
      searchResult.tokens.length > 0
        ? PALETTE_SCOPES.filter(
            (entry) =>
              entry.id === 'all' || entry.id === scope || searchResult.countsByScope[entry.id] > 0
          )
        : PALETTE_SCOPES,
    [scope, searchResult.countsByScope, searchResult.tokens.length]
  )

  const cycleScope = useCallback(
    (direction: 1 | -1): boolean => {
      if (searchResult.commandMode) {
        setQuery((prev) => prev.trimStart().slice(1).trimStart())
        setScope('all')
        setScopeLimit(60)
        setActiveIndex(0)
        return true
      }
      if (cycleCandidates.length <= 1) return false
      const currentIdx = cycleCandidates.findIndex((entry) => entry.id === scope)
      const nextIdx = (currentIdx + direction + cycleCandidates.length) % cycleCandidates.length
      const next = cycleCandidates[nextIdx]
      if (next) {
        setScope(next.id)
        setScopeLimit(60)
        setActiveIndex(0)
        return true
      }
      return false
    },
    [cycleCandidates, scope, searchResult.commandMode]
  )

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (hasOpenModal()) return
      if (event.isComposing || event.keyCode === 229) return

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }

      if (items.length === 0) {
        const emptyButtons = Array.from(
          emptyActionsRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ??
            []
        )
        const activeEmptyIdx = emptyButtons.indexOf(document.activeElement as HTMLButtonElement)

        if (event.key === 'ArrowDown') {
          if (emptyButtons.length === 0) return
          event.preventDefault()
          const nextIdx = activeEmptyIdx === -1 ? 0 : (activeEmptyIdx + 1) % emptyButtons.length
          emptyButtons[nextIdx]?.focus()
        } else if (event.key === 'ArrowUp') {
          if (emptyButtons.length === 0) return
          event.preventDefault()
          if (activeEmptyIdx <= 0) {
            inputRef.current?.focus()
          } else {
            emptyButtons[activeEmptyIdx - 1]?.focus()
          }
        } else if (event.key === 'ArrowRight' && activeEmptyIdx !== -1 && emptyButtons.length > 1) {
          event.preventDefault()
          emptyButtons[(activeEmptyIdx + 1) % emptyButtons.length]?.focus()
        } else if (event.key === 'ArrowLeft' && activeEmptyIdx !== -1 && emptyButtons.length > 1) {
          event.preventDefault()
          emptyButtons[(activeEmptyIdx - 1 + emptyButtons.length) % emptyButtons.length]?.focus()
        } else if (event.key === 'Tab') {
          if (activeEmptyIdx !== -1) {
            event.preventDefault()
            if (!event.shiftKey && activeEmptyIdx < emptyButtons.length - 1) {
              emptyButtons[activeEmptyIdx + 1]?.focus()
            } else if (event.shiftKey && activeEmptyIdx > 0) {
              emptyButtons[activeEmptyIdx - 1]?.focus()
            } else {
              inputRef.current?.focus()
              if (!event.shiftKey) cycleScope(1)
            }
          } else {
            event.preventDefault()
            const cycled = cycleScope(event.shiftKey ? -1 : 1)
            if (!cycled && emptyButtons.length > 0) {
              const targetIdx = event.shiftKey ? emptyButtons.length - 1 : 0
              emptyButtons[targetIdx]?.focus()
            }
          }
        } else if (
          event.key === 'Backspace' &&
          document.activeElement === inputRef.current &&
          query === '' &&
          scope !== 'all'
        ) {
          event.preventDefault()
          setScope('all')
        }
        return
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        pointerLockRef.current = true
        setActiveIndex((index) => (index + 1) % items.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        pointerLockRef.current = true
        setActiveIndex((index) => (index - 1 + items.length) % items.length)
      } else if (event.key === 'Home') {
        event.preventDefault()
        pointerLockRef.current = true
        setActiveIndex(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        pointerLockRef.current = true
        setActiveIndex(items.length - 1)
      } else if (event.key === 'PageDown') {
        event.preventDefault()
        pointerLockRef.current = true
        setActiveIndex((index) => Math.min(items.length - 1, index + 6))
      } else if (event.key === 'PageUp') {
        event.preventDefault()
        pointerLockRef.current = true
        setActiveIndex((index) => Math.max(0, index - 6))
      } else if (event.key === 'Tab') {
        event.preventDefault()
        cycleScope(event.shiftKey ? -1 : 1)
      } else if (
        event.key === 'Backspace' &&
        document.activeElement === inputRef.current &&
        query === '' &&
        scope !== 'all'
      ) {
        event.preventDefault()
        setScope('all')
      } else if (event.key === 'Enter' && items[activeIndex]) {
        event.preventDefault()
        executeItem(items[activeIndex])
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [activeIndex, cycleScope, executeItem, items, onClose, open, query, scope])

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (!open) return null

  const activeScopeLabel =
    PALETTE_SCOPES.find((entry) => entry.id === searchResult.effectiveScope)?.label ?? '全部'
  const hasQuery = searchResult.tokens.length > 0
  const activeItem = items[activeIndex]

  return (
    <div className="command-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索与命令"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-input-row">
          {searchResult.commandMode ? (
            <Terminal
              size={16}
              className="command-input-icon command-mode-icon"
              aria-hidden="true"
            />
          ) : (
            <Search size={16} className="command-input-icon" aria-hidden="true" />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              searchResult.commandMode
                ? '输入命令或页面名称（如：同步、缩放、设置）…'
                : '搜索课程、作业、章节、资料、考试或通知；输入 > 运行命令…'
            }
            aria-label="搜索或输入命令"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-listbox"
            aria-activedescendant={activeItem ? `command-option-${activeItem.id}` : undefined}
          />
          {searchResult.commandMode ? <span className="command-mode-pill">命令模式</span> : null}
          {query ? (
            <button
              type="button"
              className="command-clear-btn"
              aria-label="清空搜索"
              onClick={() => {
                setQuery('')
                inputRef.current?.focus()
              }}
            >
              <X size={13} />
            </button>
          ) : null}
          <kbd>Esc</kbd>
        </div>

        <div className="command-scope-bar" role="tablist" aria-label="搜索分类">
          {PALETTE_SCOPES.map((entry) => {
            const active = searchResult.effectiveScope === entry.id
            const count = searchResult.countsByScope[entry.id]
            const dimmed = hasQuery && entry.id !== 'all' && !active && count === 0
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={
                  active
                    ? 'command-scope-pill active'
                    : dimmed
                      ? 'command-scope-pill muted'
                      : 'command-scope-pill'
                }
                onClick={() => handleSelectScope(entry.id)}
              >
                <span>{entry.label}</span>
                {hasQuery && entry.id !== 'all' && count > 0 ? (
                  <span className="command-scope-count">{count}</span>
                ) : null}
              </button>
            )
          })}
        </div>

        <div
          id="command-palette-listbox"
          className="command-results"
          role="listbox"
          aria-label="搜索结果"
          ref={listRef}
          onMouseMove={() => {
            pointerLockRef.current = false
          }}
        >
          {items.length === 0 ? (
            <div className="command-empty">
              {hasQuery ? (
                <>
                  <p className="command-empty-title">
                    {searchResult.effectiveScope === 'all'
                      ? `没有找到与“${searchResult.cleanQuery}”匹配的内容或命令`
                      : `「${activeScopeLabel}」下没有匹配“${searchResult.cleanQuery}”的结果`}
                  </p>
                  <p className="command-empty-hint">
                    支持空格组合关键词（如“课程名 作业”或“教学班 资料”），或输入 &gt; 切换命令模式。
                  </p>
                  <div className="command-empty-actions" ref={emptyActionsRef}>
                    {searchResult.otherScopeMatchCount > 0 ? (
                      <button
                        type="button"
                        className="command-empty-btn primary"
                        onClick={() => handleSelectScope('all')}
                      >
                        在「全部」中查看（{searchResult.otherScopeMatchCount} 条）
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="command-empty-btn"
                      onClick={() => {
                        setQuery('')
                        setScope('all')
                        inputRef.current?.focus()
                      }}
                    >
                      清空搜索
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="command-empty-title">当前「{activeScopeLabel}」暂无本地记录</p>
                  <p className="command-empty-hint">可先同步学习通数据，或切换至其他分类查看。</p>
                  <div className="command-empty-actions" ref={emptyActionsRef}>
                    <button
                      type="button"
                      className="command-empty-btn primary"
                      onClick={() => {
                        onRefresh()
                        onClose()
                      }}
                    >
                      立即同步学习通
                    </button>
                    <button
                      type="button"
                      className="command-empty-btn"
                      onClick={() => handleSelectScope('all')}
                    >
                      返回全部
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            items.map((entry, index) => {
              const Icon = getItemIcon(entry)
              const showGroup = index === 0 || items[index - 1]?.group !== entry.group
              const isExpandRow =
                entry.target.kind === 'expand_scope' || entry.target.kind === 'load_more'
              const isActive = index === activeIndex
              const groupTotal =
                hasQuery &&
                entry.group !== 'urgent' &&
                entry.group !== 'page' &&
                entry.group !== 'action'
                  ? searchResult.countsByScope[entry.scope]
                  : null

              return (
                <div key={entry.id}>
                  {showGroup ? (
                    <div className="command-group">
                      <span>{entry.groupLabel}</span>
                      {groupTotal !== null && groupTotal > 0 ? (
                        <span className="command-group-count">{groupTotal}</span>
                      ) : null}
                    </div>
                  ) : null}
                  <button
                    id={`command-option-${entry.id}`}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    data-index={index}
                    data-kind={entry.target.kind}
                    className={[
                      'command-item',
                      isActive ? 'active' : '',
                      isExpandRow ? 'is-expand' : ''
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onMouseMove={() => {
                      if (!pointerLockRef.current && activeIndex !== index) {
                        setActiveIndex(index)
                      }
                    }}
                    onClick={() => executeItem(entry)}
                  >
                    <span className="command-icon">
                      {entry.accentColor ? (
                        <span
                          className="command-color-dot"
                          style={{ backgroundColor: entry.accentColor }}
                          aria-hidden="true"
                        />
                      ) : null}
                      <Icon size={14} aria-hidden="true" />
                    </span>
                    <span className="command-copy">
                      <span className="command-title-line">
                        <strong>
                          <HighlightText text={entry.title} tokens={searchResult.tokens} />
                        </strong>
                        {entry.badge ? (
                          <span className={`command-badge tone-${entry.badge.tone}`}>
                            {entry.badge.text}
                          </span>
                        ) : null}
                        {entry.secondaryBadge ? (
                          <span className={`command-badge tone-${entry.secondaryBadge.tone}`}>
                            {entry.secondaryBadge.text}
                          </span>
                        ) : null}
                      </span>
                      {entry.subtitle ? <small>{entry.subtitle}</small> : null}
                    </span>
                    <span className="command-meta-right">
                      {entry.shortcut && !isActive ? (
                        <kbd className="command-shortcut">{entry.shortcut}</kbd>
                      ) : null}
                      <span className="command-hint">{entry.actionHint}</span>
                      <ArrowRight size={13} className="command-arrow" aria-hidden="true" />
                    </span>
                  </button>
                </div>
              )
            })
          )}
        </div>

        <footer className="command-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 选择
          </span>
          <span>
            <kbd>Enter</kbd> 打开
          </span>
          <span>
            <kbd>Tab</kbd> 切分类
          </span>
          <span>
            <kbd>&gt;</kbd> 命令模式
          </span>
          {hasQuery ? (
            <span className="command-footer-count">共 {searchResult.totalMatches} 条匹配</span>
          ) : null}
        </footer>
      </section>
    </div>
  )
}
