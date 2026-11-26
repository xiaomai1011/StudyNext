import type { PlatformStatusKind, TaskAttachment } from '@shared/types'
import { resolveNoticeCourseName } from '@shared/notice-course'
import { normalizeExamScore } from '@shared/today-schedule'
import type { FieldReadState } from './field-semantics'

/**
 * 学习通页面解析器（纯函数）。
 *
 * 设计原则：
 * - 只解析页面结构，不发请求，便于用固定 HTML 夹具做单元测试。
 * - 任何单字段解析失败都返回 null，不抛错；只有“整页不可用”才抛
 *   ChaoxingParseError，让上层区分“没有数据”和“请求失败”。
 * - 不记录、不返回任何 Cookie、Token 或完整敏感 URL。
 */

export class ChaoxingParseError extends Error {
  constructor(
    readonly code: 'NOT_LOGGED_IN' | 'SIGNATURE_INVALID' | 'UNEXPECTED_PAGE',
    message: string
  ) {
    super(message)
    this.name = 'ChaoxingParseError'
  }
}

export interface LoginProbe {
  state: 'authenticated' | 'logged_out' | 'unknown'
  reason: string
}

const LOGIN_URL_MARKERS = [
  'passport2.chaoxing.com/login',
  'passport.chaoxing.com/login',
  'passport2.chaoxing.com/fanyalogin'
]

const LOGIN_BODY_MARKERS = ['id="loginBtn"', 'id="phone"', 'name="pwd"', '用户登录', '新用户注册']

const AUTH_BODY_MARKERS = ['个人空间', 'id="frame_content"', 'aria-label="账号', 'var uid']

export function detectLoginState(finalUrl: string, body: string): LoginProbe {
  const url = finalUrl.toLowerCase()
  const hasLoginUrl = LOGIN_URL_MARKERS.some((marker) => url.includes(marker))
  const hasAuthMarker = AUTH_BODY_MARKERS.some((marker) => body.includes(marker))
  if (hasLoginUrl && !hasAuthMarker) {
    return { state: 'logged_out', reason: '请求被重定向到学习通登录页' }
  }
  if (hasAuthMarker) {
    return { state: 'authenticated', reason: '页面包含个人空间标识' }
  }
  const loginHits = LOGIN_BODY_MARKERS.filter((marker) => body.includes(marker)).length
  if (loginHits >= 2 || hasLoginUrl) {
    return { state: 'logged_out', reason: '页面呈现登录表单' }
  }
  return { state: 'unknown', reason: '页面结构无法判定登录状态' }
}

export interface ChaoxingProfile {
  name: string | null
  school: string | null
  uid: string | null
  fid: string | null
}

/**
 * The personal-space shell keeps the course grid in a cross-origin iframe
 * (`#frame_content`). Fetch that frame URL with the same session before
 * parsing course links.
 */
