import { describe, expect, it } from 'vitest'
import type { Course, Material, PortalDownload } from '../../src/shared/types'
import {
  canDownloadMaterial,
  chunkBatchRetryDownloadIds,
  countFailedDownloads,
  downloadInlineText,
  downloadPercent,
  downloadStateLabel,
  filterCourseMaterials,
  filterDownloadQueue,
  findMaterialDownload,
  groupMaterials,
  materialFolderOpenUrl,
  materialPreviewKind,
  materialTarget,
  materialTypeLabel,
  mergeBatchRetryResults,
  planBatchMaterialDownload,
  resolveDownloadOrigin,
  resolveMaterialDownloadState,
  selectRetryableFailedDownloads,
  summarizeBatchTransferSession,
  summarizeCourseDownloads
} from '../../src/shared/materials'

const courseA: Course = {
  id: 'course-a',
  externalId: '100:200',
  name: '程序设计基础',
  code: 'CS101',
  category: '专业课',
  teacher: '教师 A',
  semester: '2026 春',
  color: '#123456',
  favorite: false,
  source: 'chaoxing',
  className: '教学班 A',
  clazzId: '200',
  sourceUrl: 'https://mooc1.chaoxing.com/course?cpi=1',
  schedule: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}
const courseB: Course = {
  ...courseA,
  id: 'course-b',
  externalId: '100:201',
  className: '教学班 B',
  clazzId: '201',
  color: '#654321'
}

