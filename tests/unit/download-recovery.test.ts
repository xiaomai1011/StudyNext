import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PortalDownload } from '../../src/shared/types'
import {
  recoverDownloads,
  type DownloadRecoveryStore
} from '../../src/main/portal/download-recovery'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studynext-downloads-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function download(id: string, savePath: string): PortalDownload {
  return {
    id,
    filename: `${id}.pdf`,
    url: `https://example.invalid/${id}.pdf`,
    state: 'progressing',
    receivedBytes: 12,
    totalBytes: 100,
    startedAt: '2026-11-16T10:00:00.000Z',
    completedAt: null,
    savePath
  }
}

function fakeStore(
  readOnly: boolean,
  items: PortalDownload[]
): DownloadRecoveryStore & {
  upserts: PortalDownload[]
} {
  const upserts: PortalDownload[] = []
  return {
    readOnly,
    upserts,
    listDownloads: () => items,
    upsertDownload: (item) => {
      upserts.push(item)
    }
  }
}

describe('下载恢复的只读安全', () => {
  it('只读历史工作区把进行中下载标为中断，但不删文件、不写数据库', () => {
    const dir = tempDir()
    const file = join(dir, 'partial.pdf')
    writeFileSync(file, 'partial')
    const store = fakeStore(true, [download('readonly-download', file)])
    const result = recoverDownloads(store)
    expect(result.get('readonly-download')?.state).toBe('interrupted')
    expect(store.upserts).toHaveLength(0)
    expect(existsSync(file)).toBe(true)
    expect(() => recoverDownloads(store)).not.toThrow()
  })

  it('可写工作区清理未完成临时文件并持久化中断状态', () => {
    const dir = tempDir()
    const file = join(dir, 'partial.pdf')
    writeFileSync(file, 'partial')
    const store = fakeStore(false, [download('writable-download', file)])
    const result = recoverDownloads(store)
    expect(result.get('writable-download')?.state).toBe('interrupted')
    expect(store.upserts).toHaveLength(1)
  })
})
