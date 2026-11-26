export const TASK_ACTIVATION_PROTOCOL = 'studynext'
export const TASK_ACTIVATION_HOST = 'task'

/**
 * Parse a task activation from a process argv or a protocol URL.
 *
 * Only the local task identifier is accepted. The renderer/main process must
 * still resolve the ID against the current workspace database; an activation
 * argument is never proof that the task exists or belongs to this account.
 */
export function parseTaskActivationArgument(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (typeof value !== 'string') continue
    if (value === '--focus-task') {
      const next = argv[index + 1]
      if (typeof next === 'string' && !next.startsWith('-')) return sanitizeTaskId(next)
      // Chromium can reorder app arguments when a second instance is launched:
      // `--focus-task <id>` may arrive as `--focus-task --flag ... <id>`. The
      // task ID is generated as a UUID, so recover only a UUID-shaped trailing
      // argument rather than trusting an arbitrary value.
      for (let candidateIndex = argv.length - 1; candidateIndex > index; candidateIndex -= 1) {
        const candidate = argv[candidateIndex]
        if (typeof candidate !== 'string' || candidate.startsWith('-')) continue
        if (isTaskId(candidate)) return candidate
      }
      return null
    }
    if (value.startsWith('--focus-task=')) {
      return sanitizeTaskId(value.slice('--focus-task='.length))
    }
  }
  for (const value of argv) {
    if (typeof value !== 'string') continue
    if (!value.startsWith(`${TASK_ACTIVATION_PROTOCOL}://`)) continue
    try {
      const url = new URL(value)
      if (url.host !== TASK_ACTIVATION_HOST) continue
      if (url.searchParams.get('id')) return sanitizeTaskId(url.searchParams.get('id'))
      const pathId = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      return sanitizeTaskId(pathId)
    } catch {
      // Malformed protocol URLs are ignored rather than becoming a crash path.
    }
  }
  return null
}

export function buildTaskActivationUri(taskId: string): string {
  return `${TASK_ACTIVATION_PROTOCOL}://${TASK_ACTIVATION_HOST}/${encodeURIComponent(taskId)}`
}

function sanitizeTaskId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 200) return null
  return trimmed
}

function isTaskId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Windows toast XML with protocol activation. The launch URI is the only
 * payload; it contains a local task ID and no cookies, tokens or URLs.
 */
export function buildReminderToastXml(input: {
  title: string
  body: string
  taskId: string
  iconPath?: string | null
}): string {
  const image = input.iconPath
    ? `<image placement="appLogoOverride" src="${escapeXml(input.iconPath)}"/>`
    : ''
  return [
    '<toast activationType="protocol" launch="' +
      escapeXml(buildTaskActivationUri(input.taskId)) +
      '">',
    '<visual><binding template="ToastGeneric">',
    `<text>${escapeXml(input.title)}</text>`,
    `<text>${escapeXml(input.body)}</text>`,
    image,
    '</binding></visual>',
    '<audio silent="true"/>',
    '</toast>'
  ].join('')
}
