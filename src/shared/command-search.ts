import type { AppNotice, Chapter, Course, Exam, Material, NavigateTarget, Task } from './types'
import { getCourseClassLabel, shortStableId } from './course-identity'
import { dueBucket, isDueAtUnknown } from './domain'
import { materialTarget, materialTypeLabel } from './materials'
import { getTaskScoreView, getTaskStatusView, isPlatformTask, isTaskActionable } from './task-state'

export type PaletteScope =
  | 'all'
  | 'course'
  | 'task'
  | 'chapter'
  | 'material'
  | 'exam'
  | 'notice'
  | 'command'

export type PaletteGroupId =
  | 'urgent'
  | 'course'
  | 'task'
  | 'exam'
  | 'chapter'
  | 'material'
  | 'notice'
  | 'page'
  | 'action'

export type PaletteActionId =
  | 'create-task'
  | 'refresh'
  | 'downloads'
  | 'toggle-theme'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'

export type PaletteBadgeTone = 'default' | 'accent' | 'info' | 'success' | 'warning' | 'danger'

export type PaletteTarget =
  | { kind: 'page'; target: NavigateTarget }
  | { kind: 'action'; actionId: PaletteActionId }
  | { kind: 'course'; course: Course }
  | { kind: 'task'; task: Task }
  | { kind: 'chapter'; courseId: string; chapterId: string; chapter: Chapter }
  | { kind: 'material'; material: Material }
  | { kind: 'exam'; exam: Exam }
  | { kind: 'notice'; notice: AppNotice }
  | { kind: 'expand_scope'; scope: Exclude<PaletteScope, 'all'> }
  | { kind: 'load_more'; scope: Exclude<PaletteScope, 'all'>; nextLimit: number }

export type PaletteMatchTier = 0 | 1 | 2 | 3

export interface PaletteResultItem {
  id: string
  group: PaletteGroupId
  groupLabel: string
  scope: Exclude<PaletteScope, 'all'>
  title: string
  subtitle: string
  badge?: { text: string; tone: PaletteBadgeTone } | undefined
  secondaryBadge?: { text: string; tone: PaletteBadgeTone } | undefined
  actionHint: string
  shortcut?: string | undefined
  accentColor?: string | undefined
  target: PaletteTarget
  score: number
  matchTier?: PaletteMatchTier | undefined
}

export interface PaletteSearchInput {
  query: string
  scope: PaletteScope
  courses: readonly Course[]
  tasks: readonly Task[]
  exams: readonly Exam[]
  materials: readonly Material[]
  notices: readonly AppNotice[]
  chapters: readonly Chapter[]
  availableActions?: Partial<Record<PaletteActionId, boolean>>
  now?: Date
  groupPreviewLimit?: number
  scopeLimit?: number
}

export interface PaletteSearchOutput {
  commandMode: boolean
  effectiveScope: PaletteScope
  cleanQuery: string
  tokens: string[]
  items: PaletteResultItem[]
  totalMatches: number
  countsByScope: Record<PaletteScope, number>
  otherScopeMatchCount: number
}

export interface HighlightSegment {
  text: string
  matched: boolean
}

export const PALETTE_SCOPES: ReadonlyArray<{ id: PaletteScope; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'course', label: '课程' },
  { id: 'task', label: '作业' },
  { id: 'chapter', label: '章节' },
  { id: 'material', label: '资料' },
  { id: 'exam', label: '考试' },
  { id: 'notice', label: '通知' },
  { id: 'command', label: '命令' }
]

const GROUP_LABELS: Record<PaletteGroupId, string> = {
  urgent: '近期关注',
  course: '课程',
  task: '作业',
  exam: '考试',
  chapter: '章节',
  material: '资料',
  notice: '通知',
  page: '页面导航',
  action: '快捷命令'
}

const CONTENT_GROUP_ORDER: Record<Exclude<PaletteGroupId, 'urgent'>, number> = {
  course: 0,
  task: 1,
  exam: 2,
  chapter: 3,
  material: 4,
  notice: 5,
  page: 6,
  action: 7
}

const COMMAND_GROUP_ORDER: Partial<Record<PaletteGroupId, number>> = {
  action: 0,
  page: 1
}

interface PageDefinition {
  target: NavigateTarget
  title: string
  subtitle: string
  keywords: string
  shortcut?: string
}

interface ActionDefinition {
  actionId: PaletteActionId
  title: string
  subtitle: string
  keywords: string
  shortcut?: string
  commandOnlyInEmpty?: boolean
}

const PAGE_DEFINITIONS: readonly PageDefinition[] = [
  {
    target: 'dashboard',
    title: '今天与课表',
    subtitle: '今日课表、截止预览与同步概览',
    keywords: '今天 首页 课表 周课表 日历 月视图 时间轴 today dashboard',
    shortcut: 'Ctrl 1'
  },
  {
    target: 'courses',
    title: '课程空间',
    subtitle: '按课程查看章节、作业、课件资料与通知',
    keywords: '课程 空间 章节 课件 资料 courses study materials',
    shortcut: 'Ctrl 2'
  },
  {
    target: 'tasks',
    title: '作业与成绩',
    subtitle: '跨课程作业筛选、成绩与教师批语',
    keywords: '作业 任务 待办 成绩 批语 tasks homework',
    shortcut: 'Ctrl 3'
  },
  {
    target: 'exams',
    title: '考试安排',
    subtitle: '跨课程考试时间、状态与成绩',
    keywords: '考试 考场 安排 测验 成绩 exams'
  },
  {
    target: 'notices',
    title: '通知收件箱',
    subtitle: '全部课程通知与未读消息',
    keywords: '通知 公告 消息 收件箱 notices'
  },
  {
    target: 'settings',
    title: '设置',
    subtitle: '账号连接、同步频率、提醒规则与界面缩放',
    keywords: '设置 偏好 账号 同步 提醒 备份 主题 缩放 settings'
  }
]

