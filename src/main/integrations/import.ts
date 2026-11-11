import { createHash } from 'node:crypto'
import { fromZonedTime } from 'date-fns-tz'
import type { ImportResult, TaskKind, TaskPriority } from '@shared/types'
import type { StudyNextStore } from '../storage/store'

interface ParsedImportTask {
  title: string
  description: string
  courseName: string | null
  priority: TaskPriority
  kind: TaskKind
  dueAt: Date
  reminderOffsets: number[]
  externalId: string
  line: number
}

interface ParseOutcome {
  tasks: ParsedImportTask[]
  warnings: string[]
  fatal?: string
}

export function parseCsvRows(content: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const text = content.replace(/^\uFEFF/, '')
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]
    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"'
        i += 1
      } else if (char === '"') {
        inQuotes = false
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') {
      field += char
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((item) => item.some((cell) => cell.trim().length > 0))
}

const HEADER_ALIASES: Record<string, string> = {
  标题: 'title',
  任务: 'title',
  任务名称: 'title',
  title: 'title',
  描述: 'description',
  说明: 'description',
  备注: 'description',
  description: 'description',
  课程: 'course',
  课程名称: 'course',
  所属课程: 'course',
  课程名: 'course',
  course: 'course',
  coursename: 'course',
  截止时间: 'due',
  截止: 'due',
  deadline: 'due',
  due: 'due',
  dueat: 'due',
  优先级: 'priority',
  priority: 'priority',
  类型: 'kind',
  kind: 'kind',
  提醒: 'reminders',
  提醒分钟: 'reminders',
  reminders: 'reminders',
  reminderoffsets: 'reminders'
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s_-]/g, '')
}

function parseDueDate(raw: string): Date | null {
  const value = raw.trim()
  if (!value) return null
  const dateOnly = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value)
  if (dateOnly) {
    const year = Number(dateOnly[1])
    const month = Number(dateOnly[2]) - 1
    const day = Number(dateOnly[3])
    const due = new Date(year, month, day, 23, 59, 0, 0)
    return Number.isFinite(due.getTime()) ? due : null
  }
  const local = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (local) {
    const due = new Date(
      Number(local[1]),
      Number(local[2]) - 1,
      Number(local[3]),
      Number(local[4]),
      Number(local[5]),
      Number(local[6] ?? 0),
      0
    )
    return Number.isFinite(due.getTime()) ? due : null
  }
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

function parsePriority(raw: string): TaskPriority {
  const value = raw.trim().toLocaleLowerCase()
  if (['high', '高', '高优先级', '紧急', '重要'].includes(value)) return 'high'
  if (['low', '低', '低优先级', '不急'].includes(value)) return 'low'
  return 'medium'
}

function parseKind(raw: string): TaskKind {
  const value = raw.trim().toLocaleLowerCase()
  if (['homework', '作业', '习题', '实验'].includes(value)) return 'homework'
  if (['exam', '考试', '测验', '测试'].includes(value)) return 'exam'
  if (['reading', '阅读', '文献'].includes(value)) return 'reading'
  if (['activity', '活动', '讨论', '汇报'].includes(value)) return 'activity'
  return 'other'
}

function parseReminderToken(token: string): number | null {
  const value = token.trim().toLocaleLowerCase()
  if (!value) return null
  const numeric = /^\d+$/.exec(value)
  if (numeric) return Number(value)
  const compact = /^(\d+)\s*(d|day|days|天|h|hour|hours|小时|m|min|minutes|分钟)$/.exec(value)
  if (compact) {
    const amount = Number(compact[1] ?? 0)
    const unit = compact[2] ?? ''
    if (['d', 'day', 'days', '天'].includes(unit)) return amount * 1440
    if (['h', 'hour', 'hours', '小时'].includes(unit)) return amount * 60
    return amount
  }
  const chinese = /^提前\s*(\d+)\s*(天|小时|分钟)$/.exec(value)
  if (chinese) {
    const amount = Number(chinese[1])
    if (chinese[2] === '天') return amount * 1440
    if (chinese[2] === '小时') return amount * 60
    return amount
  }
  return null
}

