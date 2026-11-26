import type { BatchRetryResult, Course, Material, MaterialLocalFile, PortalDownload } from './types'
import { getCourseClassLabel } from './course-identity'
import { normalizePortalTargetUrl } from './portal-url'

export type MaterialKindFilter = 'all' | 'file' | 'folder' | 'link'
export type MaterialDownloadStatusFilter = 'all' | 'downloaded' | 'undownloaded'
export type DownloadQueueFilter = 'all' | 'progressing' | 'completed' | 'failed'

export interface MaterialGroup {
  key: string
  courseId: string
  name: string
  classLabel: string | null
  color: string
  items: Material[]
  rawCount: number
}

export type MaterialPreviewKind = 'inline' | 'external' | 'none'

export interface MaterialDownloadState {
  latest: PortalDownload | null
  completed: PortalDownload | null
  localFile: MaterialLocalFile | null
  active: PortalDownload | null
  isDownloading: boolean
  /** True ONLY when a verified on-disk local copy exists (or fallback completed record when localFiles is omitted). */
  hasCompleted: boolean
  canRetryLatest: boolean
}

export interface BatchDownloadPlan {
  toDownload: Material[]
  skippedCompleted: Material[]
  skippedInProgress: Material[]
  skippedUnsupported: Material[]
}

export interface CourseDownloadSummary {
  total: number
  active: number
  completed: number
  failed: number
  downloadedMaterialCount: number
  undownloadedMaterialCount: number
  downloadableMaterialCount: number
}

export interface DownloadOrigin {
  kind: 'material' | 'attachment' | 'other'
  label: string
  courseId: string | null
  materialId: string | null
  materialName: string | null
}

export type BatchObservedTerminalState = 'completed' | 'interrupted' | 'cancelled'

export interface BatchTrackedItem {
  downloadId: string
  materialId: string
  name: string
  /** Last observed terminal state, preserved even after the download queue is cleared. */
  terminalState?: BatchObservedTerminalState | undefined
}

export interface BatchDispatchFailure {
  materialId: string
  name: string
  error: string
}

export interface BatchTransferSummary {
  totalAttempted: number
  transferring: BatchTrackedItem[]
  succeeded: BatchTrackedItem[]
  transferFailed: BatchTrackedItem[]
  cancelled: BatchTrackedItem[]
  cleared: BatchTrackedItem[]
  dispatchFailed: BatchDispatchFailure[]
  allFailedMaterialIds: string[]
  retryableTransferFailed: BatchTrackedItem[]
  retryableDispatchFailed: BatchDispatchFailure[]
  retryableFailedMaterialIds: string[]
  isSettled: boolean
}

const INLINE_EXTENSIONS = new Set([
  'pdf',
  'txt',
  'md',
  'csv',
  'json',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp'
])

export function materialTarget(material: Material): string | null {
  const target = material.url ?? material.sourceUrl
  return target && /^https?:\/\//i.test(target) ? target : null
}

export function isPlatformMaterialFile(material: Pick<Material, 'kind' | 'externalId'>): boolean {
  return material.kind === 'file' && /^material:\d+$/.test(material.externalId)
}

/**
 * Matches backend material download capability without relaxing the Portal allowlist:
 * folders cannot be downloaded; platform files (`material:<digits>`) can always be
 * resolved via `coursedata/downloadData`; URL/link items require an allowlisted URL.
 */
export function canDownloadMaterial(
  material: Pick<Material, 'kind' | 'externalId' | 'url' | 'sourceUrl'>
): boolean {
  if (material.kind === 'folder') return false
  if (isPlatformMaterialFile(material)) return true
  const raw =
    material.kind === 'link'
      ? (material.url ?? material.sourceUrl)
      : (material.sourceUrl ?? material.url)
  return normalizePortalTargetUrl(raw) !== null
}