export function parseCourseFrameUrl(
  html: string,
  baseUrl = 'https://i.chaoxing.com/base'
): string | null {
  const tags = html.match(/<iframe\b[^>]*>/gi) ?? []
  for (const tag of tags) {
    const id = matchFirst(tag, /\bid\s*=\s*["']?([^"'\s>]+)/i)
    const name = matchFirst(tag, /\bname\s*=\s*["']?([^"'\s>]+)/i)
    if (id !== 'frame_content' && name !== 'frame_content') continue
    const src =
      matchFirst(tag, /\bsrc\s*=\s*["']([^"']+)["']/i) ?? matchFirst(tag, /\bsrc\s*=\s*([^\s>]+)/i)
    if (!src) continue
    const raw = decodeEntities(src)
      .trim()
      .replace(/^["']+|["']+$/g, '')
    if (!raw || raw === 'about:blank' || raw.startsWith('javascript:')) continue
    try {
      const url = new URL(raw, baseUrl)
      if (url.protocol !== 'https:') continue
      if (url.toString() === new URL(baseUrl).toString()) continue
      return url.toString()
    } catch {
      continue
    }
  }

  // The personal-space shell often renders iframe src via JS; the same URL is
  // present in the module menu as dataurl / setUrl(...) before scripts run.
  const dataUrl = matchFirst(
    html,
    /dataurl\s*=\s*["'](https:\/\/mooc2-ans\.chaoxing\.com\/visit\/interaction[^"']*)["']/i
  )
  if (dataUrl) return decodeEntities(dataUrl)
  const setUrlTarget = matchFirst(
    html,
    /setUrl\([^,]*,\s*['"](https:\/\/mooc2-ans\.chaoxing\.com\/visit\/interaction[^'"]*)['"]/i
  )
  if (setUrlTarget) return decodeEntities(setUrlTarget)
  return null
}

export function parseProfile(html: string): ChaoxingProfile {
  const name =
    matchFirst(html, /aria-label="账号[:：]\s*([^"<]{1,40})"/) ??
    matchFirst(html, /账号[:：]\s*([^<\s"']{1,40})/)
  const school = matchFirst(html, /id="siteName"[^>]*title="([^"]+)"/)
  const rawUid = matchFirst(html, /var uid\s*=\s*'?(\d+)'?/)
  // Only a numeric platform UID is stable identity; never derive it from a display name.
  const uid = rawUid && /^\d{1,20}$/.test(rawUid) ? rawUid : null
  const fid = matchFirst(html, /"fid"\s*:\s*"?(\d+)"?/) ?? matchFirst(html, /var fid\s*=\s*'(\d+)'/)
  return {
    name: normalizeText(name),
    school: normalizeText(school),
    uid: normalizeText(uid),
    fid: normalizeText(fid)
  }
}

export interface ChaoxingCourseRecord {
  courseId: string
  clazzId: string
  cpi: string
  name: string
  teacher: string
}

export function parseCourseList(html: string): ChaoxingCourseRecord[] {
  const courses: ChaoxingCourseRecord[] = []
  const seen = new Set<string>()
  const anchorPattern = /href="([^"]*stucoursemiddle[^"]*)"/gi
  let match: RegExpExecArray | null
  while ((match = anchorPattern.exec(html)) !== null) {
    const rawHref = decodeEntities(match[1] ?? '')
    const params = readQueryParams(rawHref)
    const courseId = params.get('courseid')
    const clazzId = params.get('clazzid')
    if (!courseId || !clazzId) continue
    const key = `${courseId}:${clazzId}`
    if (seen.has(key)) continue
    seen.add(key)
    const block = blockAround(html, match.index)
    const name =
      matchFirst(block, /course-name[^>]*title="([^"]+)"/) ??
      matchFirst(block, /class="[^"]*course-name[^"]*"[^>]*>\s*([^<]{1,80})</i) ??
      matchFirst(
        block,
        /<h3[^>]*class="[^"]*inlineBlock[^"]*"[^>]*>[\s\S]{0,500}?<a[^>]*>([^<]{2,80})<\/a>/i
      ) ??
      matchFirst(block, /<a[^>]*class="[^"]*course[^"]*"[^>]*title="([^"]+)"/i) ??
      matchFirst(block, /title="([^"]{2,80})"/)
    const teacher =
      matchFirst(block, /class="line2 color3"[^>]*title="([^"]+)"/) ??
      matchFirst(block, /<p class="overHidden2"[^>]*>([^<]{2,20})<\/p>/)
    courses.push({
      courseId,
      clazzId,
      cpi: params.get('cpi') ?? '',
      name: normalizeText(name) ?? '',
      teacher: normalizeText(teacher) ?? ''
    })
  }
  return courses
}

export function readHiddenValue(html: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const nameFirst = new RegExp(
    `<input[^>]*name=["']?${escaped}["']?[^>]*value=["']([^"']*)["']`,
    'i'
  )
  const valueFirst = new RegExp(
    `<input[^>]*value=["']([^"']*)["'][^>]*name=["']?${escaped}["']?`,
    'i'
  )
  return matchFirst(html, nameFirst) ?? matchFirst(html, valueFirst)
}

export interface ChaoxingHomeworkItem {
  title: string
  status: string
  url: string
  externalId: string | null
}

export interface ChaoxingHomeworkList {
  progress: { done: number; total: number } | null
  items: ChaoxingHomeworkItem[]
}

export function parseHomeworkList(html: string): ChaoxingHomeworkList {
  if (html.includes('没有此页面访问权限') || html.includes('無此頁面訪問權限')) {
    throw new ChaoxingParseError(
      'SIGNATURE_INVALID',
      '作业页签名校验失败，课程页可能已过期，请稍后重试'
    )
  }
  const progressMatch = /<span>(\d+)\/(\d+)<\/span>/.exec(html)
  const progress = progressMatch
    ? { done: Number(progressMatch[1]), total: Number(progressMatch[2]) }
    : null
  const items: ChaoxingHomeworkItem[] = []
  const liPattern = /<li[^>]*onclick="goTask\(this\);"[^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = liPattern.exec(html)) !== null) {
    const tag = match[0]
    const data = matchFirst(tag, /data="([^"]+)"/) ?? null
    const blockEnd = html.indexOf('</li>', match.index)
    const block = html.slice(match.index, blockEnd === -1 ? match.index + 3000 : blockEnd)
    const title =
      matchFirst(block, /class="overHidden2 fl"[^>]*>([^<]+)<\/p>/) ??
      matchFirst(block, /aria-label="([^";]+)[;"]/)
    if (!title) continue
    const status = matchFirst(block, /class="status fl"[^>]*>([^<]*)<\/p>/) ?? ''
    const url = data ? absoluteHomeworkUrl(safeDecode(decodeEntities(data))) : ''
    items.push({
      title: normalizeText(title) ?? '',
      status: normalizeText(status) ?? '',
      url,
      externalId: readHomeworkId(url)
    })
  }
  return { progress, items }
}

export interface ChaoxingHomeworkDetail {
  title: string | null
  questionCount: number | null
  fullScore: number | null
  startText: string | null
  deadlineText: string | null
  score: string | null
  submittedAtText: string | null
  teacherFeedback: string | null
  attachments: TaskAttachment[]
  /** 页面是否具备完整作业详情结构；不完整时所有字段按 unread 处理。 */
  complete: boolean
  /**
   * 每个字段的读取状态。同步层据此区分“没读到”“读到有效值”“平台明确为空”，
   * 避免把一次不完整响应当成平台清空，也避免平台真的清空后本地永远保留旧值。
   */
  fields: {
    score: FieldReadState
    fullScore: FieldReadState
    teacherFeedback: FieldReadState
    submittedAt: FieldReadState
    deadline: FieldReadState
    attachments: FieldReadState
  }
}

const DETAIL_FIELD_LABELS = [
  '教师批语',
  '教师评语',
  '批语',
  '评语',
  '得分',
  '总分',
  '成绩',
  '批阅',
  '智能分析',
  '满分',
  '提交时间',
  '提交日期',
  '提交于',
  '首次提交',
  '截止时间',
  '截止日期',
  '结束时间',
  '附件列表',
  '提交附件',
  '作业附件',
  '附件',
  '题量',
  '我的答案',
  '正确答案',
  '作答记录'
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 取出标签后的字段片段，截断到下一个已知详情标签之前。 */
function readFieldSegment(text: string, labels: string[]): string | null {
  const labelPattern = labels.map(escapeRegExp).join('|')
  const label = new RegExp(`(?:${labelPattern})\\s*[:：]?`, 'i').exec(text)
  if (!label) return null
  const start = label.index + label[0].length
  const after = text.slice(start)
  const nextPattern = new RegExp(
    `\\s*(?:${DETAIL_FIELD_LABELS.map(escapeRegExp).join('|')})\\s*[:：]?`,
    'i'
  )
  const next = nextPattern.exec(after)
  return (next ? after.slice(0, next.index) : after).trim()
}

function isLoadingFieldValue(value: string): boolean {
  return /(?:加载中|读取中|正在加载|暂无加载结果|loading)/i.test(value)
}

function isExplicitEmptyFieldValue(value: string): boolean {
  const normalized = value
    .replace(/^[\s:：]+/, '')
    .replace(/[\s。；;]+$/g, '')
    .trim()
  return /^(?:—|--|-|无|暂无|未批阅|未评分|未提交|暂无批语|无批语)$/.test(normalized)
}

function isExplicitEmptyAttachmentValue(value: string): boolean {
  const normalized = value
    .replace(/^[\s:：]+/, '')
    .replace(/[\s。；;]+$/g, '')
    .trim()
  return /^(?:—|--|-|无|暂无|无附件|暂无附件)$/.test(normalized)
}

/**
 * 附件区的“加载中”标记。附件是异步渲染的，页面整体完整不代表附件已经扫描完成。
 * 出现这些标记时一律视为 unread，不能把空结果当成平台明确删除附件。
 */
const ATTACHMENT_BUSY_PATTERN =
  /(?:aria-busy\s*=\s*["']?true["']?|data-loading\s*=\s*["']?true["']?|class\s*=\s*["'][^"']*\b(?:loading|is-loading|attach-loading)\b)/i

/**
 * 附件区的“扫描完成”标记。只有平台自己给出完成证据时才允许把空列表当成
 * 明确清空；没有证据时保留历史附件，宁可暂时显示旧数据也不误删。
 */
const ATTACHMENT_COMPLETE_PATTERN =
  /(?:aria-busy\s*=\s*["']?false["']?|data-loaded\s*=\s*["']?true["']?|data-complete\s*=\s*["']?true["']?|data-scan(?:ned)?\s*=\s*["']?true["']?|附件(?:列表)?\s*(?:已)?加载完成|附件扫描完成)/i

const ATTACHMENT_CONTAINER_PATTERN =
  /<(?:div|section|ul|ol|dl|table|tbody)\b[^>]*(?:class|id)\s*=\s*["'][^"']*\battach[a-z-]*\b[^"']*["'][^>]*>/gi

const ATTACHMENT_LABEL_PATTERN = /附件(?:列表)?\s*[:：]/g

/**
 * “附件：”标签可能落在行内元素（span/em）里，真正承载附件状态的通常是最近的
 * 块级容器。只向上找块级元素，避免把 `<span>附件：</span><span>暂无附件</span>`
 * 切成半个区域。
 */
const ATTACHMENT_REGION_TAGS = new Set([
  'div',
  'section',
  'article',
  'aside',
  'li',
  'ul',
  'ol',
  'dl',
  'dd',
  'dt',
  'td',
  'th',
  'tr',
  'table',
  'tbody',
  'p',
  'form',
  'fieldset'
])

/** HTML 中不参与嵌套计数的空元素。 */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
])

interface OpenTagFrame {
  tag: string
  start: number
  end: number
}

interface AttachmentRegion {
  start: number
  end: number
  html: string
}

/**
 * 扫描 `until` 之前的开始/结束标签，返回仍未闭合的元素栈。
 * 用于定位某个文本（例如“附件：”）真正所在的元素边界，而不是按固定长度切片。
 */
function scanOpenTags(html: string, until: number): OpenTagFrame[] {
  const stack: OpenTagFrame[] = []
  const pattern = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)([^>]*?)(\/?)>/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    if (match.index >= until) break
    const closing = match[1] === '/'
    const tag = (match[2] ?? '').toLowerCase()
    const selfClosing = match[4] === '/'
    if (closing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index]?.tag === tag) {
          stack.length = index
          break
        }
      }
      continue
    }
    if (selfClosing || VOID_TAGS.has(tag)) continue
    if (tag === 'script' || tag === 'style') {
      const closeIndex = html.toLowerCase().indexOf(`</${tag}`, match.index)
      if (closeIndex !== -1) pattern.lastIndex = closeIndex
      continue
    }
    stack.push({ tag, start: match.index, end: match.index + match[0].length })
  }
  return stack
}

