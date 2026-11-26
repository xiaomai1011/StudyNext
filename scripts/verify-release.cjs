const { existsSync, readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { MANIFEST_NAME, releasePaths, verifyReleaseArtifacts } = require('./release-integrity.cjs')

const root = resolve(__dirname, '..')
const packageJson = require(join(root, 'package.json'))
const releaseDir = resolve(root, process.argv[2] || 'release')
const version = packageJson.version
const manifestPath = join(releaseDir, MANIFEST_NAME)

let manifest = null
let manifestError = null
if (existsSync(manifestPath)) {
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    manifestError = error instanceof Error ? error.message : String(error)
  }
} else {
  manifestError = `缺少 ${MANIFEST_NAME}；必须在构建成功时由 generate-release-manifest.cjs 生成`
}

if (manifestError) {
  const paths = releasePaths(releaseDir, version)
  console.log(`FAIL release manifest: ${manifestPath} (${manifestError})`)
  console.log(`FAIL installer exists: ${paths.installer}`)
  console.log(`FAIL blockmap exists: ${paths.blockmap}`)
  process.exitCode = 1
} else {
  const result = verifyReleaseArtifacts({ releaseDir, version, manifest })
  for (const item of result.checks) {
    console.log(`${item.ok ? 'OK' : 'FAIL'} ${item.label}: ${item.detail}`)
  }
  const { installer, blockmap, unpackedExe, appAsar } = result.actual
  console.log(
    JSON.stringify({
      releaseDir,
      version,
      installerSize: installer?.size ?? 0,
      blockmapSize: blockmap?.size ?? 0,
      unpackedExeSize: unpackedExe?.size ?? 0,
      asarSize: appAsar?.size ?? 0,
      installerSha256: installer?.sha256 ?? null,
      blockmapSha256: blockmap?.sha256 ?? null,
      manifestGeneratedAt: manifest.generatedAt
    })
  )
  if (!result.ok) process.exitCode = 1
}