export function materialTypeLabel(material: Pick<Material, 'kind' | 'fileType' | 'name'>): string {
  if (material.kind === 'folder') return '文件夹'
  if (material.kind === 'link') return '网页链接'
  const raw = (material.fileType ?? '').trim().toLowerCase()
  if (raw && raw !== 'afolder' && raw !== 'url' && raw !== 'file') {
    return raw.replace(/^\./, '').toUpperCase()
  }
  const ext = material.name.match(/\.([a-z0-9]{1,8})$/i)?.[1]
  return ext ? ext.toUpperCase() : '文件'
}

export function materialFolderOpenUrl(
  material: Pick<Material, 'kind' | 'sourceUrl' | 'url'>,
  courseOfficialUrl: string | null
): string | null {
  if (material.kind !== 'folder') return null
  return (
    normalizePortalTargetUrl(material.sourceUrl) ??
    normalizePortalTargetUrl(material.url) ??
    normalizePortalTargetUrl(courseOfficialUrl)
  )
}

const MATERIAL_KIND_ORDER: Record<Material['kind'], number> = {
  folder: 0,
  file: 1,
  link: 2
}

/**
 * Lists materials for a single course: deduplicates only exact rows (preserving
 * same-name files with different IDs/URLs), applies kind/downloadStatus/search filters,
 * and surfaces folders ahead of files and links.
 */
export function filterCourseMaterials(
  materials: readonly Material[],
  courseId: string,
  options: {
    query?: string | undefined
    kind?: MaterialKindFilter | undefined
    downloadStatus?: MaterialDownloadStatusFilter | undefined
    downloads?: readonly PortalDownload[] | undefined
    localFiles?: readonly MaterialLocalFile[] | undefined
  } = {}
): Material[] {
  const kindFilter = options.kind ?? 'all'
  const downloadStatus = options.downloadStatus ?? 'all'
  const downloads = options.downloads ?? []
  const localFiles = options.localFiles
  const needle = (options.query ?? '').trim().toLowerCase()
  const seen = new Set<string>()
  const result: Material[] = []

  for (const item of materials) {
    if (item.courseId !== courseId) continue
    const dedupeKey = [item.externalId, item.kind, materialTarget(item) ?? ''].join('|')
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    if (kindFilter !== 'all' && item.kind !== kindFilter) continue
    if (downloadStatus !== 'all') {
      const state = resolveMaterialDownloadState(item, downloads, localFiles)
      if (downloadStatus === 'downloaded' && !state.hasCompleted) continue
      if (downloadStatus === 'undownloaded' && (!canDownloadMaterial(item) || state.hasCompleted)) {
        continue
      }
    }
    if (needle) {
      const haystack = `${item.name} ${materialTypeLabel(item)}`.toLowerCase()
      if (!haystack.includes(needle)) continue
    }
    result.push(item)
  }

  return result.sort((a, b) => MATERIAL_KIND_ORDER[a.kind] - MATERIAL_KIND_ORDER[b.kind])
}

export function materialPreviewKind(material: Material): MaterialPreviewKind {
  if (material.kind === 'folder') return 'none'
  const target = materialTarget(material)
  if (!target) return 'none'
  // URL admission decides where the material can be opened. A third-party
  // PDF/image is still an external link even if its extension is previewable.
  if (!normalizePortalTargetUrl(target)) return 'external'
  if (material.kind === 'link') return 'external'
  const extension = (material.fileType || material.name.split('.').pop() || '').trim().toLowerCase()
  return INLINE_EXTENSIONS.has(extension) ? 'inline' : 'external'
}

export function countFailedDownloads(downloads: readonly PortalDownload[]): number {
  return downloads.filter((item) => item.state === 'interrupted').length
}

