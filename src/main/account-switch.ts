import type { ChaoxingCredentialStatus } from '@shared/types'
import type { ChaoxingCredentialStore } from './integrations/chaoxing/credentials'
import type { ChaoxingSessionService } from './integrations/chaoxing/service'
import type { PortalService } from './portal/service'
import type { WorkspaceManager } from './storage/workspaces'

/**
 * Minimal switch ports keep the lifecycle testable without importing Electron.
 * The production main process supplies the real portal, credential store,
 * workspace manager and sync service.
 */
export interface AccountSwitchPorts {
  credentials: Pick<ChaoxingCredentialStore, 'status' | 'setActive'>
  workspaces: Pick<WorkspaceManager, 'beginAccountSwitch' | 'setActive'>
  portal: Pick<PortalService, 'canSwitchAccount' | 'suspendWritesForAccountSwitch' | 'clearSession'>
  chaoxing: Pick<ChaoxingSessionService, 'resetForAccountSwitch'>
  stopScheduler: () => void
  requestRelaunch: () => void
}

/**
 * The single production account-switch entry point.
 *
 * The invalidation is deliberately synchronous and happens before the first
 * await: once this function has started a switch, an in-flight pull/retry can
 * never publish its result into the old store or emit a stale outcome.
 */
export async function performAccountSwitch(
  ports: AccountSwitchPorts,
  accountId: string
): Promise<ChaoxingCredentialStatus> {
  const before = await ports.credentials.status()
  const account = before.accounts.find((item) => item.id === accountId)
  if (!account) throw new Error('找不到要切换的学习通账号')
  if (!account.platformUid) {
    throw new Error('目标账号尚未完成平台身份校验，无法安全切换；请先登录一次完成校验')
  }
  const safety = ports.portal.canSwitchAccount()
  if (!safety.ok) throw new Error(safety.reason ?? '当前页面不适宜切换账号')

  ports.chaoxing.resetForAccountSwitch()
  ports.stopScheduler()
  ports.portal.suspendWritesForAccountSwitch()
  await ports.portal.clearSession()

  const workspace = ports.workspaces.beginAccountSwitch({
    id: account.id,
    platformUid: account.platformUid,
    displayName: account.displayName,
    school: account.school
  })
  ports.workspaces.setActive(workspace.id)
  await ports.credentials.setActive(account.id)
  ports.requestRelaunch()
  return ports.credentials.status()
}