/** 从开始标签处向后匹配同名结束标签，返回区域结束下标；无法平衡时返回 null。 */
function findElementEnd(html: string, startIndex: number, tag: string): number | null {
  if (VOID_TAGS.has(tag)) return startIndex
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'gi')
  pattern.lastIndex = startIndex
  let depth = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    const closing = match[1] === '/'
    const selfClosing = match[2] === '/'
    if (closing) {
      depth -= 1
      if (depth === 0) return match.index + match[0].length
      if (depth < 0) return null
      continue
    }
    if (selfClosing) continue
    depth += 1
  }
  return null
}

/**
 * 找出所有可信的附件区域（真实元素边界）：
 * - class/id 含 `attach` 的容器元素；
 * - “附件：”标签所在的最小元素。
 * 无法确定边界时标记 unreliable，调用方按 unread 处理。
 */
function readAttachmentRegions(html: string): {
  regions: AttachmentRegion[]
  unreliable: boolean
} {
  const regions: AttachmentRegion[] = []
  let unreliable = false
  const push = (start: number, end: number | null): void => {
    if (end === null || end <= start) {
      unreliable = true
      return
    }
    if (regions.some((region) => start >= region.start && end <= region.end)) return
    regions.push({ start, end, html: html.slice(start, end) })
  }

  ATTACHMENT_CONTAINER_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ATTACHMENT_CONTAINER_PATTERN.exec(html)) !== null) {
    const tagMatch = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(match[0])
    const tagName = tagMatch?.[1]
    if (!tagName) continue
    push(match.index, findElementEnd(html, match.index, tagName.toLowerCase()))
  }

  ATTACHMENT_LABEL_PATTERN.lastIndex = 0
  while ((match = ATTACHMENT_LABEL_PATTERN.exec(html)) !== null) {
    const labelIndex = match.index
    const stack = scanOpenTags(html, labelIndex)
    if (stack.length === 0) {
      unreliable = true
      continue
    }
    let enclosing = stack[stack.length - 1]
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const frame = stack[index]
      if (frame && ATTACHMENT_REGION_TAGS.has(frame.tag)) {
        enclosing = frame
        break
      }
    }
    if (!enclosing || enclosing.tag === 'body' || enclosing.tag === 'html') {
      unreliable = true
      continue
    }
    if (regions.some((region) => labelIndex >= region.start && labelIndex < region.end)) continue
    push(enclosing.start, findElementEnd(html, enclosing.start, enclosing.tag))
  }

  return { regions, unreliable }
}