const ACTION_DEFINITIONS: readonly ActionDefinition[] = [
  {
    actionId: 'create-task',
    title: '新建本地任务',
    subtitle: '创建自定义作业或提醒事项',
    keywords: '新建 创建 添加 作业 任务 create new task',
    shortcut: 'Ctrl N'
  },
  {
    actionId: 'refresh',
    title: '立即同步学习通',
    subtitle: '手动拉取最新课程、作业、章节与资料',
    keywords: '同步 刷新 更新 拉取 学习通 sync refresh chaoxing'
  },
  {
    actionId: 'downloads',
    title: '打开下载管理器',
    subtitle: '查看课件与附件下载进度和本地文件',
    keywords: '下载 课件 文件 队列 download manager'
  },
  {
    actionId: 'toggle-theme',
    title: '切换主题（浅色 / 深色 / 系统）',
    subtitle: '在浅色、深色与跟随系统外观间循环切换',
    keywords: '主题 浅色 深色 暗黑 夜间 外观 theme dark light system'
  },
  {
    actionId: 'zoom-in',
    title: '放大界面比例',
    subtitle: '调大全局界面缩放比例',
    keywords: '缩放 放大 界面 字体 zoom scale in',
    shortcut: 'Ctrl +',
    commandOnlyInEmpty: true
  },
  {
    actionId: 'zoom-out',
    title: '缩小界面比例',
    subtitle: '调小全局界面缩放比例',
    keywords: '缩放 缩小 界面 字体 zoom scale out',
    shortcut: 'Ctrl -',
    commandOnlyInEmpty: true
  },
  {
    actionId: 'zoom-reset',
    title: '重置界面缩放为 100%',
    subtitle: '恢复默认 100% 界面显示比例',
    keywords: '缩放 重置 默认 100% zoom scale reset',
    shortcut: 'Ctrl 0',
    commandOnlyInEmpty: true
  }
]

export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-CN')
}

export function parsePaletteQuery(
  rawQuery: string,
  selectedScope: PaletteScope
): {
  commandMode: boolean
  effectiveScope: PaletteScope
  cleanQuery: string
  tokens: string[]
} {
  const trimmedStart = rawQuery.trimStart()
  const commandMode = trimmedStart.startsWith('>') || trimmedStart.startsWith('＞')
  const cleanQuery = commandMode ? trimmedStart.slice(1).trim() : trimmedStart.trim()
  const normalized = normalizeSearchText(cleanQuery)
  const tokens = normalized ? normalized.split(/\s+/).filter(Boolean) : []
  return {
    commandMode,
    effectiveScope: commandMode ? 'command' : selectedScope,
    cleanQuery,
    tokens
  }
}

export function splitHighlightSegments(
  text: string,
  tokens: readonly string[]
): HighlightSegment[] {
  if (!text || tokens.length === 0) {
    return [{ text, matched: false }]
  }
  const lower = text.toLocaleLowerCase('zh-CN')
  const normalizedTokens = [
    ...new Set(tokens.map((t) => t.trim().toLocaleLowerCase('zh-CN')).filter(Boolean))
  ]
  if (normalizedTokens.length === 0) {
    return [{ text, matched: false }]
  }

  const ranges: Array<[number, number]> = []
  for (const token of normalizedTokens) {
    let cursor = 0
    while (cursor < lower.length) {
      const idx = lower.indexOf(token, cursor)
      if (idx === -1) break
      ranges.push([idx, idx + token.length])
      cursor = idx + Math.max(1, token.length)
    }
  }

  if (ranges.length === 0) {
    return [{ text, matched: false }]
  }

  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const merged: Array<[number, number]> = []
  for (const [start, end] of ranges) {
    const prev = merged[merged.length - 1]
    if (!prev || start > prev[1]) {
      merged.push([start, end])
    } else if (end > prev[1]) {
      prev[1] = end
    }
  }

  const segments: HighlightSegment[] = []
  let pos = 0
  for (const [start, end] of merged) {
    if (start > pos) {
      segments.push({ text: text.slice(pos, start), matched: false })
    }
    segments.push({ text: text.slice(start, end), matched: true })
    pos = end
  }
  if (pos < text.length) {
    segments.push({ text: text.slice(pos), matched: false })
  }
  return segments
}

function formatCompactDateTime(iso: string | null | undefined, includeTime = true): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  const month = d.getMonth() + 1
  const day = d.getDate()
  if (!includeTime) return `${month}月${day}日`
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return `${month}月${day}日 ${hours}:${minutes}`
}

function getBaseCourseClassTag(course: Course): string {
  const className = course.className?.trim()
  if (className) return `教学班 ${className}`
  const clazzId = course.clazzId?.trim()
  if (clazzId) return `班级 ${clazzId}`
  const code = course.code?.trim()
  if (code) return `课程号 ${code}`
  return `ID ${shortStableId(course.id)}`
}

/**
 * 长教学班名称会在命令面板的徽标里被省略号截断。把短班级 ID 放到徽标
 * 开头，确保消歧标识本身始终可见，长名称只作为补充信息被裁切。
 */
function getVisibleCourseClassTag(course: Course, fullTag: string): string {
  if (fullTag.length <= 18) return fullTag
  const clazzId = course.clazzId?.trim()
  if (clazzId && !fullTag.startsWith(`班级 ${clazzId}`)) {
    return `班级 ${clazzId} · ${fullTag}`
  }
  return fullTag
}

/**
 * Resolve compact distinguishing tags for courses. Normal unique tags stay short;
 * only when courses with the same name produce colliding tags do we progressively
 * append班级 / 课程号 / ID until every colliding course is distinct.
 */
