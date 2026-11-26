import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'

const ROOT = process.cwd()

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let dataDir: string

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(ROOT, '.tmp-features-'))
  mkdirSync(dataDir, { recursive: true })
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
  env.STUDYNEXT_DATA_DIR = dataDir
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu', `--user-data-dir=${dataDir}`],
    cwd: ROOT,
    env
  })
  page = await app.firstWindow()
  await page.waitForSelector('.app-shell')
})

test.afterAll(async () => {
  if (app) await app.close()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

async function openCourses(): Promise<void> {
  await page.locator('.studio-pill-item', { hasText: '课程' }).click()
  await expect(page.locator('.studio-course-shell')).toBeVisible()
  await page.waitForTimeout(200)
}

async function openSettings(): Promise<void> {
  await page.locator('button[aria-label="设置"]').click()
  await expect(page.locator('.page-title')).toHaveText('偏好与数据')
  await page.waitForTimeout(200)
}

test('课程章节学习点、本地快照导入完整可用，且 AI 解题助手已彻底下线', async () => {
  const hasAiOrQuestions = await page.evaluate(() => ({
    questions: 'questions' in window.studynext,
    ai: 'ai' in window.studynext
  }))
  expect(hasAiOrQuestions).toEqual({ questions: false, ai: false })

  await openCourses()
  await page.getByRole('button', { name: /全部展开/ }).click()

  const doneBefore = await page.locator('.study-point.done').count()
  const nextPoint = page.locator('.study-point:not(.done)').first()
  await expect(nextPoint).toBeVisible()
  await nextPoint.click()
  await expect(page.locator('.study-point.done')).toHaveCount(doneBefore + 1)

  const snapshotPath = join(dataDir, 'snapshot.json')
  writeFileSync(
    snapshotPath,
    JSON.stringify({
      source: 'e2e-fixture',
      courses: [
        {
          id: 'snapshot-course',
          name: '测试快照课程',
          teacher: '快照教师',
          chapters: [
            {
              id: 'snapshot-chapter',
              title: '快照章节',
              points: [
                {
                  id: 'snapshot-point',
                  title: '快照学习点',
                  type: 'reading',
                  completed: true
                }
              ]
            }
          ],
          homeworks: [
            {
              id: 'snapshot-homework',
              title: '快照作业',
              deadline: '2031-01-02T12:00:00+08:00'
            }
          ]
        }
      ]
    }),
    'utf8'
  )

  await openSettings()
  await page.locator('input[type=file][accept*=".json"]').setInputFiles(snapshotPath)
  const snapshotResult = page
    .locator('.import-result')
    .filter({ hasText: '新增课程 1' })
    .filter({ hasText: '章节 1' })
  await expect(snapshotResult).toBeVisible()
  await expect(page.locator('.titlebar-status')).toHaveAttribute(
    'aria-label',
    /本地快照 · 未连接学习通/
  )

  await openCourses()
  const snapshotCourse = page.locator('.course-rail-item').filter({ hasText: '测试快照课程' })
  await expect(snapshotCourse).toBeVisible()
  await snapshotCourse.click()
  await expect(page.locator('.study-point').filter({ hasText: '快照学习点' })).toHaveCount(1)
})

test('校园 SSO 域名设置保存并在重载后保留', async () => {
  await openSettings()
  const ssoDomains = page.locator('#sso-domains')
  await ssoDomains.fill('sso.example.edu.cn\nlogin.example.edu.cn')
  await page.getByRole('button', { name: '保存 SSO 域名' }).click()
  await expect(page.locator('.toast').filter({ hasText: '校园 SSO 域名已保存' })).toBeVisible()

  await page.reload()
  await page.waitForSelector('.app-shell')
  await openSettings()
  await expect(page.locator('#sso-domains')).toHaveValue('sso.example.edu.cn\nlogin.example.edu.cn')
})
