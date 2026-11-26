import { existsSync, unlinkSync } from 'node:fs'
import type { PortalDownload } from '@shared/types'

export interface DownloadRecoveryStore {
  readonly readOnly: boolean
  listDownloads(): PortalDownload[]
  upsertDownload(item: PortalDownload): void
}

/**
 * Reconcile downloads left behind by a previous process.
 *
 * A read-only historical workspace is an archive: unfinished downloads are
 * shown as interrupted in memory, but their files and database records are
 * never changed. Writable workspaces may clean up unfinished partial files and
 * persist the interrupted state as before.
 */
export function recoverDownloads(
  store: DownloadRecoveryStore,
  now = new Date().toISOString()
): Map<string, PortalDownload> {
  const downloads = new Map<string, PortalDownload>()
  for (const item of store.listDownloads()) {
    const stale = item.state === 'progressing'
    if (stale && !store.readOnly && item.savePath && existsSync(item.savePath)) {
      try {
        unlinkSync(item.savePath)
      } catch {
        // Best-effort cleanup of an unfinished file; the record still becomes
        // interrupted so the UI does not claim a completed download.
      }
    }
    const record: PortalDownload = stale
      ? { ...item, state: 'interrupted', completedAt: now }
      : item
    downloads.set(record.id, record)
    if (stale && !store.readOnly) store.upsertDownload(record)
  }
  return downloads
}