function resolveCourseCompactTags(
  courses: readonly Course[],
  duplicateCourseNames: ReadonlySet<string>
): Map<string, string> {
  const tags = new Map<string, string>()
  const byName = new Map<string, Course[]>()

  for (const course of courses) {
    tags.set(course.id, getBaseCourseClassTag(course))
    const key = normalizeSearchText(course.name)
    if (duplicateCourseNames.has(key)) {
      const list = byName.get(key) ?? []
      list.push(course)
      byName.set(key, list)
    }
  }

  const appendOnCollision = (
    group: Course[],
    nextPart: (course: Course, current: string) => string | null
  ): void => {
    const counts = new Map<string, number>()
    for (const course of group) {
      const tag = tags.get(course.id) ?? ''
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    for (const course of group) {
      const current = tags.get(course.id) ?? ''
      if ((counts.get(current) ?? 0) <= 1) continue
      const part = nextPart(course, current)
      if (part && !current.includes(part)) {
        tags.set(course.id, `${current} · ${part}`)
      }
    }
  }

  for (const group of byName.values()) {
    appendOnCollision(group, (course) => {
      const clazzId = course.clazzId?.trim()
      return clazzId ? `班级 ${clazzId}` : null
    })
    appendOnCollision(group, (course) => {
      const code = course.code?.trim()
      return code ? `课程号 ${code}` : null
    })
    appendOnCollision(group, (course) => {
      const ext = course.externalId?.trim()
      return ext ? `ID ${shortStableId(ext)}` : null
    })
    appendOnCollision(group, (course) => `ID ${shortStableId(course.id)}`)
  }

  return tags
}

function formatCourseContext(
  course: Course | undefined,
  duplicateCourseNames: ReadonlySet<string>,
  courseTags: ReadonlyMap<string, string>,
  fallback: string
): string {
  if (!course) return fallback
  const nameKey = normalizeSearchText(course.name)
  if (duplicateCourseNames.has(nameKey)) {
    const tag = courseTags.get(course.id) ?? getBaseCourseClassTag(course)
    return `${course.name}（${tag}）`
  }
  return course.name
}

function scoreCandidate(
  fullQuery: string,
  tokens: readonly string[],
  title: string,
  primaryContext: string,
  secondaryContext: string
): { score: number; tier: PaletteMatchTier } | null {
  const normTitle = normalizeSearchText(title)
  const normPrimary = normalizeSearchText(primaryContext)
  const normSecondary = normalizeSearchText(secondaryContext)

  let score = 0
  let allTokensInTitle = tokens.length > 0
  for (const token of tokens) {
    const inTitle = normTitle.indexOf(token)
    const inPrimary = normPrimary.indexOf(token)
    const inSecondary = normSecondary.indexOf(token)
    if (inTitle === -1 && inPrimary === -1 && inSecondary === -1) {
      return null
    }
    if (inTitle === -1) {
      allTokensInTitle = false
    }
    if (inTitle === 0) {
      score += 260
    } else if (inTitle > 0) {
      score += Math.max(150, 210 - Math.min(inTitle, 60))
    } else if (inPrimary === 0) {
      score += 120
    } else if (inPrimary > 0) {
      score += 95
    } else {
      score += 45
    }
  }

  let tier: PaletteMatchTier = allTokensInTitle ? 2 : 3
  if (fullQuery) {
    if (normTitle === fullQuery) {
      score += 1000
      tier = 0
    } else if (normTitle.startsWith(fullQuery)) {
      score += 650
      tier = 1
    } else if (normTitle.includes(fullQuery)) {
      score += 420
      tier = 2
    } else if (normPrimary.includes(fullQuery)) {
      score += 180
    }
  }

  return { score, tier }
}

function extractBodySnippet(body: string, tokens: readonly string[]): string | null {
  const collapsed = body.replace(/\s+/g, ' ').trim()
  if (!collapsed) return null
  const lower = normalizeSearchText(collapsed)
  let matchIdx = -1
  for (const token of tokens) {
    const idx = lower.indexOf(token)
    if (idx !== -1 && (matchIdx === -1 || idx < matchIdx)) {
      matchIdx = idx
    }
  }
  if (matchIdx === -1) return null
  const start = Math.max(0, matchIdx - 12)
  const end = Math.min(collapsed.length, matchIdx + 36)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < collapsed.length ? '…' : ''
  return `${prefix}${collapsed.slice(start, end).trim()}${suffix}`
}

function taskUrgencyRank(task: Task, now: Date): number {
  const actionable = isTaskActionable(task)
  if (actionable) {
    const bucket = dueBucket(task, now)
    if (bucket === 'overdue') return 0
    if (bucket === 'today') return 1
    if (bucket === 'soon') return 2
    if (!isDueAtUnknown(task.dueAt)) return 3
    return 4
  }
  if (task.platformStatusKind === 'pending_review') return 5
  if (task.platformStatusKind === 'submitted') return 6
  return 7
}

function taskBadge(task: Task, now: Date): { text: string; tone: PaletteBadgeTone } {
  const statusView = getTaskStatusView(task, now)
  const scoreView = getTaskScoreView(task)
  const actionable = isTaskActionable(task)
  if (actionable && statusView.overdue) {
    return { text: '已逾期', tone: 'danger' }
  }
  if (isPlatformTask(task)) {
    const label = statusView.platformLabel ?? '待确认'
    if (task.platformStatusKind === 'reviewed' || task.platformStatusKind === 'done') {
      return {
        text: scoreView.state === 'graded' ? `${label} · ${scoreView.text}` : label,
        tone: 'success'
      }
    }
    if (task.platformStatusKind === 'pending_review') {
      return { text: label, tone: 'info' }
    }
    if (task.platformStatusKind === 'submitted') {
      return { text: label, tone: 'accent' }
    }
    if (task.platformStatusKind === 'not_submitted') {
      return { text: label, tone: 'warning' }
    }
    return { text: label, tone: 'default' }
  }
  if (task.status === 'done') {
    return { text: '已完成', tone: 'success' }
  }
  if (actionable && statusView.bucket === 'today') {
    return { text: '今日截止', tone: 'warning' }
  }
  return { text: '待办', tone: 'default' }
}

function examUrgencyRank(exam: Exam, nowMs: number): number {
  const status = exam.examStatus.trim()
  if (/进行中|考试中|待考|未开始|未提交/.test(status)) {
    const startMs = exam.startAt ? Date.parse(exam.startAt) : Number.NaN
    if (Number.isFinite(startMs) && startMs >= nowMs) return 0
    return 1
  }
  if (exam.startAt) {
    const startMs = Date.parse(exam.startAt)
    if (Number.isFinite(startMs) && startMs >= nowMs) return 0
  }
  return 2
}

function examBadge(exam: Exam): { text: string; tone: PaletteBadgeTone } | undefined {
  const score = exam.score?.trim()
  if (score) return { text: `成绩 ${score}`, tone: 'success' }
  const status = exam.examStatus.trim()
  if (!status) return undefined
  if (/进行中|考试中/.test(status)) return { text: status, tone: 'warning' }
  if (/待考|未开始|未提交/.test(status)) return { text: status, tone: 'accent' }
  if (/已结束|已完成|已提交|已批阅/.test(status)) return { text: status, tone: 'default' }
  return { text: status, tone: 'info' }
}

function sortCoursesDomain(a: Course, b: Course): number {
  if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
  const sem = (b.semester || '').localeCompare(a.semester || '', 'zh-CN')
  if (sem !== 0) return sem
  const name = a.name.localeCompare(b.name, 'zh-CN')
  if (name !== 0) return name
  return getBaseCourseClassTag(a).localeCompare(getBaseCourseClassTag(b), 'zh-CN')
}

function sortTasksDomain(a: Task, b: Task, now: Date): number {
  const rankDiff = taskUrgencyRank(a, now) - taskUrgencyRank(b, now)
  if (rankDiff !== 0) return rankDiff
  const aUnknown = isDueAtUnknown(a.dueAt)
  const bUnknown = isDueAtUnknown(b.dueAt)
  if (!aUnknown && !bUnknown) {
    const aMs = Date.parse(a.dueAt)
    const bMs = Date.parse(b.dueAt)
    if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) {
      // Upcoming: earliest deadline first; finished/overdue: most recent first
      const actionable = isTaskActionable(a)
      return actionable && dueBucket(a, now) !== 'overdue' ? aMs - bMs : bMs - aMs
    }
  }
  return a.title.localeCompare(b.title, 'zh-CN')
}