function material(
  overrides: Partial<Material> & Pick<Material, 'id' | 'courseId' | 'name'>
): Material {
  return {
    externalId: `ext-${overrides.id}`,
    kind: 'file',
    fileType: 'pdf',
    size: '1 MB',
    url: 'https://p.ananas.chaoxing.com/star3/origin/file.pdf',
    sourceUrl: 'https://p.ananas.chaoxing.com/star3/origin/file.pdf',
    source: 'chaoxing',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('materials grouping and preview', () => {
  it('keeps same-name courses in separate groups and exposes class labels', () => {
    const groups = groupMaterials(
      [courseA, courseB],
      [
        material({ id: 'a1', courseId: courseA.id, name: '讲义.pdf' }),
        material({ id: 'b1', courseId: courseB.id, name: '讲义.pdf' })
      ]
    )
    expect(groups).toHaveLength(2)
    expect(groups.map((group) => group.classLabel).sort()).toEqual(['教学班 A', '教学班 B'])
  })

  it('deduplicates only exact material rows and preserves same names with different URLs', () => {
    const groups = groupMaterials(
      [courseA],
      [
        material({ id: 'a1', courseId: courseA.id, name: '同名.pdf', externalId: 'material:1' }),
        material({ id: 'a2', courseId: courseA.id, name: '同名.pdf', externalId: 'material:1' }),
        material({
          id: 'a3',
          courseId: courseA.id,
          name: '同名.pdf',
          externalId: 'material:2',
          url: 'https://p.ananas.chaoxing.com/star3/origin/other.pdf'
        })
      ]
    )
    expect(groups[0]?.items).toHaveLength(2)
    expect(groups[0]?.rawCount).toBe(3)
  })

  it('filters by course and query without changing group identity', () => {
    const groups = groupMaterials(
      [courseA, courseB],
      [
        material({ id: 'a1', courseId: courseA.id, name: '线性代数.pdf' }),
        material({ id: 'b1', courseId: courseB.id, name: '概率论.pdf' })
      ],
      { courseFilter: courseB.id, query: '概率' }
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.courseId).toBe(courseB.id)
  })

  it('classifies preview modes without pretending Office files are previewable', () => {
    expect(materialPreviewKind(material({ id: 'pdf', courseId: courseA.id, name: 'a.pdf' }))).toBe(
      'inline'
    )
    expect(
      materialPreviewKind(
        material({ id: 'doc', courseId: courseA.id, name: 'a.docx', fileType: 'docx' })
      )
    ).toBe('external')
    expect(
      materialPreviewKind(
        material({ id: 'folder', courseId: courseA.id, name: '课件', kind: 'folder', url: null })
      )
    ).toBe('none')
    expect(
      materialPreviewKind(
        material({ id: 'none', courseId: courseA.id, name: 'a.pdf', url: null, sourceUrl: null })
      )
    ).toBe('none')
    expect(
      materialPreviewKind(
        material({
          id: 'third-party-pdf',
          courseId: courseA.id,
          name: 'a.pdf',
          url: 'https://example.com/a.pdf',
          sourceUrl: 'https://example.com/a.pdf'
        })
      )
    ).toBe('external')
    expect(
      materialPreviewKind(
        material({
          id: 'third-party-image',
          courseId: courseA.id,
          name: 'a.png',
          fileType: 'png',
          url: 'https://example.com/a.png',
          sourceUrl: 'https://example.com/a.png'
        })
      )
    ).toBe('external')
  })

  it('uses only the explicit material id for download association', () => {
    const target = material({ id: 'a1', courseId: courseA.id, name: '讲义.pdf' })
    const downloads: PortalDownload[] = [
      {
        id: 'old',
        filename: '讲义.pdf',
        url: 'https://example.com/a',
        state: 'completed',
        receivedBytes: 10,
        totalBytes: 10,
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:01.000Z'
      },
      {
        id: 'linked',
        materialId: 'a1',
        filename: '讲义-新.pdf',
        url: 'https://example.com/b',
        state: 'progressing',
        receivedBytes: 5,
        totalBytes: 10,
        startedAt: '2026-01-02T00:00:00.000Z',
        completedAt: null
      }
    ]
    expect(findMaterialDownload(target, downloads)?.id).toBe('linked')
    expect(downloadPercent(downloads[1]!)).toBe(50)
    expect(downloadStateLabel(downloads[1]!)).toContain('50%')
    expect(countFailedDownloads(downloads)).toBe(0)
    expect(
      countFailedDownloads([
        ...downloads,
        { ...downloads[1]!, id: 'failed', state: 'interrupted' },
        { ...downloads[1]!, id: 'cancelled', state: 'cancelled' }
      ])
    ).toBe(1)
  })

  it('returns null target for non-http materials', () => {
    expect(
      materialTarget(
        material({ id: 'x', courseId: courseA.id, name: 'x', url: 'javascript:alert(1)' })
      )
    ).toBeNull()
  })

  it('aligns download eligibility with platform file IDs and strict Portal allowlist', () => {
    expect(
      canDownloadMaterial(
        material({
          id: 'platform-only',
          courseId: courseA.id,
          externalId: 'material:123456',
          name: '课件.pptx',
          url: null,
          sourceUrl: null
        })
      )
    ).toBe(true)
    expect(
      canDownloadMaterial(
        material({
          id: 'external-link',
          courseId: courseA.id,
          externalId: 'material:url:abc',
          kind: 'link',
          name: 'GitHub',
          url: 'https://github.com/example/repo',
          sourceUrl: null
        })
      )
    ).toBe(false)
    expect(
      canDownloadMaterial(
        material({
          id: 'folder-item',
          courseId: courseA.id,
          externalId: 'material:999',
          kind: 'folder',
          name: '第一章',
          url: null,
          sourceUrl: null
        })
      )
    ).toBe(false)
    expect(
      canDownloadMaterial(
        material({
          id: 'official-http',
          courseId: courseA.id,
          externalId: 'url-1',
          name: '讲义.pdf',
          url: 'http://pan-yz.chaoxing.com/download/1',
          sourceUrl: null
        })
      )
    ).toBe(true)
  })

  it('formats human-readable type labels, resolves folder portal fallback, and filters course materials cleanly', () => {
    const folder = material({
      id: 'f1',
      courseId: courseA.id,
      externalId: 'material:10',
      kind: 'folder',
      fileType: 'afolder',
      name: '实验资料',
      url: null,
      sourceUrl: null
    })
    const link = material({
      id: 'l1',
      courseId: courseA.id,
      externalId: 'material:url:1',
      kind: 'link',
      fileType: 'url',
      name: '参考文档',
      url: 'https://example.com/doc',
      sourceUrl: null
    })
    const pdf = material({
      id: 'p1',
      courseId: courseA.id,
      externalId: 'material:20',
      fileType: 'pdf',
      name: '第一章讲义.pdf'
    })
    const pdfDup = material({
      id: 'p1-dup',
      courseId: courseA.id,
      externalId: 'material:20',
      fileType: 'pdf',
      name: '第一章讲义.pdf'
    })

    expect(materialTypeLabel(folder)).toBe('文件夹')
    expect(materialTypeLabel(link)).toBe('网页链接')
    expect(materialTypeLabel(pdf)).toBe('PDF')
    expect(materialFolderOpenUrl(folder, courseA.sourceUrl)).toBe(courseA.sourceUrl)
    expect(materialFolderOpenUrl(folder, 'https://evil.example/course')).toBeNull()

    const all = filterCourseMaterials([pdf, link, folder, pdfDup], courseA.id)
    expect(all.map((item) => item.id)).toEqual(['f1', 'p1', 'l1'])
    expect(
      filterCourseMaterials([pdf, link, folder], courseA.id, { kind: 'folder' }).map(
        (item) => item.id
      )
    ).toEqual(['f1'])
    expect(
      filterCourseMaterials([pdf, link, folder], courseA.id, { query: 'PDF' }).map(
        (item) => item.id
      )
    ).toEqual(['p1'])

    expect(
      downloadInlineText({
        id: 'd1',
        filename: 'a.pdf',
        url: 'https://mooc1.chaoxing.com/a',
        state: 'progressing',
        receivedBytes: 512,
        totalBytes: 1024,
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: null
      })
    ).toBe('下载中 50%')
  })

  it('preserves completed local download access when a later retry fails and filters by download status', () => {
    const mDone = material({
      id: 'm-done',
      courseId: courseA.id,
      externalId: 'material:101',
      name: '第一讲.pdf'
    })
    const mTodo = material({
      id: 'm-todo',
      courseId: courseA.id,
      externalId: 'material:102',
      name: '第二讲.pdf'
    })
    const mFolder = material({
      id: 'm-folder',
      courseId: courseA.id,
      externalId: 'material:103',
      kind: 'folder',
      name: '课件目录',
      url: null,
      sourceUrl: null
    })
    const mExternal = material({
      id: 'm-ext',
      courseId: courseA.id,
      externalId: 'material:url:ext',
      kind: 'link',
      name: '参考站点',
      url: 'https://example.com/ref',
      sourceUrl: null
    })

    const downloads: PortalDownload[] = [
      {
        id: 'dl-old-done',
        materialId: 'm-done',
        filename: '第一讲.pdf',
        url: 'https://mooc1.chaoxing.com/coursedata/downloadData?dataId=101',
        state: 'completed',
        receivedBytes: 2048,
        totalBytes: 2048,
        startedAt: '2026-01-01T10:00:00.000Z',
        completedAt: '2026-01-01T10:00:05.000Z',
        savePath: 'C:/Downloads/第一讲.pdf'
      },
      {
        id: 'dl-new-failed',
        materialId: 'm-done',
        filename: '第一讲 (1).pdf',
        url: 'https://mooc1.chaoxing.com/coursedata/downloadData?dataId=101',
        state: 'interrupted',
        receivedBytes: 0,
        totalBytes: 0,
        startedAt: '2026-01-02T10:00:00.000Z',
        completedAt: '2026-01-02T10:00:02.000Z'
      }
    ]

    const state = resolveMaterialDownloadState(mDone, downloads)
    expect(state.latest?.id).toBe('dl-new-failed')
    expect(state.completed?.id).toBe('dl-old-done')
    expect(state.hasCompleted).toBe(true)
    expect(state.canRetryLatest).toBe(true)
    expect(state.isDownloading).toBe(false)

    const all = [mDone, mTodo, mFolder, mExternal]
    expect(
      filterCourseMaterials(all, courseA.id, { downloadStatus: 'downloaded', downloads }).map(
        (item) => item.id
      )
    ).toEqual(['m-done'])
    // Undownloaded includes only downloadable items without a completed copy (excludes folder & third-party link)
    expect(
      filterCourseMaterials(all, courseA.id, { downloadStatus: 'undownloaded', downloads }).map(
        (item) => item.id
      )
    ).toEqual(['m-todo'])

    expect(summarizeCourseDownloads(all, downloads)).toEqual({
      total: 2,
      active: 0,
      completed: 1,
      failed: 1,
      downloadedMaterialCount: 1,
      undownloadedMaterialCount: 1,
      downloadableMaterialCount: 2
    })
  })

  it('plans batch downloads without duplicates, active items, folders, or third-party links', () => {
    const mTodo = material({
      id: 'm1',
      courseId: courseA.id,
      externalId: 'material:201',
      name: '待下载.pdf'
    })
    const mDone = material({
      id: 'm2',
      courseId: courseA.id,
      externalId: 'material:202',
      name: '已下载.pdf'
    })
    const mBusy = material({
      id: 'm3',
      courseId: courseA.id,
      externalId: 'material:203',
      name: '下载中.pdf'
    })
    const mFolder = material({
      id: 'm4',
      courseId: courseA.id,
      externalId: 'material:204',
      kind: 'folder',
      name: '文件夹',
      url: null,
      sourceUrl: null
    })
    const mThird = material({
      id: 'm5',
      courseId: courseA.id,
      externalId: 'material:url:third',
      kind: 'link',
      name: '外链',
      url: 'https://evil.example/doc',
      sourceUrl: null
    })
    const downloads: PortalDownload[] = [
      {
        id: 'd-done',
        materialId: 'm2',
        filename: '已下载.pdf',
        url: 'https://mooc1.chaoxing.com/a',
        state: 'completed',
        receivedBytes: 100,
        totalBytes: 100,
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:01.000Z'
      },
      {
        id: 'd-busy',
        materialId: 'm3',
        filename: '下载中.pdf',
        url: 'https://mooc1.chaoxing.com/b',
        state: 'progressing',
        receivedBytes: 50,
        totalBytes: 100,
        startedAt: '2026-01-02T00:00:00.000Z',
        completedAt: null
      }
    ]
    const items = [mTodo, mDone, mBusy, mFolder, mThird]
    const plan = planBatchMaterialDownload(items, ['m1', 'm2', 'm3', 'm4', 'm5'], downloads)
    expect(plan.toDownload.map((i) => i.id)).toEqual(['m1'])
    expect(plan.skippedCompleted.map((i) => i.id)).toEqual(['m2'])
    expect(plan.skippedInProgress.map((i) => i.id)).toEqual(['m3'])
    expect(plan.skippedUnsupported.map((i) => i.id)).toEqual(['m4', 'm5'])

    // Explicit includeCompleted allows re-downloading completed files while still skipping progressing & unsupported
    const redownloadPlan = planBatchMaterialDownload(items, ['m2', 'm3', 'm4'], downloads, {
      includeCompleted: true
    })
    expect(redownloadPlan.toDownload.map((i) => i.id)).toEqual(['m2'])
    expect(redownloadPlan.skippedInProgress.map((i) => i.id)).toEqual(['m3'])
    expect(redownloadPlan.skippedUnsupported.map((i) => i.id)).toEqual(['m4'])
  })

  it('resolves download origins with same-name class disambiguation and filters download queue by status & course', () => {
    const mA = material({
      id: 'mA',
      courseId: courseA.id,
      externalId: 'material:301',
      name: 'A讲义.pdf'
    })
    const mB = material({
      id: 'mB',
      courseId: courseB.id,
      externalId: 'material:302',
      name: 'B讲义.pdf'
    })
    const dlA: PortalDownload = {
      id: 'dl-a',
      materialId: 'mA',
      filename: 'A讲义.pdf',
      url: 'https://mooc1.chaoxing.com/a',
      state: 'completed',
      receivedBytes: 100,
      totalBytes: 100,
      startedAt: '2026-01-03T00:00:00.000Z',
      completedAt: '2026-01-03T00:00:01.000Z'
    }
    const dlB: PortalDownload = {
      id: 'dl-b',
      materialId: 'mB',
      filename: 'B讲义.pdf',
      url: 'https://mooc1.chaoxing.com/b',
      state: 'interrupted',
      receivedBytes: 0,
      totalBytes: 0,
      startedAt: '2026-01-02T00:00:00.000Z',
      completedAt: '2026-01-02T00:00:01.000Z'
    }
    const dlAttach: PortalDownload = {
      id: 'dl-att',
      attachmentTaskId: 'task-1',
      attachmentFileName: '实验模板.docx',
      filename: '实验模板.docx',
      url: 'https://mooc1.chaoxing.com/c',
      state: 'progressing',
      receivedBytes: 10,
      totalBytes: 100,
      startedAt: '2026-01-04T00:00:00.000Z',
      completedAt: null
    }

    const originA = resolveDownloadOrigin(dlA, [mA, mB], [courseA, courseB])
    expect(originA).toMatchObject({
      kind: 'material',
      courseId: courseA.id,
      materialId: 'mA',
      materialName: 'A讲义.pdf'
    })
    expect(originA.label).toContain('程序设计基础')
    expect(originA.label).toContain('教学班 A')
    expect(originA.label).toContain('200')
    expect(resolveDownloadOrigin(dlAttach, [mA, mB], [courseA, courseB]).kind).toBe('attachment')

    const allDl = [dlAttach, dlA, dlB]
    expect(filterDownloadQueue(allDl, { status: 'completed' }).map((d) => d.id)).toEqual(['dl-a'])
    expect(filterDownloadQueue(allDl, { status: 'failed' }).map((d) => d.id)).toEqual(['dl-b'])
    expect(filterDownloadQueue(allDl, { status: 'progressing' }).map((d) => d.id)).toEqual([
      'dl-att'
    ])
    expect(
      filterDownloadQueue(allDl, { courseId: courseA.id, materials: [mA, mB] }).map((d) => d.id)
    ).toEqual(['dl-a'])
  })

  it('enforces course scope, source deduplication, local-copy exclusion, and recovery checks on batch retry', () => {
    const mA1 = material({
      id: 'mA1',
      courseId: courseA.id,
      externalId: 'material:401',
      name: '待重试.pdf'
    })
    const mA2 = material({
      id: 'mA2',
      courseId: courseA.id,
      externalId: 'material:402',
      name: '已恢复.pdf'
    })
    const mA3 = material({
      id: 'mA3',
      courseId: courseA.id,
      externalId: 'material:403',
      name: '进行中.pdf'
    })
    const mB1 = material({
      id: 'mB1',
      courseId: courseB.id,
      externalId: 'material:404',
      name: '别课失败.pdf'
    })

    const downloads: PortalDownload[] = [
      // Duplicate failures for mA1 -> must retry only the newest ONCE
      {
        id: 'f-a1-old',
        materialId: 'mA1',
        filename: '待重试.pdf',
        url: 'https://mooc1.chaoxing.com/a1',
        state: 'interrupted',
        receivedBytes: 0,
        totalBytes: 0,
        startedAt: '2026-01-01T10:00:00.000Z',
        completedAt: '2026-01-01T10:00:01.000Z'
      },
      {
        id: 'f-a1-new',
        materialId: 'mA1',
        filename: '待重试.pdf',
        url: 'https://mooc1.chaoxing.com/a1',
        state: 'interrupted',
        receivedBytes: 0,
        totalBytes: 0,
        startedAt: '2026-01-02T10:00:00.000Z',
        completedAt: '2026-01-02T10:00:01.000Z'
      },
      // mA2 failed earlier then succeeded -> old failure must NOT be retried
      {
        id: 'f-a2-old',
        materialId: 'mA2',
        filename: '已恢复.pdf',
        url: 'https://mooc1.chaoxing.com/a2',
        state: 'interrupted',
        receivedBytes: 0,
        totalBytes: 0,
        startedAt: '2026-01-01T08:00:00.000Z',
        completedAt: '2026-01-01T08:00:01.000Z'
      },
      {
        id: 'c-a2-new',
        materialId: 'mA2',
        filename: '已恢复.pdf',
        url: 'https://mooc1.chaoxing.com/a2',
        state: 'completed',
        receivedBytes: 512,
        totalBytes: 512,
        startedAt: '2026-01-01T09:00:00.000Z',
        completedAt: '2026-01-01T09:00:05.000Z'
      },
      // mA3 failed earlier and is currently progressing -> excluded
      {
        id: 'f-a3-old',
        materialId: 'mA3',
        filename: '进行中.pdf',
        url: 'https://mooc1.chaoxing.com/a3',
        state: 'interrupted',
        receivedBytes: 0,
        totalBytes: 0,
        startedAt: '2026-01-01T07:00:00.000Z',
        completedAt: '2026-01-01T07:00:01.000Z'
      },
      {
        id: 'p-a3-now',
        materialId: 'mA3',
        filename: '进行中.pdf',
        url: 'https://mooc1.chaoxing.com/a3',
        state: 'progressing',
        receivedBytes: 100,
        totalBytes: 500,
        startedAt: '2026-01-03T07:00:00.000Z',
        completedAt: null
      },
      // Course B failure
      {
        id: 'f-b1',
        materialId: 'mB1',
        filename: '别课失败.pdf',
        url: 'https://mooc1.chaoxing.com/b1',
        state: 'interrupted',
        receivedBytes: 0,
        totalBytes: 0,
        startedAt: '2026-01-02T11:00:00.000Z',
        completedAt: '2026-01-02T11:00:01.000Z'
      }
    ]

    const allMaterials = [mA1, mA2, mA3, mB1]
    const allRetryable = selectRetryableFailedDownloads(downloads, [], { materials: allMaterials })
    expect(allRetryable.map((d) => d.id)).toEqual(['f-b1', 'f-a1-new', 'f-a2-old'])

    // Course A filter excludes Course B failure!
    const courseARetryable = selectRetryableFailedDownloads(downloads, [], {
      courseId: courseA.id,
      materials: allMaterials
    })
    expect(courseARetryable.map((d) => d.id)).toEqual(['f-a1-new', 'f-a2-old'])

    // Verified local files exclude even their newer failures from batch retry
    const withLocal = selectRetryableFailedDownloads(
      downloads,
      [
        {
          materialId: 'mA1',
          courseId: courseA.id,
          downloadId: 'old-ok',
          filename: '待重试.pdf',
          savePath: 'C:/Downloads/待重试.pdf',
          fileSize: 1024,
          downloadedAt: '2025-12-31T00:00:00.000Z'
        },
        {
          materialId: 'mA2',
          courseId: courseA.id,
          downloadId: 'old-ok-2',
          filename: '已恢复.pdf',
          savePath: 'C:/Downloads/已恢复.pdf',
          fileSize: 512,
          downloadedAt: '2025-12-31T00:00:00.000Z'
        }
      ],
      { courseId: courseA.id, materials: allMaterials }
    )
    expect(withLocal).toEqual([])
  })

  it('chunks 201 retry IDs into IPC-safe batches and merges their results', () => {
    const ids = Array.from({ length: 201 }, (_, index) => `download-${index}`)
    const chunks = chunkBatchRetryDownloadIds(ids)
    expect(chunks.map((chunk) => chunk.length)).toEqual([200, 1])
    expect(chunks[0]?.[0]).toBe('download-0')
    expect(chunks[1]?.[0]).toBe('download-200')

    const merged = mergeBatchRetryResults([
      {
        startedDownloadIds: ['download-0'],
        startedMaterialIds: ['material-0'],
        startedItems: [{ downloadId: 'download-0', materialId: 'material-0', filename: 'a.pdf' }],
        skipped: [],
        failed: []
      },
      {
        startedDownloadIds: ['download-200'],
        startedMaterialIds: ['material-200'],
        startedItems: [
          { downloadId: 'download-200', materialId: 'material-200', filename: 'b.pdf' }
        ],
        skipped: [{ id: 'download-x', reason: 'in_progress' }],
        failed: []
      }
    ])
    expect(merged.startedMaterialIds).toEqual(['material-0', 'material-200'])
    expect(merged.skipped).toEqual([{ id: 'download-x', reason: 'in_progress' }])
  })

  it('does not treat a historical completed download as a recovered local file', () => {
    const item = material({
      id: 'm1',
      courseId: courseA.id,
      externalId: 'material:701',
      name: '旧记录.pdf'
    })
    const failed: PortalDownload = {
      id: 'd-failed',
      materialId: item.id,
      filename: item.name,
      url: 'https://mooc1.chaoxing.com/1',
      state: 'interrupted',
      receivedBytes: 0,
      totalBytes: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z'
    }
    const oldCompleted: PortalDownload = {
      ...failed,
      id: 'd-old-completed',
      state: 'completed',
      receivedBytes: 100,
      totalBytes: 100,
      startedAt: '2025-12-31T00:00:00.000Z',
      completedAt: '2025-12-31T00:00:01.000Z'
    }

    expect(
      selectRetryableFailedDownloads([failed, oldCompleted], [], { materials: [item] })
    ).toEqual([failed])
    const summary = summarizeBatchTransferSession(
      [
        {
          downloadId: 'd-failed',
          materialId: item.id,
          name: item.name,
          terminalState: 'interrupted'
        }
      ],
      [],
      [oldCompleted],
      { materials: [item], localFiles: [] }
    )
    expect(summary.retryableTransferFailed.map((entry) => entry.downloadId)).toEqual(['d-failed'])
  })

  it('distinguishes dispatch failures from actual transfer failures in batch sessions', () => {
    const summary = summarizeBatchTransferSession(
      [
        { downloadId: 'd-ok', materialId: 'm1', name: '成功.pdf' },
        { downloadId: 'd-fail', materialId: 'm2', name: '传输失败.pdf' },
        { downloadId: 'd-busy', materialId: 'm3', name: '进行中.pdf' }
      ],
      [{ materialId: 'm4', name: '发起失败.pdf', error: '缺少 cpi' }],
      [
        {
          id: 'd-ok',
          materialId: 'm1',
          filename: '成功.pdf',
          url: 'https://mooc1.chaoxing.com/1',
          state: 'completed',
          receivedBytes: 100,
          totalBytes: 100,
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:02.000Z'
        },
        {
          id: 'd-fail',
          materialId: 'm2',
          filename: '传输失败.pdf',
          url: 'https://mooc1.chaoxing.com/2',
          state: 'interrupted',
          receivedBytes: 0,
          totalBytes: 0,
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:03.000Z'
        },
        {
          id: 'd-busy',
          materialId: 'm3',
          filename: '进行中.pdf',
          url: 'https://mooc1.chaoxing.com/3',
          state: 'progressing',
          receivedBytes: 20,
          totalBytes: 100,
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: null
        }
      ]
    )

    expect(summary.isSettled).toBe(false)
    expect(summary.succeeded.map((i) => i.materialId)).toEqual(['m1'])
    expect(summary.transferFailed.map((i) => i.materialId)).toEqual(['m2'])
    expect(summary.transferring.map((i) => i.materialId)).toEqual(['m3'])
    expect(summary.dispatchFailed.map((i) => i.materialId)).toEqual(['m4'])
    expect(summary.allFailedMaterialIds).toEqual(['m4', 'm2'])
    expect(summary.cleared).toEqual([])
    expect(summary.retryableFailedMaterialIds).toEqual(['m4', 'm2'])
  })

  it('preserves observed terminal batch states after queue clearing, marks unknown absent rows cleared, and drops recovered failures from retry', () => {
    const m1 = material({
      id: 'm1',
      courseId: courseA.id,
      externalId: 'material:501',
      name: '已完成.pdf'
    })
    const m2 = material({
      id: 'm2',
      courseId: courseA.id,
      externalId: 'material:502',
      name: '已失败后恢复.pdf'
    })
    const m3 = material({
      id: 'm3',
      courseId: courseA.id,
      externalId: 'material:503',
      name: '记录已清.pdf'
    })
    const m4 = material({
      id: 'm4',
      courseId: courseA.id,
      externalId: 'material:504',
      name: '发起失败后恢复.pdf'
    })

    // Queue was cleared (`downloads = []`): observed terminal states stay accurate; unknown missing record becomes `cleared` (NEVER `transferring`!)
    const afterClear = summarizeBatchTransferSession(
      [
        { downloadId: 'd-ok', materialId: 'm1', name: '已完成.pdf', terminalState: 'completed' },
        {
          downloadId: 'd-fail',
          materialId: 'm2',
          name: '已失败后恢复.pdf',
          terminalState: 'interrupted'
        },
        { downloadId: 'd-unknown', materialId: 'm3', name: '记录已清.pdf' }
      ],
      [{ materialId: 'm4', name: '发起失败后恢复.pdf', error: '网络异常' }],
      [],
      {
        courseId: courseA.id,
        materials: [m1, m2, m3, m4],
        localFiles: [
          // Both m2 and m4 have since been recovered via another entry and exist on disk
          {
            materialId: 'm2',
            courseId: courseA.id,
            downloadId: 'd-rec-2',
            filename: '已失败后恢复.pdf',
            savePath: 'C:/Downloads/已失败后恢复.pdf',
            fileSize: 1024,
            downloadedAt: '2026-01-02T00:00:00.000Z'
          },
          {
            materialId: 'm4',
            courseId: courseA.id,
            downloadId: 'd-rec-4',
            filename: '发起失败后恢复.pdf',
            savePath: 'C:/Downloads/发起失败后恢复.pdf',
            fileSize: 2048,
            downloadedAt: '2026-01-02T00:00:00.000Z'
          }
        ]
      }
    )

    expect(afterClear.isSettled).toBe(true)
    expect(afterClear.transferring).toEqual([])
    expect(afterClear.succeeded.map((i) => i.materialId)).toEqual(['m1'])
    expect(afterClear.transferFailed.map((i) => i.materialId)).toEqual(['m2'])
    expect(afterClear.cleared.map((i) => i.materialId)).toEqual(['m3'])
    // Both m2 and m4 were recovered -> zero retryable failures remain!
    expect(afterClear.retryableTransferFailed).toEqual([])
    expect(afterClear.retryableDispatchFailed).toEqual([])
    expect(afterClear.retryableFailedMaterialIds).toEqual([])
  })
})
