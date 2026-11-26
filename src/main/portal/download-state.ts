import type { PortalDownload } from '@shared/types'

/**
 * A user-triggered cancel can reach the transfer as an abort/error instead of
 * Electron's native `cancelled` state. Preserve that explicit intent while
 * keeping genuine network failures as interrupted downloads.
 */
export function resolveDownloadFinishState(
  state: PortalDownload['state'],
  cancelledByUser: boolean
): PortalDownload['state'] {
  return cancelledByUser && state === 'interrupted' ? 'cancelled' : state
}