function parseReminderList(raw: string): number[] {
  if (!raw.trim()) return []
  return raw
    .split(/[;|,，；、]/)
    .map(parseReminderToken)
    .filter((value): value is number => value !== null && value >= 5 && value <= 43200)
}

function stableImportId(prefix: string, parts: string[]): string {
  return `${prefix}-${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24)}`
}

export function parseCsvTasks(
  content: string,
  defaultOffsets: number[],
  prefix = 'csv'
): ParseOutcome {
  const rows = parseCsvRows(content)
  if (rows.length < 2) return { tasks: [], warnings: [], fatal: 'CSV 至少需要表头和一行任务数据' }
  const headerRow = rows[0]
  if (!headerRow) return { tasks: [], warnings: [], fatal: 'CSV 缺少表头' }
  const headerMap = new Map<number, string>()
  headerRow.forEach((header, index) => {
    const key = HEADER_ALIASES[normalizeHeader(header)]
    if (key) headerMap.set(index, key)
  })
  if (![...headerMap.values()].includes('title') || ![...headerMap.values()].includes('due')) {
    return {
      tasks: [],
      warnings: [],
      fatal: 'CSV 表头必须包含“标题”和“截止时间”'
    }
  }
  const tasks: ParsedImportTask[] = []
  const warnings: string[] = []
  rows.slice(1).forEach((row, rowIndex) => {
    const line = rowIndex + 2
    const record: Record<string, string> = {}
    headerMap.forEach((key, index) => {
      record[key] = (row[index] ?? '').trim()
    })
    const title = record.title ?? ''
    if (!title) {
      warnings.push(`第 ${line} 行缺少标题，已跳过`)
      return
    }
    const due = parseDueDate(record.due ?? '')
    if (!due) {
      warnings.push(`第 ${line} 行截止时间无效，已跳过`)
      return
    }
    const reminders = parseReminderList(record.reminders ?? '')
    const courseName = (record.course ?? '').trim() || null
    tasks.push({
      title,
      description: record.description ?? '',
      courseName,
      priority: parsePriority(record.priority ?? ''),
      kind: parseKind(record.kind ?? ''),
      dueAt: due,
      reminderOffsets: reminders.length > 0 ? reminders : defaultOffsets,
      externalId: stableImportId(prefix, [title, due.toISOString(), courseName ?? '']),
      line
    })
  })
  return { tasks, warnings }
}

function unfoldIcs(content: string): string[] {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
}

function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\N/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

function parseIcsDate(rawValue: string, params: string): Date | null {
  const value = rawValue.trim()
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
  if (dateOnly) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 23, 59, 0, 0)
  }
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value)
  if (!dateTime) return null
  const [, year, month, day, hour, minute, second, utc] = dateTime
  if (utc === 'Z') {
    return new Date(
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
      )
    )
  }
  const tzidMatch = /TZID=([^;:]+)/i.exec(params)
  if (tzidMatch?.[1]) {
    try {
      const utcDate = fromZonedTime(
        `${year}-${month}-${day}T${hour}:${minute}:${second}`,
        tzidMatch[1]
      )
      if (Number.isFinite(utcDate.getTime())) return utcDate
    } catch {
      // Fall through to local time when the TZID is unknown to the runtime.
    }
  }
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  )
}

function inferKindFromText(text: string): TaskKind {
  if (/考试|测验|exam|quiz/i.test(text)) return 'exam'
  if (/作业|实验|homework|assignment/i.test(text)) return 'homework'
  if (/阅读|文献|reading/i.test(text)) return 'reading'
  if (/活动|讨论|汇报|activity/i.test(text)) return 'activity'
  return 'other'
}