/** 去掉“附件：”标签前缀，只留字段值文本。 */
function readAttachmentValueText(text: string): string {
  const label = /附件(?:列表)?\s*[:：]/.exec(text)
  if (!label) return text.trim()
  return text.slice(label.index + label[0].length).trim()
}

/**
 * 计算附件字段的读取状态（CP3-F2-03-R 第二轮）。
 *
 * 关键约束：完成证据、忙碌状态和“明确为空”的文本必须来自同一个附件区域。
 * 不允许用整页 `data-loaded="true"`（例如成绩区域）当作附件扫描完成，也不允许
 * 按固定长度截取片段把容器外的兄弟节点算进来。
 *
 * 规则：
 * - 解析到附件 → present。
 * - 无附件区域、区域边界不可靠、区域为空且无完成证据、区域忙碌、区域仍在加载 → unread。
 * - 只有区域自身带完成证据且区域内明确显示无附件 → confirmed_absent。
 */
function readAttachmentFieldState(html: string, attachments: TaskAttachment[]): FieldReadState {
  if (attachments.length > 0) return 'present'
  const { regions, unreliable } = readAttachmentRegions(html)
  if (unreliable) return 'unread'
  if (regions.length === 0) return 'unread'
  for (const region of regions) {
    if (ATTACHMENT_BUSY_PATTERN.test(region.html)) return 'unread'
  }
  for (const region of regions) {
    if (isLoadingFieldValue(stripTags(region.html))) return 'unread'
  }
  const completed = regions.filter((region) => ATTACHMENT_COMPLETE_PATTERN.test(region.html))
  if (completed.length === 0) return 'unread'
  for (const region of completed) {
    const value = readAttachmentValueText(stripTags(region.html))
    if (isExplicitEmptyAttachmentValue(value)) return 'confirmed_absent'
  }
  return 'unread'
}

