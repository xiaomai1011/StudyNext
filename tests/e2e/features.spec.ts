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

async function open(label: string, title: string): Promise<void> {
  await page.locator('.nav-item', { hasText: label }).click()
  await expect(page.locator('.page-title')).toHaveText(title)
  await page.waitForTimeout(300)
}

test('学习中心、题目卡与本地快照导入完整可用', async () => {
  await open('学习中心', '学习中心')
  await expect(page.locator('.metric-note').filter({ hasText: '15 个章节' })).toBeVisible()
  await expect(page.locator('.study-metrics .metric-value').nth(1)).toHaveText('60')

  const doneBefore = await page.locator('.study-point.done').count()
  const nextPoint = page.locator('.study-point:not(.done)').first()
  await expect(nextPoint).toBeVisible()
  await nextPoint.click()
  await expect(page.locator('.study-point.done')).toHaveCount(doneBefore + 1)

  await open('题目助手', '题目助手')
  await page.getByRole('button', { name: '新建题目' }).click()
  const editor = page.locator('.modal')
  await expect(editor).toBeVisible()
  await editor.getByLabel('题目').fill('为什么二叉搜索树的中序遍历是有序的？')
  await editor.getByLabel('标签').fill('数据结构, 树')
  await editor.getByLabel('答案').fill('中序遍历按左子树、根、右子树的顺序访问。')
  await editor
    .getByLabel('解析')
    .fill('BST 的左子树键值小于根，右子树键值大于根，因此递归展开后得到升序序列。')
  await page.getByRole('button', { name: '保存题目', exact: true }).click()
  await expect(page.locator('.modal')).toHaveCount(0)
  await expect(page.locator('.question-card')).toContainText('为什么二叉搜索树的中序遍历是有序的？')

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

  await open('设置', '偏好与数据')
  await page.locator('input[type=file][accept*=".json"]').setInputFiles(snapshotPath)
  const snapshotResult = page
    .locator('.import-result')
    .filter({ hasText: '新增课程 1' })
    .filter({ hasText: '章节 1' })
  await expect(snapshotResult).toBeVisible()
  await expect(page.locator('.titlebar-status')).toContainText('本地快照 · 未连接学习通')

  await open('学习中心', '学习中心')
  const snapshotCourse = page.locator('.study-course').filter({ hasText: '测试快照课程' })
  await expect(snapshotCourse).toBeVisible()
  await snapshotCourse.click()
  await expect(page.locator('.study-point').filter({ hasText: '快照学习点' })).toHaveCount(1)
})

test('校园 SSO 域名设置保存并在重载后保留', async () => {
  await open('设置', '偏好与数据')
  const ssoDomains = page.locator('#sso-domains')
  await ssoDomains.fill('sso.example.edu.cn\nlogin.example.edu.cn')
  await page.getByRole('button', { name: '保存 SSO 域名' }).click()
  await expect(page.locator('.toast').filter({ hasText: '校园 SSO 域名已保存' })).toBeVisible()

  await page.reload()
  await page.waitForSelector('.app-shell')
  await open('设置', '偏好与数据')
  await expect(page.locator('#sso-domains')).toHaveValue('sso.example.edu.cn\nlogin.example.edu.cn')
})
