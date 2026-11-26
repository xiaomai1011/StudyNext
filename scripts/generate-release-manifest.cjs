const { writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { createReleaseManifest, MANIFEST_NAME } = require('./release-integrity.cjs')

const root = resolve(__dirname, '..')
const packageJson = require(join(root, 'package.json'))
const releaseDir = resolve(root, process.argv[2] || 'release')
const version = packageJson.version

const manifest = createReleaseManifest(releaseDir, version)
const manifestPath = join(releaseDir, MANIFEST_NAME)
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`Wrote ${manifestPath}`)
console.log(JSON.stringify(manifest))
