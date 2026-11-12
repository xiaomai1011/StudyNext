import type { PlatformStatusKind } from '@shared/types'

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

const LOGIN_BODY_MARKERS = [
  'id="loginBtn"',
  'id="phone"',
  'name="pwd"',
  '用户登录',
  '新用户注册'
]

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
      matchFirst(tag, /\bsrc\s*=\s*["']([^"']+)["']/i) ??
      matchFirst(tag, /\bsrc\s*=\s*([^\s>]+)/i)
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
  const uid = matchFirst(html, /var uid\s*=\s*'?(\d+)'?/)
  const fid =
    matchFirst(html, /"fid"\s*:\s*"?(\d+)"?/) ?? matchFirst(html, /var fid\s*=\s*'(\d+)'/)
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
}

export function parseHomeworkDetail(html: string): ChaoxingHomeworkDetail {
  const text = stripTags(html)
  const result: ChaoxingHomeworkDetail = {
    title: null,
    questionCount: null,
    fullScore: null,
    startText: null,
    deadlineText: null,
    score: null,
    submittedAtText: null,
    teacherFeedback: null
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
  const fullScore = matchFirst(text, /满分[:：]\s*(\d+(?:\.\d+)?)/)
  if (fullScore) result.fullScore = Number(fullScore)
  const range = /(?:作答时间|考试时间|答题时间)[:：]\s*(\d{1,4}-?\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})\s*(?:至|到|-|—)\s*(\d{1,4}-?\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/.exec(
    text
  )
  if (range) {
    result.startText = range[1] ?? null
    result.deadlineText = range[2] ?? null
  } else {
    const single = /(?:截止时间|截止日期|结束时间)[:：]\s*(\d{1,4}-?\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})/.exec(
      text
    )
    if (single) result.deadlineText = single[1] ?? null
  }
  const score =
    matchFirst(text, /智能分析\s*(\d+(?:\.\d+)?)\s*分/) ??
    matchFirst(text, /(?:得分|总分|成绩|批阅)[:：]?\s*(\d+(?:\.\d+)?)\s*分?/)
  if (score) result.score = score
  const submitted =
    /(?:提交时间|提交日期|提交于|首次提交)[:：]?\s*(\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)/.exec(
      text
    )
  if (submitted) result.submittedAtText = submitted[1] ?? null
  const feedback =
    /(?:教师批语|教师评语|批语|评语)[:：]?\s*([\s\S]{1,800}?)(?=\s*(?:教师批语|教师评语|批语|评语|得分|成绩|满分|提交时间|我的答案|正确答案|作答记录)[:：]?|$)/.exec(
      text
    )
  if (feedback) {
    const value = normalizeText(feedback[1])?.split(/\s(?:一|二|三|四|五)[.、]/)[0]
    if (value) result.teacherFeedback = value.slice(0, 300)
  }
  return result
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
  if (/(已完成|已提交|已交|待批阅|已批阅|已评分|已通过)/.test(text)) return 'done'
  if (/(未提交|未交|待提交|待完成|进行中|未开始|未完成|待做|待学习)/.test(text)) return 'pending'
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
    const externalId = rawUuid || `notice:${hashString(`${title}|${String(record.sendTime ?? '')}`)}`
    const receivers = Array.isArray(record.receiverArray)
      ? (record.receiverArray as Array<Record<string, unknown>>)
      : []
    const courseName =
      receivers.length > 0 && typeof receivers[0]?.name === 'string'
        ? receivers[0].name
        : null
    const publishedAt =
      typeof record.sendTime === 'string'
        ? toIsoDateTime(record.sendTime) ?? new Date().toISOString()
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
    result.push({
      externalId,
      title,
      body: decodeEntities(bodySource).replace(/\s+/g, ' ').trim().slice(0, 500),
      category: courseName ? 'course' : 'notice',
      sender: typeof record.createrName === 'string' ? record.createrName : null,
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
    const externalId = dataId
      ? `material:${dataId}`
      : id
        ? `material:${id}`
        : `material:name:${hashString(name)}`
    if (seen.has(externalId)) continue
    seen.add(externalId)
    const onclickMatch = body.match(/toOpen\(([\s\S]*?)\)/i)
    const args = onclickMatch ? splitQuotedArgs(onclickMatch[1] ?? '') : []
    const remoteUrl = args.find((arg) => /^https?:\/\//i.test(arg)) ?? null
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

export interface ChaoxingChapterSection {
  number: string
  title: string
  completed: boolean
  pendingCount: number
  locked: boolean
}

export interface ChaoxingChapter {
  number: string
  title: string
  sections: ChaoxingChapterSection[]
}

export interface ChaoxingChapterList {
  chapters: ChaoxingChapter[]
  done: number
  total: number
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
    chapter.sections.push({
      number,
      title: decodeEntities(match[1] ?? '').trim(),
      completed: block.includes('icon_yiwanc'),
      pendingCount: pending ? Number.parseInt(pending, 10) : 0,
      locked: block.includes('暂未开放')
    })
  }
  const progressMatch = /已完成任务点:\s*<span[^>]*>(\d+)<\/span>\s*\/\s*(\d+)/.exec(html)
  const done = progressMatch ? Number.parseInt(progressMatch[1] ?? '0', 10) : 0
  const total = progressMatch ? Number.parseInt(progressMatch[2] ?? '0', 10) : 0
  return { chapters, done, total }
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
    const end = endMatch
      ? toIsoDateTime(`${endMatch[1] ?? ''} ${endMatch[2] ?? ''}`)
      : null
    const href = matchFirst(row, /href="([^"]+)"/i)
    const sourceUrl = href ? absoluteExamUrl(decodeEntities(href)) : null
    const externalId =
      (sourceUrl ? readExamId(sourceUrl) : null) ??
      `exam:${hashString(`${title}|${start}`)}`
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
      score: cells[6] || null,
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

function buildCstIso(year: number, month: number, day: number, hour: number, minute: number): string {
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