export function parseHomeworkDetail(html: string): ChaoxingHomeworkDetail {
  const text = stripTags(html)
  const complete =
    /作业详情/.test(text) &&
    /(?:题量[:：]|满分[:：]|提交时间[:：]|得分[:：]|教师批语[:：]|截止时间[:：])/.test(text)
  const result: ChaoxingHomeworkDetail = {
    title: null,
    questionCount: null,
    fullScore: null,
    startText: null,
    deadlineText: null,
    score: null,
    submittedAtText: null,
    teacherFeedback: null,
    attachments: [],
    complete,
    fields: {
      score: 'unread',
      fullScore: 'unread',
      teacherFeedback: 'unread',
      submittedAt: 'unread',
      deadline: 'unread',
      attachments: 'unread'
    }
  }
  const countIndex = text.search(/题量[:：]/)
  if (countIndex > 0) {
    const head = text.slice(0, countIndex)
    const marker = head.lastIndexOf('作业详情')
    if (marker >= 0) {
      const title = head.slice(marker + 4).trim()
      if (title) result.title = title
    }
  }
  const count = matchFirst(text, /题量[:：]\s*(\d+)/)
  if (count) result.questionCount = Number(count)
  const fullScoreSegment = readFieldSegment(text, ['满分'])
  if (fullScoreSegment !== null) {
    if (isLoadingFieldValue(fullScoreSegment)) {
      result.fields.fullScore = 'unread'
    } else {
      const fullScore = matchFirst(fullScoreSegment, /(\d+(?:\.\d+)?)/)
      if (fullScore) {
        result.fullScore = Number(fullScore)
        result.fields.fullScore = 'present'
      } else if (isExplicitEmptyFieldValue(fullScoreSegment)) {
        result.fields.fullScore = 'confirmed_absent'
      } else {
        // 标签存在但没有可靠数字：加载中/空占位/解析失败均视为未读取。
        result.fields.fullScore = 'unread'
      }
    }
  }
  const range =
    /(?:作答时间|考试时间|答题时间)[:：]\s*(\d{1,4}-?\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})\s*(?:至|到|-|—)\s*(\d{1,4}-?\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/.exec(
      text
    )
  if (range) {
    result.startText = range[1] ?? null
    result.deadlineText = range[2] ?? null
    result.fields.deadline = result.deadlineText ? 'present' : 'unread'
  } else {
    const single =
      /(?:截止时间|截止日期|结束时间)[:：]\s*(\d{1,4}-?\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/.exec(text)
    if (single) {
      result.deadlineText = single[1] ?? null
      result.fields.deadline = result.deadlineText ? 'present' : 'unread'
    }
  }
  const scoreSegment = readFieldSegment(text, ['得分', '总分', '成绩', '批阅', '智能分析'])
  if (scoreSegment !== null) {
    if (isLoadingFieldValue(scoreSegment)) {
      result.fields.score = 'unread'
    } else {
      const score =
        matchFirst(scoreSegment, /(\d+(?:\.\d+)?)\s*分?/) ??
        matchFirst(scoreSegment, /(\d+(?:\.\d+)?)/)
      if (score) {
        // “0 分”是有效成绩，不能被当成缺失。
        result.score = score
        result.fields.score = 'present'
      } else if (isExplicitEmptyFieldValue(scoreSegment)) {
        result.fields.score = 'confirmed_absent'
      } else {
        result.fields.score = 'unread'
      }
    }
  }
  const submittedSegment = readFieldSegment(text, ['提交时间', '提交日期', '提交于', '首次提交'])
  if (submittedSegment !== null) {
    if (isLoadingFieldValue(submittedSegment)) {
      result.fields.submittedAt = 'unread'
    } else {
      const submitted = /(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)/.exec(submittedSegment)
      if (submitted) {
        result.submittedAtText = submitted[1] ?? null
        result.fields.submittedAt = 'present'
      } else if (isExplicitEmptyFieldValue(submittedSegment)) {
        result.fields.submittedAt = 'confirmed_absent'
      } else {
        result.fields.submittedAt = 'unread'
      }
    }
  }
  const feedbackSegment = readFieldSegment(text, ['教师批语', '教师评语', '批语', '评语'])
  if (feedbackSegment !== null) {
    if (isLoadingFieldValue(feedbackSegment)) {
      result.fields.teacherFeedback = 'unread'
    } else {
      const value = normalizeText(feedbackSegment.replace(/^[\s:：]+/, ''))?.split(
        /\s(?:一|二|三|四|五)[.、]/
      )[0]
      if (value && !isExplicitEmptyFieldValue(value)) {
        result.teacherFeedback = value.slice(0, 300)
        result.fields.teacherFeedback = 'present'
      } else if (value && isExplicitEmptyFieldValue(value)) {
        result.fields.teacherFeedback = 'confirmed_absent'
      } else {
        // 空 DOM 节点、空字符串、加载中都不是平台明确清空。
        result.fields.teacherFeedback = 'unread'
      }
    }
  }
  result.attachments = parseTaskAttachments(html)
  if (!complete) {
    result.fields = {
      score: 'unread',
      fullScore: 'unread',
      teacherFeedback: 'unread',
      submittedAt: 'unread',
      deadline: 'unread',
      attachments: 'unread'
    }
    return result
  }
  // 附件必须有独立扫描完成证据：解析到附件即 present；附件区缺失、带 loading
  // 标记、空容器、无完成证据一律 unread；只有附件区明确完成且明确为空才
  // confirmed_absent。不能把整个详情页的 complete 当成附件扫描完成。
  result.fields.attachments = readAttachmentFieldState(html, result.attachments)
  return result
}

/**
 * 作业详情页的附件列表有两种渲染方式：
 * - 编辑器内容里的 `<iframe class="attach-iframe" objectid filename filesize>`
 * - 已提交附件区的 `<div class="attach" data="<objectid>">` + dataName/dataSize
 * 只读解析，不打开、不下载。
 */
export function parseTaskAttachments(html: string): TaskAttachment[] {
  const result: TaskAttachment[] = []
  const seen = new Set<string>()
  const tagPattern = /<(iframe|div)\b[^>]*class="[^"]*\battach(?:-iframe)?\b[^"]*"[^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = tagPattern.exec(html)) !== null) {
    const tag = match[0]
    const tagName = (match[1] ?? '').toLowerCase()
    const objectId = readTagAttribute(tag, 'objectid') ?? readTagAttribute(tag, 'data') ?? null
    let name = readTagAttribute(tag, 'filename') ?? ''
    let size = readTagAttribute(tag, 'filesize') ?? null
    if (tagName === 'div') {
      const end = html.indexOf('</div>', match.index)
      const block = html.slice(match.index, end === -1 ? match.index + 800 : end)
      name = name || matchFirst(block, /class="dataName"[^>]*>([^<]{1,200})<\/span>/) || ''
      size = size ?? matchFirst(block, /class="dataSize"[^>]*>([^<]{1,40})<\/span>/)
    }
    const normalizedName = normalizeText(decodeEntities(name))
    if (!normalizedName) continue
    const key = `${objectId ?? ''}|${normalizedName}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      name: normalizedName,
      size: size ? normalizeText(size) : null,
      objectId: objectId || null
    })
  }
  return result
}

function readTagAttribute(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`${escaped}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i')
  const matched = pattern.exec(tag)
  if (!matched) return null
  return matched[2] ?? matched[3] ?? null
}

/**
 * 学习通详情页只给“月-日 时:分”，没有年份。用离当前时间最近的年份补齐，
 * 跨年（12 月截止、1 月查看）时不会把截止时间算到一年后。
 */
export function resolveDeadline(text: string | null, now: Date = new Date()): string | null {
  if (!text) return null
  const trimmed = text.trim()
  const full = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec(trimmed)
  if (full) {
    return buildCstIso(
      Number(full[1]),
      Number(full[2]),
      Number(full[3]),
      Number(full[4]),
      Number(full[5])
    )
  }
  const short = /^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/.exec(trimmed)
  if (!short) return null
  const month = Number(short[1])
  const day = Number(short[2])
  const hour = Number(short[3])
  const minute = Number(short[4])
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null
  let best: { iso: string; distance: number } | null = null
  for (const year of [now.getUTCFullYear() - 1, now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
    const iso = buildCstIso(year, month, day, hour, minute)
    const time = Date.parse(iso)
    if (!Number.isFinite(time)) continue
    const distance = Math.abs(time - now.getTime())
    if (!best || distance < best.distance) best = { iso, distance }
  }
  return best?.iso ?? null
}

export function classifyHomeworkStatus(raw: string): PlatformStatusKind {
  const text = raw.replace(/\s+/g, '')
  if (!text) return 'unknown'
  // 批阅状态优先于“已提交/已完成”：待批阅说明平台已收到提交但教师未批阅。
  if (/(待批阅|待评阅|待评分|待审核|审核中|待复核|复核中)/.test(text)) return 'pending_review'
  if (/(已批阅|已评阅|已评分)/.test(text)) return 'reviewed'
  if (/(已完成|已通过)/.test(text)) return 'done'
  if (/(已提交|已交|已上交)/.test(text)) return 'submitted'
  if (/(未提交|未交|待提交|待完成|进行中|未开始|未完成|待做|待学习)/.test(text)) {
    return 'not_submitted'
  }
  // “已发布”只说明作业已发布，不代表学生已完成；保持未知，避免把未做的作业标成完成。
  return 'unknown'
}

export interface ChaoxingNoticeRecord {
  externalId: string
  title: string
  body: string
  category: 'course' | 'system' | 'notice'
  sender: string | null
  courseName: string | null
  publishedAt: string
  read: boolean | null
  url: string | null
}

export function parseNoticeList(raw: string): ChaoxingNoticeRecord[] {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return []
  }
  const notices = (payload as { notices?: { list?: unknown[] } }).notices
  const list = Array.isArray(notices?.list) ? notices.list : []
  const result: ChaoxingNoticeRecord[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const title = typeof record.title === 'string' ? record.title.trim() : ''
    if (!title) continue
    const rawUuid = typeof record.uuid === 'string' ? record.uuid : ''
    const externalId =
      rawUuid || `notice:${hashString(`${title}|${String(record.sendTime ?? '')}`)}`
    const receivers = Array.isArray(record.receiverArray)
      ? (record.receiverArray as Array<Record<string, unknown>>)
      : []
    const publishedAt =
      typeof record.sendTime === 'string'
        ? (toIsoDateTime(record.sendTime) ?? new Date().toISOString())
        : typeof record.insertTime === 'number'
          ? new Date(record.insertTime).toISOString()
          : new Date().toISOString()
    let url: string | null = null
    if (typeof record.attachment === 'string' && record.attachment) {
      try {
        const attachments = JSON.parse(record.attachment) as Array<{
          att_web?: { url?: string }
        }>
        const candidate = attachments[0]?.att_web?.url
        if (typeof candidate === 'string' && /^https:\/\//.test(candidate)) url = candidate
      } catch {
        // Attachment payload is optional.
      }
    }
    const bodySource =
      typeof record.content === 'string' && record.content.trim()
        ? record.content
        : typeof record.rtf_content === 'string'
          ? stripTags(record.rtf_content)
          : ''
    const decodedRawBody = decodeEntities(bodySource)
    const body = decodedRawBody.replace(/\s+/g, ' ').trim().slice(0, 500)
    const sender = typeof record.createrName === 'string' ? record.createrName.trim() || null : null
    const explicitCourseName =
      typeof record.courseName === 'string'
        ? record.courseName
        : typeof record.coursename === 'string'
          ? record.coursename
          : null
    const courseName = resolveNoticeCourseName({
      title,
      body,
      rawBody: decodedRawBody,
      sender,
      explicitCourseName,
      receivers
    })
    result.push({
      externalId,
      title,
      body,
      category: courseName ? 'course' : 'notice',
      sender,
      courseName,
      publishedAt,
      read:
        typeof record.isread === 'number'
          ? record.isread === 1
          : typeof record.isread === 'string'
            ? record.isread === '1'
            : null,
      url
    })
  }
  return result
}

export interface ChaoxingExamRecord {
  externalId: string
  title: string
  courseName: string | null
  startAt: string | null
  endAt: string | null
  durationMinutes: number | null
  examStatus: string
  answerStatus: string
  score: string | null
  mode: string | null
  sourceUrl: string | null
}

/**
 * 解析学习通“考试列表”表格。
 *
 * 列序与平台一致：编号 / 名称 / 时间 / 时长 / 考试状态 / 作答状态 / 分数 / 方式 / 操作。
 * 页面改版或空列表时返回空数组，不抛错；单行解析失败只跳过该行。
 */
export interface ChaoxingMaterialRecord {
  externalId: string
  name: string
  kind: 'folder' | 'file' | 'link'
  fileType: string | null
  size: string | null
  url: string | null
  sourceUrl: string | null
}

/**
 * 解析课程“资料”页的文件行。
 *
 * 每个条目是一个 ul.dataBody_td，属性给出 type/id/dataname：
 * - afolder 文件夹；url 外链；其余为文件（doc/docx/pdf/py…）。
 * 页面只返回当前层级，子文件夹内容需要再次进入；本函数不做递归请求。
 */
export function parseMaterialList(html: string): ChaoxingMaterialRecord[] {
  const records: ChaoxingMaterialRecord[] = []
  const seen = new Set<string>()
  const rowPattern = /<ul\b[^>]*class="[^"]*dataBody_td[^"]*"[^>]*>([\s\S]*?)<\/ul>/gi
  for (const match of html.matchAll(rowPattern)) {
    const openTag = match[0].slice(0, match[0].indexOf('>') + 1)
    const type = readAttribute(openTag, 'type') ?? 'file'
    if (type === 'tch-courseware') continue
    const id = readAttribute(openTag, 'id')
    const body = match[1] ?? ''
    const dataId = body.match(/toOpen\(\s*'[^']*'\s*,\s*'[^']*'\s*,\s*(\d+)/i)?.[1] ?? null
    const name =
      safeDecode(readAttribute(openTag, 'dataname') ?? '') ||
      decodeEntities(readAttribute(body, 'title') ?? '') ||
      decodeEntities(stripTags(body)).trim()
    if (!name) continue
    const onclickMatch = body.match(/toOpen\(([\s\S]*?)\)/i)
    const args = onclickMatch ? splitQuotedArgs(onclickMatch[1] ?? '') : []
    const remoteUrl = args.find((arg) => /^https?:\/\//i.test(arg)) ?? null
    // 同名文件很常见。缺少 dataId/id 时优先用稳定链接区分，避免把
    // 两个不同资料折叠成同一个 externalId 后静默覆盖。
    const externalId = dataId
      ? `material:${dataId}`
      : id
        ? `material:${id}`
        : remoteUrl
          ? `material:url:${hashString(remoteUrl)}`
          : `material:name:${hashString(name)}`
    if (seen.has(externalId)) continue
    seen.add(externalId)
    const kind: ChaoxingMaterialRecord['kind'] =
      type === 'afolder' ? 'folder' : type === 'url' ? 'link' : 'file'
    const fileType =
      type === 'afolder' || type === 'url'
        ? type
        : (name.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() ?? type)
    const sizeMatch = body.match(/dataBody_size_stu[^>]*>([\s\S]*?)<\/(?:li|div)>/i)
    records.push({
      externalId,
      name,
      kind,
      fileType,
      size: sizeMatch ? decodeEntities(stripTags(sizeMatch[1] ?? '')).trim() || null : null,
      url: kind === 'link' ? remoteUrl : null,
      sourceUrl: remoteUrl
    })
  }
  return records
}

function readAttribute(html: string, name: string): string | null {
  const match = html.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'))
  return match ? decodeEntities(match[1] ?? '') : null
}

function splitQuotedArgs(value: string): string[] {
  const args: string[] = []
  const re = /'([^']*)'/g
  for (const match of value.matchAll(re)) {
    args.push(safeDecode(match[1] ?? ''))
  }
  return args
}

export interface ChaoxingChapterResource {
  name: string
  size: string | null
  type: string | null
  url: string | null
  objectId: string | null
}

export interface ChaoxingChapterSection {
  number: string
  title: string
  completed: boolean
  pendingCount: number
  locked: boolean
  chapterId: string | null
  resources: ChaoxingChapterResource[]
}

export interface ChaoxingChapter {
  number: string
  title: string
  sections: ChaoxingChapterSection[]
}

export interface ChaoxingChapterList {
  chapters: ChaoxingChapter[]
  done: number
  /**
   * 平台明确显示的任务点总数。
   * null 表示页面没有返回“已完成任务点”标记，不能解释为真实 0。
   */
  total: number | null
  sourceUrl: string | null
  enc: string | null
}

/**
 * 解析课程章节页。平台结构：
 * - 一级章：div.catalog_num + div.catalog_name.newCatalog_name > a > span[title]
 * - 二级节：div.chapter_item[title]，内部 span.catalog_sbar 为节序号，
 *   icon_yiwanc 表示已完成，span.catalog_points_yi 为待完成任务点数。
 * 单章/单节解析失败只跳过该节点，不影响整门课。
 */
export function parseChapterList(html: string): ChaoxingChapterList {
  const chapterMatches = [
    ...html.matchAll(
      /<div class="catalog_num fl"><span><i><em[^>]*>(\d+)<\/em><\/i><\/span><\/div>\s*<div class="catalog_name newCatalog_name"[^>]*>\s*<a class="clicktitle">\s*<span title="([^"]*)"/g
    )
  ]
  const chapters: ChaoxingChapter[] = chapterMatches.map((match) => ({
    number: match[1] ?? '',
    title: decodeEntities(match[2] ?? '').trim(),
    sections: []
  }))
  const sectionMatches = [...html.matchAll(/<div class="chapter_item"[^>]*title="([^"]*)"/g)]
  for (const match of sectionMatches) {
    const position = match.index ?? 0
    const segment = html.slice(position, position + 2600)
    const end = segment.indexOf('</li>')
    const block = end > 0 ? segment.slice(0, end) : segment
    const number = /<span class="catalog_sbar">([\d.]+)<\/span>/.exec(block)?.[1]
    if (!number) continue
    const pending = /<span class="catalog_points_yi">(\d+)<\/span>/.exec(block)?.[1]
    let chapterIndex = -1
    for (let index = 0; index < chapterMatches.length; index += 1) {
      if ((chapterMatches[index]?.index ?? 0) < position) chapterIndex = index
    }
    if (chapterIndex < 0) continue
    const chapter = chapters[chapterIndex]
    if (!chapter) continue
    const chapterId = /toOld\('(\d+)',\s*'(\d+)',\s*'(\d+)',\s*0\)/.exec(block)?.[2] ?? null
    chapter.sections.push({
      number,
      title: decodeEntities(match[1] ?? '').trim(),
      completed: block.includes('icon_yiwanc'),
      pendingCount: pending ? Number.parseInt(pending, 10) : 0,
      locked: block.includes('暂未开放'),
      chapterId,
      resources: []
    })
  }
  const progressMatch = /已完成任务点:\s*<span[^>]*>(\d+)<\/span>\s*\/\s*(\d+)/.exec(html)
  // 缺少“已完成任务点”标记时是“未知”，不是平台明确返回的 0。
  const done = progressMatch ? Number.parseInt(progressMatch[1] ?? '0', 10) : 0
  const total = progressMatch ? Number.parseInt(progressMatch[2] ?? '0', 10) : null
  const sourceUrlMatch = /data-studynext-chapter-url="([^"]*)"/.exec(html)
  const sourceUrl = sourceUrlMatch
    ? safeDecode(decodeEntities(sourceUrlMatch[1] ?? '')) || null
    : null
  const encMatch = /var\s+enc\s*=\s*["']([^"']+)["']/.exec(html)
  const enc = encMatch?.[1] ?? null
  return { chapters, done, total, sourceUrl, enc }
}

