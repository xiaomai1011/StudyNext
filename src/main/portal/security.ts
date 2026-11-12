import type { WebPreferences } from 'electron'
import { ALLOWED_PORTAL_HOSTS, PORTAL_PARTITION } from '@shared/constants'

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

export function isTrustedSsoUrl(rawUrl: string, trustedDomains: readonly string[]): boolean {
  if (trustedDomains.length === 0) return false
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:') return false
    if (url.username || url.password) return false
    if (url.port && url.port !== '443') return false
    const hostname = url.hostname.toLocaleLowerCase()
    return trustedDomains.some((rawDomain) => {
      const domain = rawDomain.trim().toLocaleLowerCase()
      if (!domain || domain.includes('*') || domain.includes('/')) return false
      return hostname === domain || hostname.endsWith(`.${domain}`)
    })
  } catch {
    return false
  }
}

export function isPortalNavigationAllowed(
  rawUrl: string,
  trustedSsoDomains: readonly string[]
): boolean {
  return isAllowedPortalUrl(rawUrl) || isTrustedSsoUrl(rawUrl, trustedSsoDomains)
}

export function safeDisplayUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    return `${url.origin}${url.pathname}`
  } catch {
    return ''
  }
}

export function buildPortalWebPreferences(): WebPreferences {
  return {
    partition: PORTAL_PARTITION,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    spellcheck: false,
    devTools: true
  }
}

export function buildPortalSecurityState() {
  const prefs = buildPortalWebPreferences()
  return {
    sandbox: prefs.sandbox === true,
    contextIsolation: prefs.contextIsolation === true,
    nodeIntegration: prefs.nodeIntegration === true,
    hasPreload: false,
    partition: PORTAL_PARTITION
  }
}