export function groupMaterials(
  courses: Course[],
  materials: Material[],
  options: { courseFilter?: string; query?: string } = {}
): MaterialGroup[] {
  const courseById = new Map(courses.map((course) => [course.id, course]))
  const courseFilter = options.courseFilter ?? 'all'
  const needle = (options.query ?? '').trim().toLowerCase()
  const groups = new Map<string, MaterialGroup>()

  for (const material of materials) {
    if (courseFilter !== 'all' && material.courseId !== courseFilter) continue
    if (needle && !material.name.toLowerCase().includes(needle)) continue

    const course = courseById.get(material.courseId)
    const key = material.courseId || `unknown:${material.id}`
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        courseId: material.courseId,
        name: course?.name ?? '未知课程',
        classLabel: course?.className || course?.clazzId || null,
        color: course?.color ?? 'var(--accent)',
        items: [],
        rawCount: 0
      }
      groups.set(key, group)
    }
    group.items.push(material)
    group.rawCount += 1
  }

  return [...groups.values()]
    .map((group) => {
      const seen = new Set<string>()
      const items = group.items.filter((item) => {
        // 只合并真正重复的行：同一课程、同一稳定 externalId、同一地址。
        // 同名/同大小但地址不同的文件必须保留，避免误删真实资料。
        const key = [item.externalId, item.kind, materialTarget(item) ?? ''].join('|')
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      return { ...group, items }
    })
    .sort((a, b) => {
      const name = a.name.localeCompare(b.name, 'zh-CN')
      return name !== 0 ? name : (a.classLabel ?? '').localeCompare(b.classLabel ?? '', 'zh-CN')
    })
}

export function findMaterialDownload(
  material: Pick<Material, 'id'>,
  downloads: readonly PortalDownload[]
): PortalDownload | null {
  return (
    downloads
      .filter((item) => item.materialId === material.id)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null
  )
}

/**
 * Resolves unified download + verified local-copy state for a material by explicit `materialId`.
 * When `localFiles` is provided (from main-process disk verification), `hasCompleted` and `localFile`
 * reflect true on-disk availability—independent of download queue clearing or the 100-row queue cap.
 */
export function resolveMaterialDownloadState(
  material: Pick<Material, 'id'>,
  downloads: readonly PortalDownload[],
  localFiles?: readonly MaterialLocalFile[]
): MaterialDownloadState {
  const matched = downloads
    .filter((item) => item.materialId === material.id)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))

  const latest = matched[0] ?? null
  const active = matched.find((item) => item.state === 'progressing') ?? null
  const completed = matched.find((item) => item.state === 'completed') ?? null
  const localFile =
    localFiles !== undefined
      ? (localFiles.find((item) => item.materialId === material.id) ?? null)
      : null
  const hasCompleted = localFiles !== undefined ? localFile !== null : completed !== null

  return {
    latest,
    completed,
    localFile,
    active,
    isDownloading: active !== null,
    hasCompleted,
    canRetryLatest:
      latest !== null && (latest.state === 'interrupted' || latest.state === 'cancelled')
  }
}

/**
 * Plans a batch material download while preserving allowlist eligibility and
 * preventing accidental duplicate downloads of already-downloaded (verified local) or active files.
 */
export function planBatchMaterialDownload(
  materials: readonly Material[],
  selectedIds: Iterable<string>,
  downloads: readonly PortalDownload[],
  options: {
    includeCompleted?: boolean | undefined
    localFiles?: readonly MaterialLocalFile[] | undefined
  } = {}
): BatchDownloadPlan {
  const selected = new Set(selectedIds)
  const seen = new Set<string>()
  const toDownload: Material[] = []
  const skippedCompleted: Material[] = []
  const skippedInProgress: Material[] = []
  const skippedUnsupported: Material[] = []

  for (const item of materials) {
    if (!selected.has(item.id) || seen.has(item.id)) continue
    seen.add(item.id)
    if (!canDownloadMaterial(item)) {
      skippedUnsupported.push(item)
      continue
    }
    const state = resolveMaterialDownloadState(item, downloads, options.localFiles)
    if (state.isDownloading) {
      skippedInProgress.push(item)
      continue
    }
    if (!options.includeCompleted && state.hasCompleted) {
      skippedCompleted.push(item)
      continue
    }
    toDownload.push(item)
  }

  return { toDownload, skippedCompleted, skippedInProgress, skippedUnsupported }
}

