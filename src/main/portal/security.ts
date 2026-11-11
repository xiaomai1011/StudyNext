import type { WebPreferences } from 'electron'
import { ALLOWED_PORTAL_HOSTS, PORTAL_PARTITION } from '@shared/constants'

export function isAllowedPortalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:') return false
    const hostname = url.hostname.toLocaleLowerCase()
    return ALLOWED_PORTAL_HOSTS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    )
  } catch {
    return false
  }
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