function deduplicateMaterials(materials: readonly Material[]): Material[] {
  const seen = new Set<string>()
  const result: Material[] = []
  for (const item of materials) {
    const key = [item.courseId, item.externalId, item.kind, materialTarget(item) ?? ''].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

export function searchCommandPalette(input: PaletteSearchInput): PaletteSearchOutput {
  const now = input.now ?? new Date()
  const nowMs = now.getTime()
  const groupPreviewLimit = input.groupPreviewLimit ?? 5
  const scopeLimit = input.scopeLimit ?? 60
  const parsed = parsePaletteQuery(input.query, input.scope)
  const fullQuery = normalizeSearchText(parsed.cleanQuery)

  const courseById = new Map(input.courses.map((course) => [course.id, course]))

  const courseNameCounts = new Map<string, number>()
  for (const course of input.courses) {
    const key = normalizeSearchText(course.name)
    courseNameCounts.set(key, (courseNameCounts.get(key) ?? 0) + 1)
  }
  const duplicateCourseNames = new Set(
    [...courseNameCounts.entries()].filter(([, count]) => count > 1).map(([name]) => name)
  )
  const courseTags = resolveCourseCompactTags(input.courses, duplicateCourseNames)

  const getTaskDueLabel = (task: Task): string =>
    isDueAtUnknown(task.dueAt) ? '截止待确认' : `${formatCompactDateTime(task.dueAt)} 截止`

  const taskLabelSignatureCounts = new Map<string, number>()
  const taskExtIdSignatureCounts = new Map<string, number>()
  for (const task of input.tasks) {
    const baseSig = `${task.courseId ?? ''}::${normalizeSearchText(task.title)}::${getTaskDueLabel(task)}`
    taskLabelSignatureCounts.set(baseSig, (taskLabelSignatureCounts.get(baseSig) ?? 0) + 1)
    const extShort = shortStableId(task.externalId || task.id)
    const extSig = `${baseSig}::${extShort}`
    taskExtIdSignatureCounts.set(extSig, (taskExtIdSignatureCounts.get(extSig) ?? 0) + 1)
  }

  const dedupedMaterials = deduplicateMaterials(input.materials)
  const materialSameCourseNameCounts = new Map<string, number>()
  const materialDisplaySignatureCounts = new Map<string, number>()
  for (const material of dedupedMaterials) {
    const nameKey = `${material.courseId}::${normalizeSearchText(material.name)}`
    materialSameCourseNameCounts.set(nameKey, (materialSameCourseNameCounts.get(nameKey) ?? 0) + 1)
  }
  for (const material of dedupedMaterials) {
    const nameKey = `${material.courseId}::${normalizeSearchText(material.name)}`
    const dupName = (materialSameCourseNameCounts.get(nameKey) ?? 0) > 1
    const updatedLabel = dupName ? (formatCompactDateTime(material.updatedAt, false) ?? '') : ''
    const dispSig = `${nameKey}::${material.size?.trim() ?? ''}::${updatedLabel}`
    materialDisplaySignatureCounts.set(
      dispSig,
      (materialDisplaySignatureCounts.get(dispSig) ?? 0) + 1
    )
  }

  const isActionAvailable = (id: PaletteActionId): boolean => {
    if (!input.availableActions) return true
    const explicit = input.availableActions[id]
    return explicit !== false
  }

  // Build candidate builders per scope so we can both rank and compute exact countsByScope
  const buildPageItem = (
    def: PageDefinition,
    score: number,
    matchTier?: PaletteMatchTier
  ): PaletteResultItem => ({
    id: `page-${def.target}`,
    group: 'page',
    groupLabel: GROUP_LABELS.page,
    scope: 'command',
    title: def.title,
    subtitle: def.subtitle,
    actionHint: '前往页面',
    shortcut: def.shortcut,
    target: { kind: 'page', target: def.target },
    score,
    matchTier
  })

  const buildActionItem = (
    def: ActionDefinition,
    score: number,
    matchTier?: PaletteMatchTier
  ): PaletteResultItem => ({
    id: `action-${def.actionId}`,
    group: 'action',
    groupLabel: GROUP_LABELS.action,
    scope: 'command',
    title: def.title,
    subtitle: def.subtitle,
    actionHint: '执行命令',
    shortcut: def.shortcut,
    target: { kind: 'action', actionId: def.actionId },
    score,
    matchTier
  })

  const buildCourseItem = (
    course: Course,
    score: number,
    matchTier?: PaletteMatchTier
  ): PaletteResultItem => {
    const isDuplicate = duplicateCourseNames.has(normalizeSearchText(course.name))
    const classTag = courseTags.get(course.id) ?? getBaseCourseClassTag(course)
    const codePart = course.code?.trim() ? `课程号 ${course.code.trim()}` : null
    const clazzPart =
      course.clazzId?.trim() && course.className?.trim() ? `班级 ${course.clazzId.trim()}` : null
    const subtitleParts = [
      course.teacher?.trim(),
      course.semester?.trim(),
      isDuplicate
        ? [
            codePart && !classTag.includes(codePart) ? codePart : null,
            clazzPart && !classTag.includes(clazzPart) ? clazzPart : null
          ]
            .filter(Boolean)
            .join(' · ')
        : course.className?.trim()
          ? `教学班 ${course.className.trim()}`
          : null
    ].filter(Boolean)

    return {
      id: `course-${course.id}`,
      group: 'course',
      groupLabel: GROUP_LABELS.course,
      scope: 'course',
      title: course.name,
      subtitle: subtitleParts.join(' · ') || getCourseClassLabel(course),
      badge: isDuplicate
        ? { text: getVisibleCourseClassTag(course, classTag), tone: 'accent' }
        : course.favorite
          ? { text: '已收藏', tone: 'info' }
          : undefined,
      secondaryBadge: isDuplicate && course.favorite ? { text: '已收藏', tone: 'info' } : undefined,
      actionHint: '进入课程',
      accentColor: course.color,
      target: { kind: 'course', course },
      score,
      matchTier
    }
  }

  const buildTaskItem = (
    task: Task,
    score: number,
    groupOverride?: 'urgent',
    matchTier?: PaletteMatchTier
  ): PaletteResultItem => {
    const course = task.courseId ? courseById.get(task.courseId) : undefined
    const courseContext = formatCourseContext(
      course,
      duplicateCourseNames,
      courseTags,
      task.source === 'manual' ? '本地任务' : '未关联课程'
    )
    const dueLabel = getTaskDueLabel(task)
    const baseSig = `${task.courseId ?? ''}::${normalizeSearchText(task.title)}::${dueLabel}`
    const collides = (taskLabelSignatureCounts.get(baseSig) ?? 0) > 1
    let extraId: string | null = null
    if (collides) {
      const extShort = shortStableId(task.externalId || task.id)
      const extSig = `${baseSig}::${extShort}`
      const extUnique = (taskExtIdSignatureCounts.get(extSig) ?? 0) === 1
      extraId = `ID ${extUnique ? extShort : shortStableId(task.id)}`
    }

    const group: PaletteGroupId = groupOverride ?? 'task'
    return {
      id: groupOverride ? `urgent-task-${task.id}` : `task-${task.id}`,
      group,
      groupLabel: GROUP_LABELS[group],
      scope: 'task',
      title: task.title,
      subtitle: [courseContext, dueLabel, extraId].filter(Boolean).join(' · '),
      badge: taskBadge(task, now),
      actionHint: '查看详情',
      accentColor: course?.color,
      target: { kind: 'task', task },
      score,
      matchTier
    }
  }

  const buildChapterItem = (
    chapter: Chapter,
    score: number,
    matchedSectionLabel: string | null,
    matchTier?: PaletteMatchTier
  ): PaletteResultItem => {
    const course = courseById.get(chapter.courseId)
    const isDuplicate = course ? duplicateCourseNames.has(normalizeSearchText(course.name)) : false
    const courseContext = formatCourseContext(
      course,
      duplicateCourseNames,
      courseTags,
      '未关联课程'
    )
    const progressText =
      chapter.progress >= 100
        ? '已完成'
        : chapter.progress > 0
          ? `进度 ${Math.round(chapter.progress)}%`
          : null

    return {
      id: `chapter-${chapter.id}`,
      group: 'chapter',
      groupLabel: GROUP_LABELS.chapter,
      scope: 'chapter',
      title: chapter.title,
      subtitle: [
        courseContext,
        `第 ${chapter.sortOrder + 1} 章`,
        progressText,
        matchedSectionLabel ? `匹配小节：${matchedSectionLabel}` : null
      ]
        .filter(Boolean)
        .join(' · '),
      badge:
        isDuplicate && course
          ? {
              text: getVisibleCourseClassTag(
                course,
                courseTags.get(course.id) ?? getBaseCourseClassTag(course)
              ),
              tone: 'accent'
            }
          : undefined,
      actionHint: '定位章节',
      accentColor: course?.color,
      target: { kind: 'chapter', courseId: chapter.courseId, chapterId: chapter.id, chapter },
      score,
      matchTier
    }
  }

  const buildMaterialItem = (
    material: Material,
    score: number,
    matchTier?: PaletteMatchTier
  ): PaletteResultItem => {
    const course = courseById.get(material.courseId)
    const courseContext = formatCourseContext(
      course,
      duplicateCourseNames,
      courseTags,
      '未关联课程'
    )
    const typeLabel = materialTypeLabel(material)
    const sameCourseKey = `${material.courseId}::${normalizeSearchText(material.name)}`
    const duplicateInSameCourse = (materialSameCourseNameCounts.get(sameCourseKey) ?? 0) > 1
    const updatedLabel = duplicateInSameCourse
      ? formatCompactDateTime(material.updatedAt, false)
      : null
    const dispSig = `${sameCourseKey}::${material.size?.trim() ?? ''}::${updatedLabel ?? ''}`
    const extraId =
      (materialDisplaySignatureCounts.get(dispSig) ?? 0) > 1
        ? `ID ${shortStableId(material.externalId || material.id)}`
        : null

    return {
      id: `material-${material.id}`,
      group: 'material',
      groupLabel: GROUP_LABELS.material,
      scope: 'material',
      title: material.name,
      subtitle: [courseContext, material.size?.trim(), updatedLabel, extraId]
        .filter(Boolean)
        .join(' · '),
      badge: { text: typeLabel, tone: material.kind === 'folder' ? 'info' : 'default' },
      actionHint: '前往课程资料',
      accentColor: course?.color,
      target: { kind: 'material', material },
      score,
      matchTier
    }
  }

  const buildExamItem = (
    exam: Exam,
    score: number,
    matchTier?: PaletteMatchTier
  ): PaletteResultItem => {
    const rawCourseName = exam.courseName?.trim() || ''
    const isAmbiguousCourse =
      rawCourseName.length > 0 && duplicateCourseNames.has(normalizeSearchText(rawCourseName))
    const courseContext = rawCourseName
      ? isAmbiguousCourse
        ? `${rawCourseName}（同名多班）`
        : rawCourseName
      : '课程未标注'
    const startLabel = formatCompactDateTime(exam.startAt)
    const subtitleParts = [
      courseContext,
      startLabel ? `${startLabel} 开考` : null,
      exam.mode?.trim(),
      exam.answerStatus?.trim() && exam.answerStatus.trim() !== exam.examStatus.trim()
        ? exam.answerStatus.trim()
        : null
    ].filter(Boolean)

    return {
      id: `exam-${exam.id}`,
      group: 'exam',
      groupLabel: GROUP_LABELS.exam,
      scope: 'exam',
      title: exam.title,
      subtitle: subtitleParts.join(' · '),
      badge: examBadge(exam),
      actionHint: '查看考试',
      target: { kind: 'exam', exam },
      score,
      matchTier
    }
  }

  const buildNoticeItem = (
    notice: AppNotice,
    score: number,
    snippet: string | null,
    matchTier?: PaletteMatchTier
  ): PaletteResultItem => {
    const rawCourseName = notice.courseName?.trim() || ''
    const courseContext = rawCourseName
      ? duplicateCourseNames.has(normalizeSearchText(rawCourseName))
        ? `${rawCourseName}（同名多班）`
        : rawCourseName
      : null
    const dateLabel = formatCompactDateTime(notice.publishedAt, false)

    return {
      id: `notice-${notice.id}`,
      group: 'notice',
      groupLabel: GROUP_LABELS.notice,
      scope: 'notice',
      title: notice.title,
      subtitle: [courseContext, notice.sender?.trim(), dateLabel, snippet]
        .filter(Boolean)
        .join(' · '),
      badge: notice.read === false ? { text: '未读', tone: 'info' } : undefined,
      actionHint: notice.url ? '打开原链接' : '查看通知',
      target: { kind: 'notice', notice },
      score,
      matchTier
    }
  }

  const PAGE_STEP = 60
  const buildLoadMoreItem = (
    group: Exclude<PaletteGroupId, 'urgent'>,
    targetScope: Exclude<PaletteScope, 'all'>,
    shownCount: number,
    totalCount: number
  ): PaletteResultItem => {
    const remaining = totalCount - shownCount
    const nextBatch = Math.min(PAGE_STEP, remaining)
    const nextLimit = shownCount + nextBatch
    return {
      id: `load-more-${group}`,
      group,
      groupLabel: GROUP_LABELS[group],
      scope: targetScope,
      title: `加载更多${GROUP_LABELS[group]}（已显示 ${shownCount} / ${totalCount}）`,
      subtitle: `继续加载剩余 ${nextBatch} 条，共 ${totalCount} 条`,
      actionHint: '加载更多',
      target: { kind: 'load_more', scope: targetScope, nextLimit },
      score: 0
    }
  }

  const activeActions = ACTION_DEFINITIONS.filter((def) => isActionAvailable(def.actionId))

  // Empty query mode: intentional landing / category browse view (never a noisy 60-item dump)
  if (parsed.tokens.length === 0) {
    const countsByScope: Record<PaletteScope, number> = {
      all:
        input.courses.length +
        input.tasks.length +
        input.chapters.length +
        dedupedMaterials.length +
        input.exams.length +
        input.notices.length +
        PAGE_DEFINITIONS.length +
        activeActions.length,
      course: input.courses.length,
      task: input.tasks.length,
      chapter: input.chapters.length,
      material: dedupedMaterials.length,
      exam: input.exams.length,
      notice: input.notices.length,
      command: PAGE_DEFINITIONS.length + activeActions.length
    }

    if (parsed.effectiveScope === 'command') {
      const items: PaletteResultItem[] = [
        ...activeActions.map((def, idx) => buildActionItem(def, 100 - idx)),
        ...PAGE_DEFINITIONS.map((def, idx) => buildPageItem(def, 50 - idx))
      ]
      return {
        commandMode: parsed.commandMode,
        effectiveScope: parsed.effectiveScope,
        cleanQuery: parsed.cleanQuery,
        tokens: [],
        items,
        totalMatches: items.length,
        countsByScope,
        otherScopeMatchCount: 0
      }
    }

    if (parsed.effectiveScope === 'all') {
      const urgentTasks = [...input.tasks]
        .filter((task) => isTaskActionable(task))
        .sort((a, b) => sortTasksDomain(a, b, now))
        .slice(0, 3)

      const landingUrgent: PaletteResultItem[] =
        urgentTasks.length > 0
          ? urgentTasks.map((task, idx) => buildTaskItem(task, 30 - idx, 'urgent'))
          : [...input.courses]
              .sort(sortCoursesDomain)
              .slice(0, 3)
              .map((course, idx) => ({
                ...buildCourseItem(course, 30 - idx),
                id: `urgent-course-${course.id}`,
                group: 'urgent' as const,
                groupLabel: GROUP_LABELS.urgent
              }))

      const landingActions = activeActions
        .filter((def) => !def.commandOnlyInEmpty)
        .map((def, idx) => buildActionItem(def, 20 - idx))

      const landingPages = PAGE_DEFINITIONS.map((def, idx) => buildPageItem(def, 10 - idx))

      const items = [...landingUrgent, ...landingPages, ...landingActions]
      return {
        commandMode: false,
        effectiveScope: 'all',
        cleanQuery: '',
        tokens: [],
        items,
        totalMatches: items.length,
        countsByScope,
        otherScopeMatchCount: 0
      }
    }

    // Specific content scope browse with empty query
    let items: PaletteResultItem[] = []
    let scopeTotal = 0
    if (parsed.effectiveScope === 'course') {
      const sorted = [...input.courses].sort(sortCoursesDomain)
      scopeTotal = sorted.length
      items = sorted
        .slice(0, scopeLimit)
        .map((course, idx) => buildCourseItem(course, scopeLimit - idx))
      if (sorted.length > scopeLimit) {
        items.push(buildLoadMoreItem('course', 'course', items.length, sorted.length))
      }
    } else if (parsed.effectiveScope === 'task') {
      const sorted = [...input.tasks].sort((a, b) => sortTasksDomain(a, b, now))
      scopeTotal = sorted.length
      items = sorted.slice(0, scopeLimit).map((task, idx) => buildTaskItem(task, scopeLimit - idx))
      if (sorted.length > scopeLimit) {
        items.push(buildLoadMoreItem('task', 'task', items.length, sorted.length))
      }
    } else if (parsed.effectiveScope === 'chapter') {
      const sorted = [...input.chapters].sort((a, b) => {
        const ca = courseById.get(a.courseId)?.name ?? ''
        const cb = courseById.get(b.courseId)?.name ?? ''
        return ca.localeCompare(cb, 'zh-CN') || a.sortOrder - b.sortOrder
      })
      scopeTotal = sorted.length
      items = sorted
        .slice(0, scopeLimit)
        .map((chapter, idx) => buildChapterItem(chapter, scopeLimit - idx, null))
      if (sorted.length > scopeLimit) {
        items.push(buildLoadMoreItem('chapter', 'chapter', items.length, sorted.length))
      }
    } else if (parsed.effectiveScope === 'material') {
      const sorted = [...dedupedMaterials].sort((a, b) => {
        const kindOrder = (m: Material) => (m.kind === 'folder' ? 0 : m.kind === 'file' ? 1 : 2)
        return kindOrder(a) - kindOrder(b) || b.updatedAt.localeCompare(a.updatedAt)
      })
      scopeTotal = sorted.length
      items = sorted
        .slice(0, scopeLimit)
        .map((material, idx) => buildMaterialItem(material, scopeLimit - idx))
      if (sorted.length > scopeLimit) {
        items.push(buildLoadMoreItem('material', 'material', items.length, sorted.length))
      }
    } else if (parsed.effectiveScope === 'exam') {
      const sorted = [...input.exams].sort((a, b) => {
        const rankDiff = examUrgencyRank(a, nowMs) - examUrgencyRank(b, nowMs)
        if (rankDiff !== 0) return rankDiff
        return (a.startAt ?? '').localeCompare(b.startAt ?? '')
      })
      scopeTotal = sorted.length
      items = sorted.slice(0, scopeLimit).map((exam, idx) => buildExamItem(exam, scopeLimit - idx))
      if (sorted.length > scopeLimit) {
        items.push(buildLoadMoreItem('exam', 'exam', items.length, sorted.length))
      }
    } else if (parsed.effectiveScope === 'notice') {
      const sorted = [...input.notices].sort((a, b) => {
        const aUnread = a.read === false ? 0 : 1
        const bUnread = b.read === false ? 0 : 1
        if (aUnread !== bUnread) return aUnread - bUnread
        return b.publishedAt.localeCompare(a.publishedAt)
      })
      scopeTotal = sorted.length
      items = sorted
        .slice(0, scopeLimit)
        .map((notice, idx) => buildNoticeItem(notice, scopeLimit - idx, null))
      if (sorted.length > scopeLimit) {
        items.push(buildLoadMoreItem('notice', 'notice', items.length, sorted.length))
      }
    }

    return {
      commandMode: false,
      effectiveScope: parsed.effectiveScope,
      cleanQuery: '',
      tokens: [],
      items,
      totalMatches: scopeTotal,
      countsByScope,
      otherScopeMatchCount: 0
    }
  }

  // Non-empty query: score all items across every category without pre-truncation
  const matchedByGroup: Record<Exclude<PaletteGroupId, 'urgent'>, PaletteResultItem[]> = {
    course: [],
    task: [],
    exam: [],
    chapter: [],
    material: [],
    notice: [],
    page: [],
    action: []
  }

  // 1. Pages & Actions
  for (const def of PAGE_DEFINITIONS) {
    const scored = scoreCandidate(fullQuery, parsed.tokens, def.title, def.keywords, def.subtitle)
    if (scored !== null) {
      matchedByGroup.page.push(buildPageItem(def, scored.score, scored.tier))
    }
  }
  for (const def of activeActions) {
    const scored = scoreCandidate(fullQuery, parsed.tokens, def.title, def.keywords, def.subtitle)
    if (scored !== null) {
      matchedByGroup.action.push(buildActionItem(def, scored.score, scored.tier))
    }
  }

  // 2. Courses (always computed unless in strict `>` commandMode)
  if (!parsed.commandMode) {
    for (const course of input.courses) {
      const primary = [
        course.teacher,
        course.semester,
        course.className,
        course.code,
        course.clazzId,
        getCourseClassLabel(course)
      ]
        .filter(Boolean)
        .join(' ')
      const scored = scoreCandidate(fullQuery, parsed.tokens, course.name, primary, course.category)
      if (scored !== null) {
        const favoriteBoost = course.favorite ? 15 : 0
        matchedByGroup.course.push(
          buildCourseItem(course, scored.score + favoriteBoost, scored.tier)
        )
      }
    }

    // 3. Tasks
    for (const task of input.tasks) {
      const course = task.courseId ? courseById.get(task.courseId) : undefined
      const badge = taskBadge(task, now)
      const primary = [
        course?.name,
        course ? getCourseClassLabel(course) : null,
        course?.teacher,
        badge.text
      ]
        .filter(Boolean)
        .join(' ')
      const secondary = [task.description, task.platformStatus, task.teacherFeedback]
        .filter(Boolean)
        .join(' ')
      const scored = scoreCandidate(fullQuery, parsed.tokens, task.title, primary, secondary)
      if (scored !== null) {
        const urgencyBoost = Math.max(0, 40 - taskUrgencyRank(task, now) * 5)
        matchedByGroup.task.push(
          buildTaskItem(task, scored.score + urgencyBoost, undefined, scored.tier)
        )
      }
    }

    // 4. Chapters (including nested sections!)
    for (const chapter of input.chapters) {
      const course = courseById.get(chapter.courseId)
      const sectionLabels = chapter.sections.map((section) =>
        section.number?.trim() ? `${section.number.trim()} ${section.title}` : section.title
      )
      const primary = [
        course?.name,
        course ? getCourseClassLabel(course) : null,
        `第 ${chapter.sortOrder + 1} 章`,
        ...sectionLabels
      ]
        .filter(Boolean)
        .join(' ')
      const scored = scoreCandidate(fullQuery, parsed.tokens, chapter.title, primary, '')
      if (scored !== null) {
        let matchedSectionLabel: string | null = null
        const normChapterTitle = normalizeSearchText(chapter.title)
        const allInChapterTitle = parsed.tokens.every((token) => normChapterTitle.includes(token))
        if (!allInChapterTitle) {
          for (const label of sectionLabels) {
            const normLabel = normalizeSearchText(label)
            if (parsed.tokens.some((token) => normLabel.includes(token))) {
              matchedSectionLabel = label
              break
            }
          }
        }
        matchedByGroup.chapter.push(
          buildChapterItem(chapter, scored.score, matchedSectionLabel, scored.tier)
        )
      }
    }

    // 5. Materials (deduplicated exact rows only)
    for (const material of dedupedMaterials) {
      const course = courseById.get(material.courseId)
      const typeLabel = materialTypeLabel(material)
      const primary = [
        course?.name,
        course ? getCourseClassLabel(course) : null,
        typeLabel,
        material.fileType
      ]
        .filter(Boolean)
        .join(' ')
      const scored = scoreCandidate(
        fullQuery,
        parsed.tokens,
        material.name,
        primary,
        material.size ?? ''
      )
      if (scored !== null) {
        matchedByGroup.material.push(buildMaterialItem(material, scored.score, scored.tier))
      }
    }

    // 6. Exams
    for (const exam of input.exams) {
      const primary = [exam.courseName, exam.examStatus, exam.answerStatus, exam.mode]
        .filter(Boolean)
        .join(' ')
      const scored = scoreCandidate(fullQuery, parsed.tokens, exam.title, primary, exam.score ?? '')
      if (scored !== null) {
        const urgencyBoost = Math.max(0, 20 - examUrgencyRank(exam, nowMs) * 8)
        matchedByGroup.exam.push(buildExamItem(exam, scored.score + urgencyBoost, scored.tier))
      }
    }

    // 7. Notices (including body matching & snippet)
    for (const notice of input.notices) {
      const primary = [notice.courseName, notice.sender, notice.read === false ? '未读' : '']
        .filter(Boolean)
        .join(' ')
      const scored = scoreCandidate(fullQuery, parsed.tokens, notice.title, primary, notice.body)
      if (scored !== null) {
        const normTitle = normalizeSearchText(notice.title)
        const allInTitle = parsed.tokens.every((token) => normTitle.includes(token))
        const snippet = allInTitle ? null : extractBodySnippet(notice.body, parsed.tokens)
        const unreadBoost = notice.read === false ? 20 : 0
        matchedByGroup.notice.push(
          buildNoticeItem(notice, scored.score + unreadBoost, snippet, scored.tier)
        )
      }
    }
  }

  const compareTierAndScore = (a: PaletteResultItem, b: PaletteResultItem): number => {
    const tierDiff = (a.matchTier ?? 3) - (b.matchTier ?? 3)
    if (tierDiff !== 0) return tierDiff
    return b.score - a.score
  }

  // Sort within each group by exact/prefix tier first, then score desc, then domain tie-breaker
  matchedByGroup.course.sort((a, b) => {
    const rank = compareTierAndScore(a, b)
    if (rank !== 0) return rank
    if (a.target.kind === 'course' && b.target.kind === 'course') {
      return sortCoursesDomain(a.target.course, b.target.course)
    }
    return a.title.localeCompare(b.title, 'zh-CN')
  })
  matchedByGroup.task.sort((a, b) => {
    const rank = compareTierAndScore(a, b)
    if (rank !== 0) return rank
    if (a.target.kind === 'task' && b.target.kind === 'task') {
      return sortTasksDomain(a.target.task, b.target.task, now)
    }
    return a.title.localeCompare(b.title, 'zh-CN')
  })
  matchedByGroup.chapter.sort((a, b) => {
    const rank = compareTierAndScore(a, b)
    if (rank !== 0) return rank
    if (a.target.kind === 'chapter' && b.target.kind === 'chapter') {
      return a.target.chapter.sortOrder - b.target.chapter.sortOrder
    }
    return a.title.localeCompare(b.title, 'zh-CN')
  })
  matchedByGroup.material.sort(
    (a, b) => compareTierAndScore(a, b) || a.title.localeCompare(b.title, 'zh-CN')
  )
  matchedByGroup.exam.sort(
    (a, b) => compareTierAndScore(a, b) || a.title.localeCompare(b.title, 'zh-CN')
  )
  matchedByGroup.notice.sort((a, b) => {
    const rank = compareTierAndScore(a, b)
    if (rank !== 0) return rank
    if (a.target.kind === 'notice' && b.target.kind === 'notice') {
      return b.target.notice.publishedAt.localeCompare(a.target.notice.publishedAt)
    }
    return a.title.localeCompare(b.title, 'zh-CN')
  })
  matchedByGroup.page.sort(compareTierAndScore)
  matchedByGroup.action.sort(compareTierAndScore)

  const commandCount = matchedByGroup.page.length + matchedByGroup.action.length
  const totalAll =
    matchedByGroup.course.length +
    matchedByGroup.task.length +
    matchedByGroup.chapter.length +
    matchedByGroup.material.length +
    matchedByGroup.exam.length +
    matchedByGroup.notice.length +
    commandCount

  const countsByScope: Record<PaletteScope, number> = {
    all: totalAll,
    course: matchedByGroup.course.length,
    task: matchedByGroup.task.length,
    chapter: matchedByGroup.chapter.length,
    material: matchedByGroup.material.length,
    exam: matchedByGroup.exam.length,
    notice: matchedByGroup.notice.length,
    command: commandCount
  }

  const activeGroups: Array<Exclude<PaletteGroupId, 'urgent'>> =
    parsed.effectiveScope === 'command'
      ? ['action', 'page']
      : parsed.effectiveScope === 'all'
        ? ['course', 'task', 'exam', 'chapter', 'material', 'notice', 'page', 'action']
        : [parsed.effectiveScope]

  // Order groups contiguously so headers NEVER fragment or repeat.
  // True normalized exact title matches (tier 0) strictly outrank prefix (tier 1),
  // title substring (tier 2), and context matches (tier 3) across all groups.
  const nonEmptyGroups = activeGroups.filter((group) => matchedByGroup[group].length > 0)
  nonEmptyGroups.sort((a, b) => {
    const aTopTier = matchedByGroup[a][0]?.matchTier ?? 3
    const bTopTier = matchedByGroup[b][0]?.matchTier ?? 3
    if (aTopTier !== bTopTier) return aTopTier - bTopTier
    if (parsed.effectiveScope === 'command') {
      return (COMMAND_GROUP_ORDER[a] ?? 9) - (COMMAND_GROUP_ORDER[b] ?? 9)
    }
    return CONTENT_GROUP_ORDER[a] - CONTENT_GROUP_ORDER[b]
  })

  const items: PaletteResultItem[] = []
  const perGroupLimit = parsed.effectiveScope === 'all' ? groupPreviewLimit : scopeLimit
  const scopeLabelMap = new Map(PALETTE_SCOPES.map((s) => [s.id, s.label]))

  for (const group of nonEmptyGroups) {
    const list = matchedByGroup[group]
    const visible = list.slice(0, perGroupLimit)
    items.push(...visible)
    if (list.length > perGroupLimit) {
      const targetScope: Exclude<PaletteScope, 'all'> =
        group === 'page' || group === 'action' ? 'command' : group
      if (parsed.effectiveScope === 'all') {
        items.push({
          id: `expand-${group}`,
          group,
          groupLabel: GROUP_LABELS[group],
          scope: targetScope,
          title: `查看全部 ${list.length} 条${GROUP_LABELS[group]}`,
          subtitle: `切换至「${scopeLabelMap.get(targetScope) ?? GROUP_LABELS[group]}」分类查看完整结果`,
          actionHint: '展开分类',
          target: { kind: 'expand_scope', scope: targetScope },
          score: 0
        })
      } else {
        items.push(buildLoadMoreItem(group, targetScope, visible.length, list.length))
      }
    }
  }

  const currentScopeTotal = countsByScope[parsed.effectiveScope]
  const otherScopeMatchCount =
    parsed.effectiveScope !== 'all' && currentScopeTotal === 0 ? totalAll : 0

  return {
    commandMode: parsed.commandMode,
    effectiveScope: parsed.effectiveScope,
    cleanQuery: parsed.cleanQuery,
    tokens: parsed.tokens,
    items,
    totalMatches: currentScopeTotal,
    countsByScope,
    otherScopeMatchCount
  }
}
