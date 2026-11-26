const COURSE_FIELD_BOUNDARY =
  /\s+(?:作业名称|作业标题|测验名称|考试名称|章节名称|章节测验督促通知|任务名称|活动名称|讨论名称|问卷名称|签到名称|班级名称|截止时间|开始时间|结束时间|发布时间|提交时间|通知内容|你的作业|你的考试|你的测验|你还有|请尽快|请及时)(?:\s*[:：]|$|\s)/

const AUTOMATED_REMINDER_TITLE = /(?:提醒|督促通知)$/

const CLASS_OR_COURSE_MARKER =
  /(?:[\d\-_()（）《》]|班|级|系|学院|专业|课程|导论|基础|概论|原理|实验|设计|工程|系统|法治|思想|道德|数学|英语|物理|化学|体育|算法|结构|网络|历史|政治|经济|管理)/

export interface NoticeReceiverCandidate {
  name?: unknown
  type?: unknown
  receiverType?: unknown
  clazzId?: unknown
  clazzid?: unknown
  courseId?: unknown
  courseid?: unknown
}

function cleanCourseName(value: string | null | undefined): string | null {
  if (!value) return null
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  return normalized.length <= 120 ? normalized : normalized.slice(0, 120).trim()
}

function matchKnownCoursePrefix(text: string, knownCourseNames: readonly string[]): string | null {
  const trimmed = text.trim()
  if (!trimmed || knownCourseNames.length === 0) return null
  const sorted = [...knownCourseNames]
    .map((name) => name.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  for (const courseName of sorted) {
    if (!trimmed.startsWith(courseName)) continue
    const rest = trimmed.slice(courseName.length)
    if (!rest || /^[\s:：\-_()（）,，。;；]/.test(rest)) {
      return courseName
    }
  }
  return null
}

function trimCourseSegment(segment: string, knownCourseNames: readonly string[]): string | null {
  const trimmed = segment.trim()
  if (!trimmed) return null
  const knownMatch = matchKnownCoursePrefix(trimmed, knownCourseNames)
  if (knownMatch) return knownMatch
  const boundary = COURSE_FIELD_BOUNDARY.exec(trimmed)
  const cut = boundary ? trimmed.slice(0, boundary.index) : trimmed
  return cleanCourseName(cut)
}

/**
 * 从通知正文或标题中提取明确的课程名称，例如：
 * - `课程名称: 计算机科学与技术专业导论 作业名称: 作业3 ...`
 * - `课程名称：思想道德与法治\r章节测验督促通知: ...`
 * - `作业:《程序设计基础》实验4`
 */
export function extractNoticeCourseName(input: {
  title: string
  body: string
  rawBody?: string | null
  knownCourseNames?: readonly string[]
}): string | null {
  const known = input.knownCourseNames ?? []
  const sources = [input.rawBody, input.body].filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0
  )
  for (const source of sources) {
    const lineMatch = /(?:^|[\r\n])\s*(?:课程名称|所属课程)\s*[:：]\s*([^\r\n]+)/.exec(source)
    if (lineMatch?.[1]) {
      const extracted = trimCourseSegment(lineMatch[1], known)
      if (extracted) return extracted
    }
    const inlineMatch = /(?:课程名称|所属课程)\s*[:：]\s*(.+)/.exec(source)
    if (inlineMatch?.[1]) {
      const extracted = trimCourseSegment(inlineMatch[1], known)
      if (extracted) return extracted
    }
  }

  const titleMatch =
    /^(?:作业|考试|测验|通知|签到|讨论|问卷|任务)\s*[:：]\s*《([^》]{1,80})》/.exec(
      input.title.trim()
    )
  if (titleMatch?.[1]) {
    const extracted = cleanCourseName(titleMatch[1])
    if (extracted) return extracted
  }

  return null
}

function isExplicitPersonReceiver(item: NoticeReceiverCandidate): boolean {
  const rawType = item.receiverType ?? item.type
  if (typeof rawType === 'string') {
    const normalized = rawType.trim().toLowerCase()
    if (normalized === 'user' || normalized === 'student' || normalized === 'person') {
      return true
    }
  }
  return false
}

function isExplicitGroupReceiver(item: NoticeReceiverCandidate): boolean {
  if (item.clazzId || item.clazzid || item.courseId || item.courseid) return true
  const rawType = item.receiverType ?? item.type
  if (typeof rawType === 'string') {
    const normalized = rawType.trim().toLowerCase()
    if (
      normalized === 'course' ||
      normalized === 'clazz' ||
      normalized === 'class' ||
      normalized === 'group'
    ) {
      return true
    }
  }
  return false
}

