import type { PortalLoginState } from '@shared/types'
import { isAllowedPortalUrl, isPortalLoginUrl } from '@shared/portal-url'

export interface PortalNavigationResolution {
  url: string
  loginState: PortalLoginState
  isLoginPage: boolean
}

/**
 * Resolve a navigation event into Portal URL/login state.
 *
 * Electron emits `did-navigate-in-page` for both the main frame and subframes.
 * Subframe navigation must not overwrite the Portal's top-level URL or login
 * state, so this resolver returns null for every non-main-frame event.
 */
export function resolvePortalNavigation(
  currentLoginState: PortalLoginState,
  url: string,
  isMainFrame: boolean
): PortalNavigationResolution | null {
  if (!isMainFrame) return null

  const parsed = new URL(url)
  const hostname = parsed.hostname.toLocaleLowerCase()
  const path = parsed.pathname.toLocaleLowerCase()
  // Reuse the shared login classifier so campus SSO and official login
  // redirects keep their existing semantics.
  const isLoginPage = isPortalLoginUrl(url) || !isAllowedPortalUrl(url)
  const loginState: PortalLoginState = isLoginPage
    ? 'logged_out'
    : (hostname === 'i.chaoxing.com' && (path.startsWith('/base') || path.startsWith('/visit'))) ||
        (currentLoginState === 'logged_out' && isAllowedPortalUrl(url))
      ? 'logged_in'
      : currentLoginState

  return { url, loginState, isLoginPage }
}
