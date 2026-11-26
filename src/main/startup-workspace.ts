import { join } from 'node:path'
import type { ChaoxingCredentialStatus } from '@shared/types'
import { ChaoxingCredentialStore } from './integrations/chaoxing/credentials'
import { StudyNextStore } from './storage/store'
import { WorkspaceManager, type WorkspaceRecord } from './storage/workspaces'

export interface StartupWorkspaceContext {
  dataPath: string
  credentials: ChaoxingCredentialStore
  workspaces: WorkspaceManager
  workspace: WorkspaceRecord
  store: StudyNextStore
  credentialStatus: ChaoxingCredentialStatus
}

/**
 * Resolve the exact workspace the interactive app would open. Headless
 * reminder checks must not invent a second data-directory or database path.
 */
export async function openStartupWorkspace(dataPath: string): Promise<StartupWorkspaceContext> {
  const credentials = new ChaoxingCredentialStore(dataPath)
  const workspaces = new WorkspaceManager(dataPath)
  const credentialStatus = await credentials.status()
  const activeAccount = credentialStatus.activeAccountId
    ? credentialStatus.accounts.find((item) => item.id === credentialStatus.activeAccountId)
    : null
  const verifiedAccount = activeAccount?.platformUid
    ? {
        id: activeAccount.id,
        platformUid: activeAccount.platformUid,
        displayName: activeAccount.displayName,
        school: activeAccount.school
      }
    : null
  const workspace = workspaces.resolveStartupWorkspace(verifiedAccount, {
    legacyPath: join(dataPath, 'studynext.sqlite')
  })
  if (
    verifiedAccount &&
    workspace.status !== 'readonly' &&
    (workspace.accountId !== verifiedAccount.id ||
      workspace.platformUid !== verifiedAccount.platformUid)
  ) {
    throw new Error('当前账号身份与启动数据库不一致，已阻止加载可写数据库')
  }
  workspaces.clearPendingSwitch()
  const store = new StudyNextStore(workspace.filePath, {
    workspaceId: workspace.id,
    accountId: workspace.accountId,
    readOnly: workspace.status === 'readonly'
  })
  return { dataPath, credentials, workspaces, workspace, store, credentialStatus }
}