/**
 * 从 knowledge/cards 页面脚本中的 mArg.attachments 提取附件元数据。
 * 这些附件位于章节点内容里，不在课程“资料”标签页的列表中。
 */
export function parseKnowledgeCardResources(html: string): ChaoxingChapterResource[] {
  const decoded = decodeEntities(html)
  const marker = 'attachments":'
  const markerIndex = decoded.indexOf(marker)
  if (markerIndex < 0) return []
  const start = decoded.indexOf('[', markerIndex + marker.length)
  if (start < 0) return []
  let depth = 0
  let end = -1
  for (let index = start; index < decoded.length; index += 1) {
    const char = decoded[index]
    if (char === '[') depth += 1
    else if (char === ']') {
      depth -= 1
      if (depth === 0) {
        end = index + 1
        break
      }
    }
  }
  if (end < 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded.slice(start, end))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const resources: ChaoxingChapterResource[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const property = record.property
    if (!property || typeof property !== 'object') continue
    const detail = property as Record<string, unknown>
    const name =
      typeof detail.name === 'string'
        ? detail.name
        : typeof detail.title === 'string'
          ? detail.title
          : ''
    if (!name.trim()) continue
    const url =
      typeof detail.src === 'string' && /^https?:\/\//i.test(detail.src) ? detail.src : null
    const objectId = typeof detail.objectid === 'string' ? detail.objectid : null
    const key = `${objectId ?? ''}|${name}`
    if (seen.has(key)) continue
    seen.add(key)
    resources.push({
      name: name.trim(),
      size: typeof detail.hsize === 'string' ? detail.hsize : null,
      type: typeof detail.type === 'string' ? detail.type : null,
      url,
      objectId
    })
  }
  return resources
}

