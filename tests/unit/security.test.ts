import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildPortalSecurityState,
  buildPortalWebPreferences,
  isAllowedPortalUrl,
  safeDisplayUrl
} from '../../src/main/portal/security'
import { StudyNextStore } from '../../src/main/storage/store'
import { ChaoxingAuthorizedAdapter, SyncService } from '../../src/main/integrations/sync'

let store: StudyNextStore

beforeEach(() => {
  store = new StudyNextStore(':memory:')
})

afterEach(() => {
  store.close()
})

describe('官方页面隔离层', () => {
  it('只允许学习通官方域名的 HTTPS 页面', () => {
    expect(isAllowedPortalUrl('https://i.chaoxing.com/')).toBe(true)
    expect(isAllowedPortalUrl('https://mooc1.chaoxing.com/visit/interaction')).toBe(true)
    expect(isAllowedPortalUrl('https://www.xuexitong.com/')).toBe(true)
    expect(isAllowedPortalUrl('https://chaoxing.com.evil.example/')).toBe(false)
    expect(isAllowedPortalUrl('http://i.chaoxing.com/')).toBe(false)
    expect(isAllowedPortalUrl('https://evil.example/?next=chaoxing.com')).toBe(false)
    expect(isAllowedPortalUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedPortalUrl('file:///C:/Windows/win.ini')).toBe(false)
  })

  it('网页视图关闭 Node、沙箱开启且使用独立持久化会话', () => {
    const prefs = buildPortalWebPreferences()
    expect(prefs.sandbox).toBe(true)
    expect(prefs.contextIsolation).toBe(true)
    expect(prefs.nodeIntegration).toBe(false)
    expect(prefs.nodeIntegrationInWorker).toBe(false)
    expect(prefs.nodeIntegrationInSubFrames).toBe(false)
    expect(prefs.webviewTag).toBe(false)
    expect(prefs.partition).toBe('persist:studynext-portal')
    expect(buildPortalSecurityState()).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      hasPreload: false
    })
  })

  it('展示 URL 时去除查询参数与 hash，避免泄露令牌', () => {
    expect(safeDisplayUrl('https://i.chaoxing.com/base?token=secret#/home')).toBe(
      'https://i.chaoxing.com/base'
    )
    expect(safeDisplayUrl('not a url')).toBe('')
  })
})

describe('授权同步适配器', () => {
  it('没有授权配置时返回 not_configured，绝不显示成功', async () => {
    const service = new SyncService(store)
    expect(service.getStatus().state).toBe('not_configured')
    const status = await service.run()
    expect(status.state).toBe('not_configured')
    expect(status.lastSuccessAt).toBeNull()
    expect(status.message).toContain('尚未配置')
    expect(new ChaoxingAuthorizedAdapter().isConfigured()).toBe(false)
  })

  it('适配器抛错时返回 failure，并保留本地数据', async () => {
    const failing = {
      id: 'test',
      source: 'chaoxing' as const,
      label: '测试适配器',
      isConfigured: () => true,
      pull: async () => {
        throw new Error('网络不可用')
      }
    }
    const service = new SyncService(store, failing)
    const before = store.listTasks().length
    const status = await service.run()
    expect(status.state).toBe('failure')
    expect(status.detail).toContain('网络不可用')
    expect(store.listTasks()).toHaveLength(before)
  })
})
