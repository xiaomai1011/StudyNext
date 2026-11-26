import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StudyNextStore } from '../../src/main/storage/store'
import {
  invalidateMissingDownloadLocalFile,
  recordCompletedMaterialLocalFile,
  resolveVerifiedMaterialLocalFile,
  resolveVerifiedMaterialLocalFiles
} from '../../src/main/materials/local-files'

const tempDirs: string[] = []
const stores: StudyNextStore[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(process.cwd(), '.tmp-unit-local-files-'))
  tempDirs.push(dir)
  return dir
}

function openStore(dbPath: string, readOnly = false): StudyNextStore {
  const store = new StudyNextStore(dbPath, { readOnly })
  stores.push(store)
  return store
}

afterEach(() => {
  while (stores.length > 0) {
    try {
      stores.pop()?.close()
    } catch {
      // Already closed earlier in the test to simulate restart.
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

function seedCourseAndMaterial(
  store: StudyNextStore,
  courseExtId: string,
  materialExtId: string,
  name: string
): { courseId: string; materialId: string } {
  const { course } = store.upsertProviderCourse({
    externalId: courseExtId,
    name: `课程 ${courseExtId}`,
    teacher: '张老师',
    sourceUrl: `https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=${courseExtId}&clazzid=1&cpi=1`,
    clazzId: '1'
  })
  store.replaceProviderMaterials(course.id, [
    {
      externalId: materialExtId,
      name,
      kind: 'file',
      fileType: 'pdf',
      size: '1 MB',
      sourceUrl: `https://p.ananas.chaoxing.com/star3/origin/${materialExtId}.pdf`
    }
  ])
  const mat = store
    .listMaterials()
    .find((item) => item.courseId === course.id && item.externalId === materialExtId)
  if (!mat) throw new Error('material missing')
  return { courseId: course.id, materialId: mat.id }
}

describe('persistent verified material local files', () => {
  it('survives queue clearing without deleting user files and drops missing files after manual deletion', () => {
    const dir = makeTempDir()
    const dbPath = join(dir, 'workspace.sqlite')
    const store = openStore(dbPath)
    const { materialId } = seedCourseAndMaterial(store, '100:1', 'material:1001', '第一章.pdf')

    const filePath = join(dir, '第一章.pdf')
    writeFileSync(filePath, '%PDF-1.4 chapter 1')

    const completedDownload = {
      id: 'dl-1',
      filename: '第一章.pdf',
      url: 'https://mooc1.chaoxing.com/coursedata/downloadData?dataId=1001',
      state: 'completed' as const,
      receivedBytes: 18,
      totalBytes: 18,
      startedAt: '2026-11-20T10:00:00.000Z',
      completedAt: '2026-11-20T10:00:02.000Z',
      savePath: filePath,
      materialId
    }
    store.upsertDownload(completedDownload)
    const saved = recordCompletedMaterialLocalFile(store, completedDownload)
    expect(saved?.materialId).toBe(materialId)

    // Clear finished downloads from queue: queue becomes empty, user file stays intact, local copy remains verified
    store.deleteFinishedDownloads(['dl-1'])
    expect(store.listDownloads()).toHaveLength(0)
    expect(existsSync(filePath)).toBe(true)

    const afterClear = resolveVerifiedMaterialLocalFiles(store, dir)
    expect(afterClear).toHaveLength(1)
    expect(afterClear[0]?.materialId).toBe(materialId)
    expect(afterClear[0]?.savePath).toBe(filePath)

    // Manually delete file on disk -> no longer recognized as available local file, stale row pruned
    unlinkSync(filePath)
    expect(resolveVerifiedMaterialLocalFiles(store, dir)).toEqual([])
    expect(resolveVerifiedMaterialLocalFile(store, dir, materialId)).toBeNull()
    expect(store.listMaterialLocalFiles()).toEqual([])
  })

  it('recovers completed downloads beyond the 100-row queue cap across restarts and enforces workspace isolation', () => {
    const dir = makeTempDir()
    const dbPathA = join(dir, 'account-a.sqlite')
    const dbPathB = join(dir, 'account-b.sqlite')

    const storeA = openStore(dbPathA)
    const { materialId: matA } = seedCourseAndMaterial(
      storeA,
      '200:1',
      'material:2001',
      '历史讲义.pdf'
    )
    const fileA = join(dir, '历史讲义.pdf')
    writeFileSync(fileA, '%PDF-1.4 legacy copy')

    // Seed old completed download ONLY in `downloads` (simulating pre-N-006-R legacy data) + 110 newer downloads
    storeA.upsertDownload({
      id: 'dl-legacy-1',
      filename: '历史讲义.pdf',
      url: 'https://mooc1.chaoxing.com/coursedata/downloadData?dataId=2001',
      state: 'completed',
      receivedBytes: 20,
      totalBytes: 20,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:05.000Z',
      savePath: fileA,
      materialId: matA
    })
    for (let i = 0; i < 110; i += 1) {
      const ts = new Date(Date.parse('2026-02-01T00:00:00.000Z') + i * 60_000).toISOString()
      storeA.upsertDownload({
        id: `dl-filler-${i}`,
        filename: `other-${i}.pdf`,
        url: `https://mooc1.chaoxing.com/other/${i}`,
        state: 'interrupted',
        receivedBytes: 0,
        totalBytes: 0,
        startedAt: ts,
        completedAt: ts
      })
    }
    storeA.close()

    // Reopen storeA (restart): queue(100) no longer contains dl-legacy-1, yet local-file resolver recovers it!
    const reopenedA = openStore(dbPathA)
    expect(reopenedA.listDownloads(100).some((item) => item.id === 'dl-legacy-1')).toBe(false)

    const verifiedA = resolveVerifiedMaterialLocalFiles(reopenedA, dir)
    expect(verifiedA).toHaveLength(1)
    expect(verifiedA[0]?.materialId).toBe(matA)
    expect(verifiedA[0]?.savePath).toBe(fileA)
    // Backfilled into independent table so even clearing all downloads keeps it
    expect(reopenedA.listMaterialLocalFiles()).toHaveLength(1)

    // Read-only reopen also works cleanly without throwing
    const readOnlyA = openStore(dbPathA, true)
    expect(resolveVerifiedMaterialLocalFiles(readOnlyA, dir)).toHaveLength(1)

    // Separate account workspace B never sees account A's local file
    const storeB = openStore(dbPathB)
    seedCourseAndMaterial(storeB, '200:1', 'material:2001', '历史讲义.pdf')
    expect(resolveVerifiedMaterialLocalFiles(storeB, dir)).toEqual([])
  })

  it('invalidates only the matching missing download/path and never wipes a newer valid copy index', () => {
    const dir = makeTempDir()
    const store = openStore(join(dir, 'multi-copy.sqlite'))
    const { materialId } = seedCourseAndMaterial(store, '300:1', 'material:3001', '双副本讲义.pdf')

    const oldPath = join(dir, '双副本讲义.pdf')
    const newPath = join(dir, '双副本讲义 (1).pdf')
    writeFileSync(oldPath, '%PDF-1.4 old')
    writeFileSync(newPath, '%PDF-1.4 new')

    const oldDl = {
      id: 'dl-old',
      filename: '双副本讲义.pdf',
      url: 'https://mooc1.chaoxing.com/coursedata/downloadData?dataId=3001',
      state: 'completed' as const,
      receivedBytes: 12,
      totalBytes: 12,
      startedAt: '2026-11-20T10:00:00.000Z',
      completedAt: '2026-11-20T10:00:01.000Z',
      savePath: oldPath,
      materialId
    }
    const newDl = {
      id: 'dl-new',
      filename: '双副本讲义 (1).pdf',
      url: 'https://mooc1.chaoxing.com/coursedata/downloadData?dataId=3001',
      state: 'completed' as const,
      receivedBytes: 12,
      totalBytes: 12,
      startedAt: '2026-11-21T10:00:00.000Z',
      completedAt: '2026-11-21T10:00:01.000Z',
      savePath: newPath,
      materialId
    }
    store.upsertDownload(oldDl)
    store.upsertDownload(newDl)
    recordCompletedMaterialLocalFile(store, oldDl)
    recordCompletedMaterialLocalFile(store, newDl)

    // Delete old copy only, keeping new copy on disk
    unlinkSync(oldPath)
    const changed = invalidateMissingDownloadLocalFile(store, dir, oldDl, oldPath)
    expect(changed).toBe(false)
    const remaining = resolveVerifiedMaterialLocalFile(store, dir, materialId)
    expect(remaining?.downloadId).toBe('dl-new')
    expect(remaining?.savePath).toBe(newPath)

    // Now delete the active new copy -> invalidating dl-new clears the stale index cleanly
    unlinkSync(newPath)
    const changedAfterNewMissing = invalidateMissingDownloadLocalFile(store, dir, newDl, newPath)
    expect(changedAfterNewMissing).toBe(true)
    expect(resolveVerifiedMaterialLocalFile(store, dir, materialId)).toBeNull()
  })
})
