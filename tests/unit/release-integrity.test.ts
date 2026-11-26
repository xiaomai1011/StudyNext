import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import { blake2b } from '@noble/hashes/blake2.js'

const integrity = createRequire(__filename)('../../scripts/release-integrity.cjs') as {
  createReleaseManifest: (releaseDir: string, version: string, now?: Date) => ReleaseManifest
  verifyReleaseArtifacts: (input: {
    releaseDir: string
    version: string
    manifest: ReleaseManifest | null
    requireManifest?: boolean
  }) => {
    ok: boolean
    checks: Array<{ label: string; ok: boolean; detail: string }>
  }
}

interface ReleaseManifest {
  schemaVersion: number
  version: string
  generatedAt: string
  installer: { file: string; size: number; sha256: string }
  blockmap: { file: string; size: number; sha256: string }
}

const VERSION = '0.5.0'
const roots: string[] = []

function makeBlockmap(installer: Buffer): Buffer {
  const checksum = Buffer.from(blake2b(installer, { dkLen: 18 })).toString('base64')
  return gzipSync(
    Buffer.from(
      JSON.stringify({
        version: '2',
        files: [{ name: 'file', offset: 0, checksums: [checksum], sizes: [installer.length] }]
      })
    )
  )
}

function makeReleaseDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'studynext-release-'))
  roots.push(root)
  mkdirSync(join(root, 'win-unpacked', 'resources'), { recursive: true })
  const installer = Buffer.from('MZ' + 'installer')
  writeFileSync(join(root, `StudyNext-Setup-${VERSION}.exe`), installer)
  writeFileSync(join(root, `StudyNext-Setup-${VERSION}.exe.blockmap`), makeBlockmap(installer))
  writeFileSync(join(root, 'win-unpacked', 'StudyNext.exe'), Buffer.from('MZ' + 'unpacked'))
  writeFileSync(join(root, 'win-unpacked', 'resources', 'app.asar'), Buffer.from('asar'))
  return root
}

function check(root: string, manifest: ReleaseManifest | null) {
  return integrity.verifyReleaseArtifacts({ releaseDir: root, version: VERSION, manifest })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('release-integrity build manifest', () => {
  it('accepts a complete release with a matching build-time manifest', () => {
    const root = makeReleaseDir()
    const manifest = integrity.createReleaseManifest(root, VERSION)
    expect(check(root, manifest).ok).toBe(true)
  })

  it('rejects a release without a manifest', () => {
    const root = makeReleaseDir()
    const result = check(root, null)
    expect(result.ok).toBe(false)
    expect(result.checks.some((item) => item.label === 'release manifest exists' && !item.ok)).toBe(
      true
    )
  })

  it('rejects a truncated installer even when the manifest was generated before truncation', () => {
    const root = makeReleaseDir()
    const manifest = integrity.createReleaseManifest(root, VERSION)
    writeFileSync(join(root, `StudyNext-Setup-${VERSION}.exe`), Buffer.from('MZ'))
    const result = check(root, manifest)
    expect(result.ok).toBe(false)
    expect(
      result.checks.some(
        (item) => item.label === 'installer size matches build manifest' && !item.ok
      )
    ).toBe(true)
  })

  it('rejects a manifest with the wrong installer size or sha256', () => {
    const root = makeReleaseDir()
    const manifest = integrity.createReleaseManifest(root, VERSION)
    manifest.installer.size += 1
    expect(check(root, manifest).ok).toBe(false)

    const manifest2 = integrity.createReleaseManifest(root, VERSION)
    manifest2.installer.sha256 = '0'.repeat(64)
    expect(check(root, manifest2).ok).toBe(false)
  })

  it('rejects a mismatched blockmap and malformed checksum fields', () => {
    const root = makeReleaseDir()
    const manifest = integrity.createReleaseManifest(root, VERSION)
    const malformed = integrity.createReleaseManifest(root, VERSION)
    writeFileSync(
      join(root, `StudyNext-Setup-${VERSION}.exe.blockmap`),
      Buffer.from('different-blockmap')
    )
    expect(check(root, manifest).ok).toBe(false)

    malformed.blockmap.sha256 = 'not-a-sha256'
    expect(check(root, malformed).ok).toBe(false)
  })

  it('rejects malformed or non-covering blockmaps before generating a manifest', () => {
    const root = makeReleaseDir()
    const installerPath = join(root, `StudyNext-Setup-${VERSION}.exe`)
    const blockmapPath = join(root, `StudyNext-Setup-${VERSION}.exe.blockmap`)

    writeFileSync(blockmapPath, Buffer.from('not-gzip'))
    expect(() => integrity.createReleaseManifest(root, VERSION)).toThrow(/blockmap 校验失败/)

    const installer = Buffer.from('MZ' + 'another-installer')
    writeFileSync(installerPath, installer)
    writeFileSync(blockmapPath, makeBlockmap(Buffer.from('MZ' + 'wrong-installer')))
    expect(() => integrity.createReleaseManifest(root, VERSION)).toThrow(/blockmap 校验失败/)

    writeFileSync(blockmapPath, makeBlockmap(installer))
    writeFileSync(installerPath, Buffer.from('MZ'))
    expect(() => integrity.createReleaseManifest(root, VERSION)).toThrow(/blockmap 校验失败/)
  })
})