export function looksLikeClassOrCourseName(name: string): boolean {
  return CLASS_OR_COURSE_MARKER.test(name.trim())
}

function isAutomatedStudyNotice(title: string, sender: string | null | undefined): boolean {
  const normalizedSender = sender?.trim() ?? ''
  if (normalizedSender === '学习通知' || normalizedSender === '系统通知') return true
  return AUTOMATED_REMINDER_TITLE.test(title.trim())
}

function matchKnownCourseFromCandidate(
  candidate: string,
  knownCourseNames: readonly string[]
): string | null {
  const normalized = candidate.trim()
  if (!normalized || knownCourseNames.length === 0) return null
  const sorted = [...knownCourseNames]
    .map((name) => name.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  for (const courseName of sorted) {
    if (normalized === courseName) return courseName
    if (
      normalized.startsWith(courseName) &&
      /^[\s\-_()（）:：]/.test(normalized.slice(courseName.length))
    ) {
      return courseName
    }
  }
  return null
}

/**
 * 从学习通通知的 `receiverArray` 中挑选可作为课程/班级名的候选项。
 * 学习通的个人提醒（如作业结束提醒、章节测验督促通知）会把被提醒的学生名单放进
 * `receiverArray`，不能把同学姓名当成课程名展示。
 */
export function pickCourseNameFromReceivers(input: {
  receivers: readonly NoticeReceiverCandidate[]
  title: string
  sender?: string | null
  knownCourseNames?: readonly string[]
}): string | null {
  const known = input.knownCourseNames ?? []
  const candidates = input.receivers
    .map((item) => ({
      item,
      name: typeof item.name === 'string' ? cleanCourseName(item.name) : null
    }))
    .filter((entry): entry is { item: NoticeReceiverCandidate; name: string } =>
      Boolean(entry.name)
    )

  if (candidates.length === 0) return null

  for (const { item, name } of candidates) {
    if (isExplicitPersonReceiver(item)) continue
    const knownMatch = matchKnownCourseFromCandidate(name, known)
    if (knownMatch) return knownMatch
  }

  const explicitGroup = candidates.find(
    ({ item }) => !isExplicitPersonReceiver(item) && isExplicitGroupReceiver(item)
  )
  if (explicitGroup) return explicitGroup.name

  const automated = isAutomatedStudyNotice(input.title, input.sender)
  if (candidates.length > 1 || automated) {
    const groupLike = candidates.find(
      ({ item, name }) => !isExplicitPersonReceiver(item) && looksLikeClassOrCourseName(name)
    )
    return groupLike?.name ?? null
  }

  const first = candidates[0]
  if (!first || isExplicitPersonReceiver(first.item)) return null
  return first.name
}

/**
 * 统一解析/修正一条通知的课程归属：
 * 1. 优先使用接口显式课程名或正文/标题中提取的真实课程名；
 * 2. 若仅来自旧库或 `receiverArray`，先尝试匹配已知课程名，并拦截系统提醒里的学生姓名。
 */
export function resolveNoticeCourseName(input: {
  title: string
  body: string
  rawBody?: string | null
  sender?: string | null
  explicitCourseName?: string | null
  currentCourseName?: string | null
  receivers?: readonly NoticeReceiverCandidate[]
  knownCourseNames?: readonly string[]
}): string | null {
  const known = input.knownCourseNames ?? []

  const explicit = cleanCourseName(input.explicitCourseName)
  if (explicit) {
    return matchKnownCourseFromCandidate(explicit, known) ?? explicit
  }

  const extracted = extractNoticeCourseName({
    title: input.title,
    body: input.body,
    rawBody: input.rawBody ?? null,
    knownCourseNames: known
  })
  if (extracted) {
    return matchKnownCourseFromCandidate(extracted, known) ?? extracted
  }

  if (input.receivers && input.receivers.length > 0) {
    const fromReceivers = pickCourseNameFromReceivers({
      receivers: input.receivers,
      title: input.title,
      sender: input.sender ?? null,
      knownCourseNames: known
    })
    if (fromReceivers) return fromReceivers
  }

  const current = cleanCourseName(input.currentCourseName)
  if (!current) return null

  const knownCurrent = matchKnownCourseFromCandidate(current, known)
  if (knownCurrent) return knownCurrent

  if (isAutomatedStudyNotice(input.title, input.sender) && !looksLikeClassOrCourseName(current)) {
    return null
  }

  return current
}