export function summarizeCourseDownloads(
  courseMaterials: readonly Material[],
  downloads: readonly PortalDownload[],
  localFiles?: readonly MaterialLocalFile[]
): CourseDownloadSummary {
  const materialIds = new Set<string>()
  let downloadableMaterialCount = 0
  let downloadedMaterialCount = 0
  let undownloadedMaterialCount = 0

  for (const item of courseMaterials) {
    materialIds.add(item.id)
    const downloadable = canDownloadMaterial(item)
    const state = resolveMaterialDownloadState(item, downloads, localFiles)
    if (downloadable) {
      downloadableMaterialCount += 1
      if (state.hasCompleted) downloadedMaterialCount += 1
      else undownloadedMaterialCount += 1
    } else if (state.hasCompleted) {
      downloadedMaterialCount += 1
    }
  }

  let total = 0
  let active = 0
  let completed = 0
  let failed = 0
  for (const item of downloads) {
    if (!item.materialId || !materialIds.has(item.materialId)) continue
    total += 1
    if (item.state === 'progressing') active += 1
    else if (item.state === 'completed') completed += 1
    else if (item.state === 'interrupted') failed += 1
  }

  return {
    total,
    active,
    completed,
    failed,
    downloadedMaterialCount,
    undownloadedMaterialCount,
    downloadableMaterialCount
  }
}

export function resolveDownloadOrigin(
  download: PortalDownload,
  materials: readonly Material[],
  courses: readonly Course[]
): DownloadOrigin {
  if (download.materialId) {
    const material = materials.find((item) => item.id === download.materialId)
    if (material) {
      const course = courses.find((item) => item.id === material.courseId)
      if (course) {
        const duplicateName = courses.filter((c) => c.name.trim() === course.name.trim()).length > 1
        const classLabel = duplicateName ? getCourseClassLabel(course) : null
        const label = classLabel ? `${course.name} · ${classLabel}` : course.name
        return {
          kind: 'material',
          label,
          courseId: course.id,
          materialId: material.id,
          materialName: material.name
        }
      }
      return {
        kind: 'material',
        label: '课程资料',
        courseId: material.courseId,
        materialId: material.id,
        materialName: material.name
      }
    }
  }
  if (download.attachmentTaskId) {
    return {
      kind: 'attachment',
      label: '作业附件',
      courseId: null,
      materialId: null,
      materialName: download.attachmentFileName ?? null
    }
  }
  return {
    kind: 'other',
    label: '网页下载',
    courseId: null,
    materialId: null,
    materialName: null
  }
}

export function filterDownloadQueue(
  downloads: readonly PortalDownload[],
  options: {
    status?: DownloadQueueFilter | undefined
    courseId?: string | null | undefined
    materials?: readonly Material[] | undefined
  } = {}
): PortalDownload[] {
  const status = options.status ?? 'all'
  const courseId = options.courseId ?? null
  const courseMaterialIds =
    courseId && options.materials
      ? new Set(
          options.materials.filter((item) => item.courseId === courseId).map((item) => item.id)
        )
      : null

  return downloads.filter((item) => {
    if (courseMaterialIds && (!item.materialId || !courseMaterialIds.has(item.materialId))) {
      return false
    }
    if (status === 'all') return true
    if (status === 'progressing') return item.state === 'progressing'
    if (status === 'completed') return item.state === 'completed'
    return item.state === 'interrupted' || item.state === 'cancelled'
  })
}

export function downloadSourceKey(download: PortalDownload): string {
  if (download.materialId) return `material:${download.materialId}`
  if (download.attachmentTaskId && download.attachmentObjectId) {
    return `attachment:${download.attachmentTaskId}:${download.attachmentObjectId}`
  }
  return `download:${download.id}`
}

export const BATCH_RETRY_DOWNLOAD_LIMIT = 200

/** Preserve input order while splitting a retry request into IPC-sized batches. */
export function chunkBatchRetryDownloadIds(
  ids: readonly string[],
  limit = BATCH_RETRY_DOWNLOAD_LIMIT
): string[][] {
  const unique = [...new Set(ids.filter((id) => id.length > 0))]
  if (unique.length === 0) return []
  const size = Math.max(1, Math.trunc(limit))
  const chunks: string[][] = []
  for (let index = 0; index < unique.length; index += size) {
    chunks.push(unique.slice(index, index + size))
  }
  return chunks
}

