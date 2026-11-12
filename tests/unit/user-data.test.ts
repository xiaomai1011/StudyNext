import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureUserDataDirectory, userDataPathCandidates } from '../../src/main/lib/user-data'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'studynext-user-data-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

describe('本地数据目录策略', () => {
  it('Windows 只在持久化目录中按优先级选择，不使用临时目录', () => {
    const root = tempRoot()
    const candidates = userDataPathCandidates({
      platform: 'win32',
      appData: join(root, 'Roaming'),
      localAppData: join(root, 'Local')
    })
    expect(candidates).toEqual([
      join(root, 'Local', 'StudyNext'),
      join(root, 'Roaming', 'StudyNext')
    ])
  })

  it('显式 STUDYNEXT_DATA_DIR 只使用指定路径', () => {
    const root = tempRoot()
    const override = join(root, 'custom-data')
    expect(
      userDataPathCandidates({
        platform: 'win32',
        appData: 'C:\\ignored',
        localAppData: 'C:\\ignored-local',
        override
      })
    ).toEqual([override])
  })

  it('优先使用第一个可创建的目录', () => {
    const root = tempRoot()
    const first = join(root, 'first')
    const second = join(root, 'second')
    expect(ensureUserDataDirectory([first, second])).toBe(first)
  })

  it('目录创建失败时抛错，不静默回退', () => {
    const root = tempRoot()
    const blocked = join(root, 'blocked')
    writeFileSync(blocked, 'not a directory')
    expect(() => ensureUserDataDirectory([blocked])).toThrow(/无法创建本地数据目录/)
  })
})
