import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { MaterialLocalFile, PortalDownload } from '@shared/types'
import type { StudyNextStore } from '../storage/store'

function normalizePathKey(filePath: string): string {
  const resolved = resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function readVerifiedLocalFileSize(savePath: string | null | undefined): number | null {
  if (!savePath) return null
  try {
    if (!existsSync(savePath)) return null
    const stats = statSync(savePath)
    return stats.isFile() ? stats.size : null
  } catch {
    return null
  }
}

/**
 * Persists a newly completed material download into the independent `material_local_files`
 * table after verifying that the material belongs to this workspace and the file exists on disk.
 */
export function recordCompletedMaterialLocalFile(
  store: StudyNextStore,
  download: PortalDownload
): MaterialLocalFile | null {
  if (store.readOnly) return null
  if (download.state !== 'completed' || !download.materialId || !download.savePath) return null
  const material = store.getMaterial(download.materialId)
  if (!material) return null
  const diskSize = readVerifiedLocalFileSize(download.savePath)
  if (diskSize === null) return null

  const record: MaterialLocalFile = {
    materialId: material.id,
    courseId: material.courseId,
    downloadId: download.id,
    filename: download.filename,
    savePath: download.savePath,
    fileSize: diskSize || download.receivedBytes,
    downloadedAt: download.completedAt ?? download.startedAt
  }
  store.upsertMaterialLocalFile(record)
  return record
}

/**
 * Resolves all disk-verified local material files for the current account workspace:
 * - Independent of download queue clearing and the 100-row queue cap.
 * - Verifies `statSync(savePath).isFile()` so manually deleted/moved files are never claimed as present.
 * - Automatically backfills confirmed legacy completed material downloads (unbounded query) into
 *   `material_local_files` in writable workspaces so existing users' files survive queue clearing.
 */
export function resolveVerifiedMaterialLocalFiles(
  store: StudyNextStore,
  defaultDownloadDir: string
): MaterialLocalFile[] {
  const materials = store.listMaterials()
  const materialById = new Map(materials.map((item) => [item.id, item]))
  const verified = new Map<string, MaterialLocalFile>()
  const staleMaterialIds = new Set<string>()

  // 1. Check independent persisted local-file records first
  for (const row of store.listMaterialLocalFiles()) {
    const material = materialById.get(row.materialId)
    if (!material || material.courseId !== row.courseId) {
      staleMaterialIds.add(row.materialId)
      continue
    }
    const diskSize = readVerifiedLocalFileSize(row.savePath)
    if (diskSize === null) {
      staleMaterialIds.add(row.materialId)
      continue
    }
    verified.set(row.materialId, {
      ...row,
      fileSize: diskSize || row.fileSize
    })
  }

  // 2. Backfill / recover from ALL historical completed material downloads (no 100-row limit)
  for (const dl of store.listCompletedMaterialDownloads()) {
    if (!dl.materialId || verified.has(dl.materialId)) continue
    const material = materialById.get(dl.materialId)
    if (!material) continue
    const candidatePath = dl.savePath ?? join(defaultDownloadDir, dl.filename)
    const diskSize = readVerifiedLocalFileSize(candidatePath)
    if (diskSize === null) continue
    const recovered: MaterialLocalFile = {
      materialId: material.id,
      courseId: material.courseId,
      downloadId: dl.id,
      filename: dl.filename,
      savePath: candidatePath,
      fileSize: diskSize || dl.receivedBytes,
      downloadedAt: dl.completedAt ?? dl.startedAt
    }
    verified.set(material.id, recovered)
    staleMaterialIds.delete(material.id)
    if (!store.readOnly) {
      store.upsertMaterialLocalFile(recovered)
    }
  }

  // 3. Prune stale rows whose files no longer exist on disk (writable workspaces only)
  if (!store.readOnly) {
    for (const staleId of staleMaterialIds) {
      store.deleteMaterialLocalFile(staleId)
    }
  }

  return [...verified.values()].sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt))
}

export function resolveVerifiedMaterialLocalFile(
  store: StudyNextStore,
  defaultDownloadDir: string,
  materialId: string
): MaterialLocalFile | null {
  const all = resolveVerifiedMaterialLocalFiles(store, defaultDownloadDir)
  return all.find((item) => item.materialId === materialId) ?? null
}

/**
 * Invalidates a persisted `material_local_files` entry ONLY when it actually points to the
 * missing `download.id` or `missingPath`. If the material already has a valid newer copy
 * indexed at a different path/downloadId, that valid index is preserved untouched.
 * Returns true if the verified local-files set changed (caller should emit an update event).
 */
export function invalidateMissingDownloadLocalFile(
  store: StudyNextStore,
  defaultDownloadDir: string,
  download: Pick<PortalDownload, 'id' | 'materialId'>,
  missingPath: string
): boolean {
  if (store.readOnly || !download.materialId) return false
  const existing = store
    .listMaterialLocalFiles()
    .find((row) => row.materialId === download.materialId)
  if (!existing) return false

  const matchesDownloadId = existing.downloadId !== null && existing.downloadId === download.id
  const matchesPath =
    Boolean(missingPath) && normalizePathKey(existing.savePath) === normalizePathKey(missingPath)

  // Current index points to a different copy (e.g. newer re-download): keep it if still on disk!
  if (!matchesDownloadId && !matchesPath && readVerifiedLocalFileSize(existing.savePath) !== null) {
    return false
  }

  store.deleteMaterialLocalFile(download.materialId)
  // Re-resolve so another surviving completed copy (if any) can cleanly take over.
  resolveVerifiedMaterialLocalFiles(store, defaultDownloadDir)
  return true
}
