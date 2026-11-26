import { ALLOWED_PORTAL_HOSTS } from './constants'

export function isAllowedPortalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:') return false
    if (url.username || url.password) return false
    const hostname = url.hostname.toLocaleLowerCase()
    return ALLOWED_PORTAL_HOSTS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    )
  } catch {
    return false
  }
}

/**
 * Some Chaoxing entry pages still redirect from https to http (for example
 * https://i.chaoxing.com/ -> http://i.chaoxing.com/base). The isolated view only
 * accepts HTTPS, so upgrade the same host/path instead of blocking the login
 * flow. Returns null when the URL is not a Chaoxing host or already HTTPS.
 */
export function upgradePortalHttpUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:') return null
    if (url.username || url.password) return null
    const hostname = url.hostname.toLocaleLowerCase()
    const allowed = ALLOWED_PORTAL_HOSTS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    )
    if (!allowed) return null
    url.protocol = 'https:'
    return url.toString()
  } catch {
    return null
  }
}

/**
 * Normalizes a task/course URL against the same strict Portal allowlist used by
 * PortalService.openUrl(): official HTTP Chaoxing/Xuexitong URLs are upgraded
 * to HTTPS, while any non-allowlisted or credentialed URL returns null.
 */
export function normalizePortalTargetUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null
  const trimmed = rawUrl.trim()
  if (!trimmed) return null
  const candidate = upgradePortalHttpUrl(trimmed) ?? trimmed
  return isAllowedPortalUrl(candidate) ? candidate : null
}

/**
 * Detects Chaoxing passport or campus SSO login redirect URLs.
 */
export function isPortalLoginUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl) return false
  const trimmed = rawUrl.trim()
  if (!trimmed) return false
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
    const hostname = parsed.hostname.toLocaleLowerCase()
    const path = parsed.pathname.toLocaleLowerCase()
    return (
      hostname.startsWith('passport') ||
      hostname.includes('login') ||
      /\/login|\/signin|\/cas\/|\/mlogin(\/|$|\.)/i.test(path)
    )
  } catch {
    return false
  }
}