export function mergeBatchRetryResults(results: readonly BatchRetryResult[]): BatchRetryResult {
  return {
    startedDownloadIds: results.flatMap((result) => result.startedDownloadIds),
    startedMaterialIds: results.flatMap((result) => result.startedMaterialIds),
    startedItems: results.flatMap((result) => result.startedItems),
    skipped: results.flatMap((result) => result.skipped),
    failed: results.flatMap((result) => result.failed)
  }
}

/**
 * Shared eligibility planner for batch retrying failed downloads (used by BOTH renderer UI and main process):
 * - Enforces optional `courseId` scope strictly.
 * - Deduplicates by stable source key so the same material/attachment is retried at most once.
 * - Excludes sources that are currently progressing or already have a verified local copy on disk.
 *   Historical completed queue rows are not proof that the file is still available.
 */
export function selectRetryableFailedDownloads(
  downloads: readonly PortalDownload[],
  localFiles: readonly MaterialLocalFile[],
  options: {
    courseId?: string | null | undefined
    materials?: readonly Material[] | undefined
    requestedIds?: ReadonlySet<string> | undefined
  } = {}
): PortalDownload[] {
  const courseId = options.courseId?.trim() || null
  const courseMaterialIds = courseId
    ? new Set(
        (options.materials ?? [])
          .filter((item) => item.courseId === courseId)
          .map((item) => item.id)
      )
    : null

  const verifiedLocalMaterialIds = new Set(localFiles.map((item) => item.materialId))
  const activeSourceKeys = new Set<string>()

  for (const item of downloads) {
    if (item.state === 'progressing') {
      activeSourceKeys.add(downloadSourceKey(item))
    }
  }

  const ordered = [...downloads].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const seenSources = new Set<string>()
  const result: PortalDownload[] = []

  for (const item of ordered) {
    if (item.state !== 'interrupted') continue
    if (options.requestedIds && !options.requestedIds.has(item.id)) continue
    if (courseMaterialIds) {
      if (!item.materialId || !courseMaterialIds.has(item.materialId)) continue
    }
    const key = downloadSourceKey(item)
    if (activeSourceKeys.has(key)) continue
    if (item.materialId && verifiedLocalMaterialIds.has(item.materialId)) continue
    if (seenSources.has(key)) continue
    seenSources.add(key)
    result.push(item)
  }

  return result
}

