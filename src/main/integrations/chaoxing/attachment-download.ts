import type { Task } from '../../../shared/types'
import { UserFacingError } from '../../lib/errors'

const ATTACHMENT_PREVIEW_BASE = 'https://mooc1.chaoxing.com/mooc-ans/ueditorupload/read'
const OBJECT_ID_PATTERN = /^[a-f0-9]{16,64}$/i

function readAttribute(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)
  return match?.[2] ?? match?.[3] ?? null
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
}

/**
 * 作业附件在详情页只有 objectid。这里生成官方只读预览页地址，
 * 再从预览页的下载按钮解析平台签发的 CDN 链接。
 */
export function buildAttachmentPreviewUrl(objectId: string, fileName: string): string {
  if (!OBJECT_ID_PATTERN.test(objectId)) {
    throw new UserFacingError('ATTACHMENT_INVALID_ID', '附件标识无效，无法下载。')
  }
  const params = new URLSearchParams({
    objectId,
    fileOriName: fileName.slice(0, 300)
  })
  return `${ATTACHMENT_PREVIEW_BASE}?${params.toString()}`
}

/**
 * 只接受预览页中的 btnDown 链接，并且只允许 HTTPS 的 cldisk 下载域名。
 * 不解析任意 script / 任意 a 标签，也不接受调用方直接传入的 URL。
 */
export function parseAttachmentDownloadUrl(html: string): string {
  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const tag = match[0]
    if (!/\bclass\s*=\s*("[^"]*\bbtnDown\b[^"]*"|'[^']*\bbtnDown\b[^']*')/i.test(tag)) continue
    const rawHref = readAttribute(tag, 'href')
    if (!rawHref) continue
    let parsed: URL
    try {
      parsed = new URL(decodeHtmlAttribute(rawHref))
    } catch {
      continue
    }
    if (parsed.protocol !== 'https:') continue
    if (parsed.username || parsed.password || parsed.port) continue
    const host = parsed.hostname.toLowerCase()
    if (host !== 'cldisk.com' && !host.endsWith('.cldisk.com')) continue
    if (!parsed.pathname.startsWith('/download/')) continue
    if (!parsed.searchParams.get('at_') || !parsed.searchParams.get('ak_')) continue
    return parsed.toString()
  }
  throw new UserFacingError(
    'ATTACHMENT_DOWNLOAD_UNAVAILABLE',
    '平台没有返回可用的附件下载地址；请确认附件仍然存在，或稍后在官方页面重试。'
  )
}

export interface TaskAttachmentSource {
  taskId: string
  index: number
  objectId: string
  fileName: string
  referer: string
}

/**
 * 下载记录持久化 taskId + objectId，不持久化可能过期的 CDN 签名链接。
 * objectId 是附件稳定身份；index 只作为当前列表的辅助信息，不能用于历史重试。
 */
export function resolveTaskAttachmentSource(
  task: Task | null,
  objectId: string | null | undefined
): TaskAttachmentSource | null {
  if (!task || task.source !== 'chaoxing' || !objectId) return null
  const matches = task.attachments.filter((item) => item.objectId === objectId)
  if (matches.length !== 1) return null
  const attachment = matches[0]!
  const index = task.attachments.indexOf(attachment)
  return {
    taskId: task.id,
    index,
    objectId,
    fileName: attachment.name,
    referer: task.sourceUrl ?? 'https://mooc1.chaoxing.com/'
  }
}