export function parseExamList(html: string): ChaoxingExamRecord[] {
  if (html.includes('暂无符合条件的考试')) return []
  const exams: ChaoxingExamRecord[] = []
  const seen = new Set<string>()
  const rowPattern = /<tr[^>]*class="[^"]*dataTr[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi
  let match: RegExpExecArray | null
  while ((match = rowPattern.exec(html)) !== null) {
    const row = match[1] ?? ''
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) =>
      normalizeText(stripTags(cell[1] ?? ''))
    )
    if (cells.length < 8 || !cells[1]) continue
    const title = cells[1]
    const timeText = cells[2] ?? ''
    const start = parseExamDate(timeText)
    if (!start) continue
    const endMatch = /至\s*(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/.exec(timeText)
    const end = endMatch ? toIsoDateTime(`${endMatch[1] ?? ''} ${endMatch[2] ?? ''}`) : null
    const href = matchFirst(row, /href="([^"]+)"/i)
    const sourceUrl = href ? absoluteExamUrl(decodeEntities(href)) : null
    const externalId =
      (sourceUrl ? readExamId(sourceUrl) : null) ?? `exam:${hashString(`${title}|${start}`)}`
    if (seen.has(externalId)) continue
    seen.add(externalId)
    const duration = Number.parseInt(cells[3] ?? '', 10)
    exams.push({
      externalId,
      title,
      courseName: null,
      startAt: start,
      endAt: end,
      durationMinutes: Number.isFinite(duration) ? duration : null,
      examStatus: cells[4] ?? '',
      answerStatus: cells[5] ?? '',
      score: normalizeExamScore(cells[6]),
      mode: cells[7] || null,
      sourceUrl
    })
  }
  return exams
}

