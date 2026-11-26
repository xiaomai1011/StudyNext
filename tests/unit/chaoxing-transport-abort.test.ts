import { describe, expect, it, vi } from 'vitest'
import { ChaoxingSessionAdapter } from '../../src/main/integrations/chaoxing/adapter'
import { SessionRequestTimeoutError } from '../../src/main/integrations/chaoxing/session-client'

const BASE_HTML =
  '<title>个人空间</title><iframe id="frame_content"></iframe><div class="personalName">测试同学</div><p>示例大学</p><input id="uid" value="10001" />'

describe('ChaoxingSessionAdapter transport cancellation', () => {
  it('普通超时保留备用传输，不当作主动取消', async () => {
    const transports: string[] = []
    const client = {
      countCookieDomains: async () => 1,
      request: vi.fn(async ({ transport }: { transport: string }) => {
        transports.push(transport)
        if (transport === 'session_fetch') throw new SessionRequestTimeoutError()
        return {
          status: 200,
          finalUrl: 'https://i.chaoxing.com/base',
          body: BASE_HTML,
          transport: 'net_request' as const
        }
      })
    }
    const adapter = new ChaoxingSessionAdapter(client as never)

    const result = await adapter.checkSession()

    expect(transports).toEqual(['session_fetch', 'net_request'])
    expect(result.authState).toBe('authenticated')
  })

  it('外部 signal 取消立即停止，不再尝试备用传输', async () => {
    const controller = new AbortController()
    let calls = 0
    const client = {
      countCookieDomains: async () => 1,
      request: vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
        calls += 1
        await new Promise<never>((_resolve, reject) => {
          const fail = (): void => {
            const error = new Error('请求已取消')
            error.name = 'AbortError'
            reject(error)
          }
          if (signal?.aborted) {
            fail()
            return
          }
          signal?.addEventListener('abort', fail, { once: true })
        })
        return {
          status: 200,
          finalUrl: 'https://i.chaoxing.com/base',
          body: BASE_HTML,
          transport: 'session_fetch' as const
        }
      })
    }
    const adapter = new ChaoxingSessionAdapter(client as never)
    const promise = adapter.checkSession(controller.signal)

    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()

    await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(calls).toBe(1)
  })
})
