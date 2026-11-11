const { mkdirSync, mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { _electron: electron } = require('playwright')

async function main() {
  const root = process.cwd()
  mkdirSync(join(root, 'test-results'), { recursive: true })
  const dataDir = mkdtempSync(join(root, '.tmp-packaged-'))
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === 'string')
  )
  delete env.ELECTRON_RUN_AS_NODE
  env.STUDYNEXT_DATA_DIR = dataDir

  const app = await electron.launch({
    executablePath: join(root, 'release', 'win-unpacked', 'StudyNext.exe'),
    args: ['--no-sandbox', '--disable-gpu', `--user-data-dir=${dataDir}`],
    cwd: root,
    env
  })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('.app-shell', { timeout: 20000 })
    await page.waitForTimeout(450)
    const title = await page.locator('.page-title').textContent()
    const version = await page.locator('.sidebar-footer').textContent()
    await page.screenshot({ path: join(root, 'test-results', 'packaged.png') })
    console.log(JSON.stringify({ title, version, packaged: true }))
  } finally {
    await app.close().catch(() => undefined)
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