export function summarizeBatchTransferSession(
  trackedDownloads: readonly BatchTrackedItem[],
  dispatchFailed: readonly BatchDispatchFailure[],
  downloads: readonly PortalDownload[],
  options: {
    courseId?: string | null | undefined
    materials?: readonly Material[] | undefined
    localFiles?: readonly MaterialLocalFile[] | undefined
  } = {}
): BatchTransferSummary {
  const byId = new Map(downloads.map((item) => [item.id, item]))
  const transferring: BatchTrackedItem[] = []
  const succeeded: BatchTrackedItem[] = []
  const transferFailed: BatchTrackedItem[] = []
  const cancelled: BatchTrackedItem[] = []
  const cleared: BatchTrackedItem[] = []

  for (const entry of trackedDownloads) {
    const record = byId.get(entry.downloadId)
    if (record) {
      if (record.state === 'progressing') {
        transferring.push(entry)
      } else if (record.state === 'completed') {
        succeeded.push(entry)
      } else if (record.state === 'cancelled') {
        cancelled.push(entry)
      } else {
        transferFailed.push(entry)
      }
      continue
    }

    // Record is absent from `downloads` (e.g. after clearing finished queue history):
    // preserve observed terminal state if known; NEVER infer missing records as `transferring`.
    if (entry.terminalState === 'completed') {
      succeeded.push(entry)
    } else if (entry.terminalState === 'interrupted') {
      transferFailed.push(entry)
    } else if (entry.terminalState === 'cancelled') {
      cancelled.push(entry)
    } else {
      cleared.push(entry)
    }
  }

  const failedIdSet = new Set<string>()
  for (const item of dispatchFailed) failedIdSet.add(item.materialId)
  for (const item of transferFailed) failedIdSet.add(item.materialId)

  const localFiles = options.localFiles ?? []
  const transferFailedDownloadIds = new Set(transferFailed.map((item) => item.downloadId))
  const retryableDownloads = selectRetryableFailedDownloads(downloads, localFiles, {
    courseId: options.courseId ?? null,
    materials: options.materials,
    requestedIds: transferFailedDownloadIds
  })
  const retryableDownloadIdSet = new Set(retryableDownloads.map((item) => item.id))

  // Also allow retrying a transfer-failed entry whose queue row was cleared only if it still
  // lacks a verified local copy and is not actively progressing. A historical completed row is
  // not proof of recovery; the local file record is the source of truth.
  const localMaterialIds = new Set(localFiles.map((item) => item.materialId))
  const activeMaterialIds = new Set(
    downloads
      .filter((item) => item.state === 'progressing' && item.materialId)
      .map((item) => item.materialId!)
  )
  const seenRetryableTransferMaterials = new Set<string>()
  const retryableTransferFailed: BatchTrackedItem[] = []
  for (const entry of transferFailed) {
    if (seenRetryableTransferMaterials.has(entry.materialId)) continue
    const inQueue = byId.has(entry.downloadId)
    if (inQueue) {
      if (!retryableDownloadIdSet.has(entry.downloadId)) continue
    } else {
      if (localMaterialIds.has(entry.materialId) || activeMaterialIds.has(entry.materialId)) {
        continue
      }
    }
    seenRetryableTransferMaterials.add(entry.materialId)
    retryableTransferFailed.push(entry)
  }

  const retryableDispatchFailed: BatchDispatchFailure[] = []
  const seenRetryableDispatchMaterials = new Set<string>()
  for (const item of dispatchFailed) {
    if (
      seenRetryableTransferMaterials.has(item.materialId) ||
      seenRetryableDispatchMaterials.has(item.materialId)
    ) {
      continue
    }
    if (localMaterialIds.has(item.materialId) || activeMaterialIds.has(item.materialId)) {
      continue
    }
    if (options.materials) {
      const mat = options.materials.find((candidate) => candidate.id === item.materialId)
      if (!mat || !canDownloadMaterial(mat)) continue
      if (options.courseId && mat.courseId !== options.courseId) continue
    }
    seenRetryableDispatchMaterials.add(item.materialId)
    retryableDispatchFailed.push(item)
  }

  const retryableFailedMaterialIds = [
    ...retryableDispatchFailed.map((item) => item.materialId),
    ...retryableTransferFailed.map((item) => item.materialId)
  ]

  return {
    totalAttempted: trackedDownloads.length + dispatchFailed.length,
    transferring,
    succeeded,
    transferFailed,
    cancelled,
    cleared,
    dispatchFailed: [...dispatchFailed],
    allFailedMaterialIds: [...failedIdSet],
    retryableTransferFailed,
    retryableDispatchFailed,
    retryableFailedMaterialIds,
    isSettled: transferring.length === 0
  }
}

export function downloadPercent(download: PortalDownload): number | null {
  if (download.totalBytes <= 0) return null
  return Math.min(100, Math.round((download.receivedBytes / download.totalBytes) * 100))
}

export function formatDownloadBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function downloadStateLabel(download: PortalDownload): string {
  if (download.state === 'progressing') {
    const percent = downloadPercent(download)
    return percent === null
      ? `下载中 · ${formatDownloadBytes(download.receivedBytes)}`
      : `下载中 ${percent}% · ${formatDownloadBytes(download.receivedBytes)} / ${formatDownloadBytes(download.totalBytes)}`
  }
  if (download.state === 'completed')
    return `已完成 · ${formatDownloadBytes(download.receivedBytes)}`
  if (download.state === 'cancelled') return '已取消'
  return '下载失败或中断'
}

export function downloadInlineText(download: PortalDownload): string {
  if (download.state === 'progressing') {
    const percent = downloadPercent(download)
    return percent === null
      ? `下载中 · ${formatDownloadBytes(download.receivedBytes)}`
      : `下载中 ${percent}%`
  }
  return downloadStateLabel(download)
}