function parseExamDate(text: string): string | null {
  const match = /(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/.exec(text)
  return match ? toIsoDateTime(`${match[1] ?? ''} ${match[2] ?? ''}`) : null
}

function toIsoDateTime(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
  if (!match) return null
  const hour = (match[2] ?? '0').padStart(2, '0')
  const second = (match[4] ?? '00').padStart(2, '0')
  const date = new Date(`${match[1]}T${hour}:${match[3]}:${second}+08:00`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function absoluteExamUrl(href: string): string | null {
  if (!href || href.startsWith('javascript:') || href.startsWith('#')) return null
  try {
    return new URL(href, 'https://mooc1-api.chaoxing.com').toString()
  } catch {
    return null
  }
}

function readExamId(url: string): string | null {
  const params = readQueryParams(url)
  return params.get('examid') ?? params.get('exam_id') ?? params.get('testid') ?? null
}

function hashString(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16)
}

export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function buildCstIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return new Date(
    `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+08:00`
  ).toISOString()
}

function absoluteHomeworkUrl(raw: string): string {
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw
  if (raw.startsWith('//')) return `https:${raw}`
  if (raw.startsWith('/')) return `https://mooc1.chaoxing.com${raw}`
  return `https://mooc1.chaoxing.com/${raw}`
}

function readHomeworkId(url: string): string | null {
  const params = readQueryParams(url)
  return params.get('workid') ?? params.get('answerid') ?? params.get('id') ?? null
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function readQueryParams(rawUrl: string): Map<string, string> {
  const result = new Map<string, string>()
  const queryIndex = rawUrl.indexOf('?')
  if (queryIndex === -1) return result
  const query = rawUrl.slice(queryIndex + 1).split('#')[0] ?? ''
  for (const pair of query.split('&')) {
    const [rawKey, rawValue] = pair.split('=')
    if (!rawKey) continue
    const key = decodeURIComponent(rawKey).toLowerCase()
    result.set(key, decodeURIComponent(rawValue ?? ''))
  }
  return result
}

function blockAround(html: string, index: number): string {
  const courseStart = html.lastIndexOf('<div class="course ', index)
  if (courseStart !== -1 && index - courseStart < 8000) {
    return html.slice(courseStart, index + 3200)
  }
  const start = html.lastIndexOf('<li', index)
  const end = html.indexOf('</li>', index)
  if (start !== -1 && end !== -1 && end - start < 8000) {
    return html.slice(start, end + 5)
  }
  return html.slice(Math.max(0, index - 3000), index + 3000)
}

function matchFirst(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text)
  return match?.[1] ?? null
}

function normalizeText(value: string | null | undefined): string | null {
  if (!value) return null
  const normalized = decodeEntities(value).replace(/\s+/g, ' ').trim()
  return normalized.length > 0 ? normalized : null
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    )
}