export function parseIcsTasks(
  content: string,
  defaultOffsets: number[],
  prefix = 'ics'
): ParseOutcome {
  const lines = unfoldIcs(content)
  const events: Array<Record<string, { value: string; params: string }>> = []
  let current: Record<string, { value: string; params: string }> | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === 'BEGIN:VEVENT') {
      current = {}
      continue
    }
    if (trimmed === 'END:VEVENT') {
      if (current) events.push(current)
      current = null
      continue
    }
    if (!current) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const left = line.slice(0, colon)
    const value = line.slice(colon + 1)
    const [name, ...paramParts] = left.split(';')
    if (name) current[name.trim().toUpperCase()] = { value, params: paramParts.join(';') }
  }
  if (events.length === 0) {
    return { tasks: [], warnings: [], fatal: 'ICS 中未找到 VEVENT 事件' }
  }
  const tasks: ParsedImportTask[] = []
  const warnings: string[] = []
  events.forEach((event, index) => {
    const summary = unescapeIcsText(event.SUMMARY?.value?.trim() ?? '')
    if (!summary) {
      warnings.push(`第 ${index + 1} 个事件缺少 SUMMARY，已跳过`)
      return
    }
    const start = event.DTSTART
    if (!start) {
      warnings.push(`事件「${summary}」缺少 DTSTART，已跳过`)
      return
    }
    const due = parseIcsDate(start.value, start.params)
    if (!due || !Number.isFinite(due.getTime())) {
      warnings.push(`事件「${summary}」的开始时间无效，已跳过`)
      return
    }
    const description = unescapeIcsText(event.DESCRIPTION?.value?.trim() ?? '')
    const categories = unescapeIcsText(event.CATEGORIES?.value?.trim() ?? '')
    const courseName = categories.split(',')[0]?.trim() || null
    const uid = event.UID?.value?.trim() || `${summary}-${due.toISOString()}`
    tasks.push({
      title: summary,
      description,
      courseName,
      priority: 'medium',
      kind: inferKindFromText(`${summary} ${description}`),
      dueAt: due,
      reminderOffsets: defaultOffsets,
      externalId: stableImportId(prefix, [uid]),
      line: index + 1
    })
  })
  return { tasks, warnings }
}

export function importTasksFromFile(
  store: StudyNextStore,
  input: { fileName: string; content: string }
): ImportResult {
  const extension = input.fileName.split('.').pop()?.toLocaleLowerCase() ?? ''
  const settings = store.getSettings()
  const defaultOffsets = settings.defaultReminderOffsets
  const isIcs = extension === 'ics' || /BEGIN:VCALENDAR/i.test(input.content)
  const outcome = isIcs
    ? parseIcsTasks(input.content, defaultOffsets)
    : parseCsvTasks(input.content, defaultOffsets)
  if (outcome.fatal) {
    return {
      state: 'failure',
      importedCourses: 0,
      importedTasks: 0,
      skipped: 0,
      warnings: outcome.warnings,
      message: outcome.fatal
    }
  }
  let importedCourses = 0
  let importedTasks = 0
  let skipped = 0
  const warnings = [...outcome.warnings]
  const createdCourseNames = new Set<string>()
  for (const parsed of outcome.tasks) {
    const existing = store.findTaskByExternalId('import', parsed.externalId)
    if (existing) {
      skipped += 1
      continue
    }
    let courseId: string | null = null
    if (parsed.courseName) {
      const before = store.findCourseByName(parsed.courseName)
      const course = before ?? store.createImportedCourse(parsed.courseName)
      courseId = course.id
      if (!before && !createdCourseNames.has(course.id)) {
        createdCourseNames.add(course.id)
        importedCourses += 1
      }
    }
    try {
      const task = store.createTask(
        {
          title: parsed.title,
          description: parsed.description,
          courseId,
          priority: parsed.priority,
          kind: parsed.kind,
          dueAt: parsed.dueAt.toISOString(),
          reminderOffsets: parsed.reminderOffsets
        },
        { source: 'import', externalId: parsed.externalId }
      )
      if (task) importedTasks += 1
    } catch (error) {
      warnings.push(
        `导入「${parsed.title}」失败：${error instanceof Error ? error.message : '未知错误'}`
      )
      skipped += 1
    }
  }
  let state: ImportResult['state']
  if (importedTasks === 0 && skipped > 0) state = 'failure'
  else if (warnings.length > 0 || skipped > 0) state = 'partial'
  else state = 'success'
  return {
    state,
    importedCourses,
    importedTasks,
    skipped,
    warnings,
    message:
      state === 'failure'
        ? '没有导入任何任务，请检查文件格式'
        : `已导入 ${importedTasks} 个任务、${importedCourses} 门新课程${skipped > 0 ? `，跳过 ${skipped} 项` : ''}`
  }
}
