import { useMemo, useState } from 'react'
import { Compass, ExternalLink, FolderOpen, RotateCcw, Trash2, X } from 'lucide-react'
import type { Course, Material, MaterialLocalFile, PortalDownload } from '@shared/types'
import {
  downloadPercent,
  downloadStateLabel,
  filterDownloadQueue,
  formatDownloadBytes,
  resolveDownloadOrigin,
  selectRetryableFailedDownloads,
  type DownloadQueueFilter
} from '@shared/materials'

interface DownloadQueueProps {
  downloads: PortalDownload[]
  localFiles?: readonly MaterialLocalFile[] | undefined
  courses?: readonly Course[] | undefined
  materials?: readonly Material[] | undefined
  activeCourseId?: string | null | undefined
  downloadDirectory?: string | null | undefined
  onLocateMaterial?: ((courseId: string, materialId: string) => void) | undefined
  onRetryAllFailed?:
    | ((courseId: string | null, failedDownloads: PortalDownload[]) => void)
    | undefined
  onOpen: (download: PortalDownload) => void
  onReveal: (download: PortalDownload) => void
  onCancel: (download: PortalDownload) => void
  onRetry: (download: PortalDownload) => void
  onDelete: (download: PortalDownload) => void
  onClear: () => void
}

export function DownloadQueue({
  downloads,
  localFiles = [],
  courses = [],
  materials = [],
  activeCourseId = null,
  downloadDirectory = null,
  onLocateMaterial,
  onRetryAllFailed,
  onOpen,
  onReveal,
  onCancel,
  onRetry,
  onDelete,
  onClear
}: DownloadQueueProps) {
  const [statusFilter, setStatusFilter] = useState<DownloadQueueFilter>('all')
  const [currentCourseOnly, setCurrentCourseOnly] = useState(false)

  const counts = useMemo(() => {
    let progressing = 0
    let completed = 0
    let failed = 0
    for (const item of downloads) {
      if (item.state === 'progressing') progressing += 1
      else if (item.state === 'completed') completed += 1
      else failed += 1
    }
    return { progressing, completed, failed }
  }, [downloads])

  const currentCourseDownloadCount = useMemo(() => {
    if (!activeCourseId || materials.length === 0) return 0
    return filterDownloadQueue(downloads, {
      courseId: activeCourseId,
      materials
    }).length
  }, [activeCourseId, downloads, materials])

  const effectiveCourseFilter =
    currentCourseOnly && activeCourseId && currentCourseDownloadCount > 0 ? activeCourseId : null

  const retryableFailedItems = useMemo(
    () =>
      selectRetryableFailedDownloads(downloads, localFiles, {
        courseId: effectiveCourseFilter,
        materials
      }),
    [downloads, effectiveCourseFilter, localFiles, materials]
  )

  const visibleDownloads = useMemo(
    () =>
      filterDownloadQueue(downloads, {
        status: statusFilter,
        courseId: effectiveCourseFilter,
        materials
      }),
    [downloads, effectiveCourseFilter, materials, statusFilter]
  )

  const finished = downloads.filter((item) => item.state !== 'progressing').length

  return (
    <section className="download-queue" aria-label="下载队列">
      <header className="download-queue-head">
        <div>
          <strong>下载队列</strong>
          <span>{downloads.length} 项记录</span>
          {downloadDirectory ? (
            <span className="download-queue-dir" title={`下载保存目录：${downloadDirectory}`}>
              目录：{downloadDirectory}
            </span>
          ) : null}
        </div>
        <div className="download-queue-head-actions">
          {retryableFailedItems.length > 0 && onRetryAllFailed ? (
            <button
              type="button"
              className="btn subtle"
              onClick={() => onRetryAllFailed(effectiveCourseFilter, retryableFailedItems)}
              title={
                effectiveCourseFilter
                  ? '仅重新发起当前课程中未恢复且未下载完成的失败任务（同来源去重）'
                  : '重新发起所有未恢复且未下载完成的失败任务（同来源去重）'
              }
            >
              <RotateCcw size={12} />{' '}
              {effectiveCourseFilter
                ? `重试本课失败 (${retryableFailedItems.length})`
                : `重试全部失败 (${retryableFailedItems.length})`}
            </button>
          ) : null}
          <button
            type="button"
            className="btn subtle"
            onClick={onClear}
            disabled={finished === 0}
            title="清除已结束的下载记录，不删除已下载文件"
          >
            清除已结束
          </button>
        </div>
      </header>
      {downloads.length > 0 ? (
        <div className="download-queue-filters" role="group" aria-label="筛选下载记录">
          <button
            type="button"
            className={statusFilter === 'all' ? 'rail-pill active' : 'rail-pill'}
            aria-pressed={statusFilter === 'all'}
            onClick={() => setStatusFilter('all')}
          >
            全部 {downloads.length}
          </button>
          {counts.progressing > 0 ? (
            <button
              type="button"
              className={statusFilter === 'progressing' ? 'rail-pill active' : 'rail-pill'}
              aria-pressed={statusFilter === 'progressing'}
              onClick={() => setStatusFilter('progressing')}
            >
              进行中 {counts.progressing}
            </button>
          ) : null}
          {counts.completed > 0 ? (
            <button
              type="button"
              className={statusFilter === 'completed' ? 'rail-pill active' : 'rail-pill'}
              aria-pressed={statusFilter === 'completed'}
              onClick={() => setStatusFilter('completed')}
            >
              已完成 {counts.completed}
            </button>
          ) : null}
          {counts.failed > 0 ? (
            <button
              type="button"
              className={statusFilter === 'failed' ? 'rail-pill active' : 'rail-pill'}
              aria-pressed={statusFilter === 'failed'}
              onClick={() => setStatusFilter('failed')}
            >
              失败/取消 {counts.failed}
            </button>
          ) : null}
          {activeCourseId && currentCourseDownloadCount > 0 ? (
            <button
              type="button"
              className={currentCourseOnly ? 'rail-pill active' : 'rail-pill'}
              aria-pressed={currentCourseOnly}
              onClick={() => setCurrentCourseOnly((value) => !value)}
            >
              仅当前课程 ({currentCourseDownloadCount})
            </button>
          ) : null}
        </div>
      ) : null}
      {downloads.length === 0 ? (
        <p className="download-queue-empty">暂无下载记录。点击资料行右侧的下载按钮开始。</p>
      ) : visibleDownloads.length === 0 ? (
        <p className="download-queue-empty">
          当前筛选下没有下载记录。
          <button
            type="button"
            className="text-link"
            onClick={() => {
              setStatusFilter('all')
              setCurrentCourseOnly(false)
            }}
          >
            显示全部
          </button>
        </p>
      ) : (
        <ul className="download-queue-list">
          {visibleDownloads.map((item) => {
            const percent = downloadPercent(item)
            const origin = resolveDownloadOrigin(item, materials, courses)
            const canLocate = Boolean(
              onLocateMaterial && origin.kind === 'material' && origin.courseId && origin.materialId
            )
            return (
              <li className="download-queue-item" key={item.id}>
                <div className="download-queue-main">
                  <div className="download-queue-title" title={item.filename}>
                    {item.filename}
                  </div>
                  <div className="download-queue-meta">
                    <span className={`download-state ${item.state}`}>
                      {downloadStateLabel(item)}
                    </span>
                    {origin.label ? (
                      <span className="download-origin-chip" title={origin.label}>
                        {origin.label}
                      </span>
                    ) : null}
                    <span>{formatDownloadBytes(item.receivedBytes)}</span>
                    {percent !== null ? <span>{percent}%</span> : null}
                  </div>
                  {item.state === 'progressing' ? (
                    <div className="download-progress" aria-hidden="true">
                      <span style={{ width: `${percent ?? 8}%` }} />
                    </div>
                  ) : null}
                </div>
                <div className="download-queue-actions">
                  {canLocate ? (
                    <button
                      type="button"
                      className="icon-btn"
                      title={`定位课程资料：${origin.materialName ?? item.filename}`}
                      aria-label={`定位资料 ${item.filename}`}
                      onClick={() => onLocateMaterial?.(origin.courseId!, origin.materialId!)}
                    >
                      <Compass size={14} />
                    </button>
                  ) : null}
                  {item.state === 'completed' ? (
                    <>
                      <button
                        type="button"
                        className="icon-btn"
                        title="打开文件"
                        aria-label="打开文件"
                        onClick={() => onOpen(item)}
                      >
                        <ExternalLink size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="打开所在文件夹"
                        aria-label="打开所在文件夹"
                        onClick={() => onReveal(item)}
                      >
                        <FolderOpen size={14} />
                      </button>
                    </>
                  ) : null}
                  {item.state === 'progressing' ? (
                    <button
                      type="button"
                      className="icon-btn"
                      title="取消下载"
                      aria-label="取消下载"
                      onClick={() => onCancel(item)}
                    >
                      <X size={14} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="icon-btn"
                      title={item.state === 'completed' ? '再次下载' : '重试下载'}
                      aria-label={item.state === 'completed' ? '再次下载' : '重试下载'}
                      onClick={() => onRetry(item)}
                    >
                      <RotateCcw size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-btn danger"
                    title="删除下载记录"
                    aria-label="删除下载记录"
                    onClick={() => onDelete(item)}
                    disabled={item.state === 'progressing'}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
