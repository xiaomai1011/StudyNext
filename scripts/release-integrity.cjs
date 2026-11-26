const { createHash } = require('node:crypto')
const { existsSync, readFileSync, statSync } = require('node:fs')
const { join } = require('node:path')
const { gunzipSync } = require('node:zlib')
const { blake2b } = require('@noble/hashes/blake2.js')

const MANIFEST_NAME = 'release-manifest.json'

function releasePaths(releaseDir, version) {
  return {
    installer: join(releaseDir, `StudyNext-Setup-${version}.exe`),
    blockmap: join(releaseDir, `StudyNext-Setup-${version}.exe.blockmap`),
    unpackedExe: join(releaseDir, 'win-unpacked', 'StudyNext.exe'),
    appAsar: join(releaseDir, 'win-unpacked', 'resources', 'app.asar')
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase()
}

function fileInfo(path) {
  if (!existsSync(path)) return null
  return {
    path,
    size: statSync(path).size,
    sha256: sha256File(path)
  }
}

function isMz(path) {
  if (!existsSync(path)) return false
  const header = readFileSync(path)
  return header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a
}

function blockChecksum(chunk) {
  return Buffer.from(blake2b(chunk, { dkLen: 18 })).toString('base64')
}

function inspectBlockmap(installerPath, blockmapPath) {
  if (!existsSync(installerPath)) return { ok: false, detail: `缺少安装包：${installerPath}` }
  if (!existsSync(blockmapPath)) return { ok: false, detail: `缺少 blockmap：${blockmapPath}` }

  let payload
  try {
    payload = JSON.parse(gunzipSync(readFileSync(blockmapPath)).toString('utf8'))
  } catch (error) {
    return { ok: false, detail: `blockmap 无法解压/解析：${error.message}` }
  }

  if (
    !payload ||
    payload.version !== '2' ||
    !Array.isArray(payload.files) ||
    payload.files.length !== 1
  ) {
    return { ok: false, detail: 'blockmap 必须是 version=2 且仅包含一个文件' }
  }
  const file = payload.files[0]
  if (!file || file.name !== 'file' || file.offset !== 0) {
    return { ok: false, detail: 'blockmap 文件项必须是 name=file、offset=0' }
  }
  if (!Array.isArray(file.sizes) || !Array.isArray(file.checksums) || file.sizes.length === 0) {
    return { ok: false, detail: 'blockmap 缺少 sizes/checksums' }
  }
  if (file.sizes.length !== file.checksums.length) {
    return { ok: false, detail: 'blockmap 的 sizes/checksums 数量不一致' }
  }

  const installer = readFileSync(installerPath)
  let offset = 0
  let minBlock = Number.POSITIVE_INFINITY
  let maxBlock = 0
  for (let index = 0; index < file.sizes.length; index += 1) {
    const size = file.sizes[index]
    const checksum = file.checksums[index]
    if (!Number.isSafeInteger(size) || size <= 0) {
      return { ok: false, detail: `block ${index} 的 size 不是正整数` }
    }
    if (typeof checksum !== 'string' || checksum.length !== 24) {
      return { ok: false, detail: `block ${index} 的 checksum 不是 24 字符串` }
    }
    if (offset + size > installer.length) {
      return { ok: false, detail: `block ${index} 超出安装包范围` }
    }
    const actual = blockChecksum(installer.subarray(offset, offset + size))
    if (actual !== checksum) {
      return { ok: false, detail: `block ${index} 校验和不匹配` }
    }
    minBlock = Math.min(minBlock, size)
    maxBlock = Math.max(maxBlock, size)
    offset += size
  }
  if (offset !== installer.length) {
    return { ok: false, detail: `blockmap 覆盖 ${offset} 字节，安装包为 ${installer.length} 字节` }
  }
  return {
    ok: true,
    detail: `blocks=${file.sizes.length} bytes=${offset} min=${minBlock} max=${maxBlock}`
  }
}

function createReleaseManifest(releaseDir, version, now = new Date()) {
  const paths = releasePaths(releaseDir, version)
  const installer = fileInfo(paths.installer)
  const blockmap = fileInfo(paths.blockmap)
  if (!installer) throw new Error(`缺少安装包：${paths.installer}`)
  if (!blockmap) throw new Error(`缺少 blockmap：${paths.blockmap}`)
  const coverage = inspectBlockmap(paths.installer, paths.blockmap)
  if (!coverage.ok) throw new Error(`blockmap 校验失败，拒绝生成清单：${coverage.detail}`)
  return {
    schemaVersion: 1,
    version,
    generatedAt: now.toISOString(),
    installer: {
      file: `StudyNext-Setup-${version}.exe`,
      size: installer.size,
      sha256: installer.sha256
    },
    blockmap: {
      file: `StudyNext-Setup-${version}.exe.blockmap`,
      size: blockmap.size,
      sha256: blockmap.sha256
    }
  }
}

function validateManifest(manifest, version) {
  const errors = []
  if (!manifest || typeof manifest !== 'object') {
    return ['缺少 release-manifest.json 或格式不是对象']
  }
  if (manifest.schemaVersion !== 1) errors.push('manifest.schemaVersion 必须为 1')
  if (manifest.version !== version) errors.push(`manifest.version 必须是 ${version}`)
  if (typeof manifest.generatedAt !== 'string' || Number.isNaN(Date.parse(manifest.generatedAt))) {
    errors.push('manifest.generatedAt 必须是有效 ISO 时间')
  }
  for (const [key, expectedFile] of [
    ['installer', `StudyNext-Setup-${version}.exe`],
    ['blockmap', `StudyNext-Setup-${version}.exe.blockmap`]
  ]) {
    const item = manifest[key]
    if (!item || typeof item !== 'object') {
      errors.push(`manifest.${key} 缺失`)
      continue
    }
    if (item.file !== expectedFile) errors.push(`manifest.${key}.file 必须是 ${expectedFile}`)
    if (!Number.isSafeInteger(item.size) || item.size <= 0) {
      errors.push(`manifest.${key}.size 必须是正整数`)
    }
    if (typeof item.sha256 !== 'string' || !/^[0-9A-F]{64}$/.test(item.sha256)) {
      errors.push(`manifest.${key}.sha256 必须是 64 位十六进制大写字符串`)
    }
  }
  return errors
}

function verifyReleaseArtifacts({ releaseDir, version, manifest, requireManifest = true }) {
  const checks = []
  const manifestErrors = validateManifest(manifest, version)
  if (!manifest) {
    if (requireManifest) {
      checks.push({
        label: 'release manifest exists',
        ok: false,
        detail: join(releaseDir, MANIFEST_NAME)
      })
    }
  } else {
    checks.push({
      label: 'release manifest is valid',
      ok: manifestErrors.length === 0,
      detail: manifestErrors.join('；') || join(releaseDir, MANIFEST_NAME)
    })
  }

  const paths = releasePaths(releaseDir, version)
  const installer = fileInfo(paths.installer)
  const blockmap = fileInfo(paths.blockmap)
  const unpackedExe = fileInfo(paths.unpackedExe)
  const appAsar = fileInfo(paths.appAsar)

  checks.push({
    label: 'installer exists',
    ok: Boolean(installer),
    detail: paths.installer
  })
  checks.push({
    label: 'installer has MZ header',
    ok: isMz(paths.installer),
    detail: paths.installer
  })
  checks.push({
    label: 'blockmap exists',
    ok: Boolean(blockmap),
    detail: paths.blockmap
  })
  const blockmapCoverage = inspectBlockmap(paths.installer, paths.blockmap)
  checks.push({
    label: 'blockmap covers installer with valid block checksums',
    ok: blockmapCoverage.ok,
    detail: blockmapCoverage.detail
  })
  checks.push({
    label: 'win-unpacked executable exists',
    ok: Boolean(unpackedExe),
    detail: paths.unpackedExe
  })
  checks.push({
    label: 'win-unpacked executable has MZ header',
    ok: isMz(paths.unpackedExe),
    detail: paths.unpackedExe
  })
  checks.push({
    label: 'app.asar exists',
    ok: Boolean(appAsar),
    detail: paths.appAsar
  })

  if (manifest && manifestErrors.length === 0) {
    checks.push({
      label: 'installer size matches build manifest',
      ok: Boolean(installer) && installer.size === manifest.installer.size,
      detail: `actual=${installer?.size ?? 'missing'} expected=${manifest.installer.size}`
    })
    checks.push({
      label: 'installer sha256 matches build manifest',
      ok: Boolean(installer) && installer.sha256 === manifest.installer.sha256,
      detail: `actual=${installer?.sha256 ?? 'missing'} expected=${manifest.installer.sha256}`
    })
    checks.push({
      label: 'blockmap size matches build manifest',
      ok: Boolean(blockmap) && blockmap.size === manifest.blockmap.size,
      detail: `actual=${blockmap?.size ?? 'missing'} expected=${manifest.blockmap.size}`
    })
    checks.push({
      label: 'blockmap sha256 matches build manifest',
      ok: Boolean(blockmap) && blockmap.sha256 === manifest.blockmap.sha256,
      detail: `actual=${blockmap?.sha256 ?? 'missing'} expected=${manifest.blockmap.sha256}`
    })
  }

  return {
    ok: checks.every((item) => item.ok),
    checks,
    actual: {
      releaseDir,
      version,
      installer,
      blockmap,
      unpackedExe,
      appAsar,
      manifestPath: join(releaseDir, MANIFEST_NAME)
    }
  }
}

module.exports = {
  MANIFEST_NAME,
  createReleaseManifest,
  fileInfo,
  inspectBlockmap,
  releasePaths,
  verifyReleaseArtifacts
}
