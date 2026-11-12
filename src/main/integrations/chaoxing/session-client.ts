import { net, session } from 'electron'
import type { Session } from 'electron'
import { PORTAL_PARTITION } from '@shared/constants'
import { isAllowedPortalUrl } from '../../portal/security'

export type SessionTransport = 'session_fetch' | 'net_request'

export interface SessionHttpRequest {
  url: string
  method?: 'GET' | 'POST'
  form?: Record<string, string>
  referer?: string
  accept?: string
  transport?: SessionTransport
}

export interface SessionHttpResponse {
  status: number
  finalUrl: string
  body: string
  transport: SessionTransport
}

export interface SessionHttpClient {
  request(input: SessionHttpRequest): Promise<SessionHttpResponse>
  countCookieDomains(): Promise<number>
}

const MAX_BODY_BYTES = 5 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 20_000

/**
 * 用 Portal 的持久 Session 发只读请求。
 *
 * 关键点：请求与 Portal WebContentsView 共用 `persist:studynext-portal`，
 * 因此用户本人在 Portal 里登录后，主进程不需要接触账号密码，也不需要把
 * Cookie 复制到 defaultSession。`session.fetch` 与 `net.request` 都显式
 * 要求携带 session 凭据（credentials: 'include'），并用 `useSessionCookies`
 * 作为兜底路径。
 */
export class PortalSessionHttpClient implements SessionHttpClient {
  constructor(
    private readonly getSession: () => Session = () => session.fromPartition(PORTAL_PARTITION)
  ) {}

  async request(input: SessionHttpRequest): Promise<SessionHttpResponse> {
    if (!isAllowedPortalUrl(input.url)) {
      throw new Error('请求地址不在学习通白名单内')
    }
    const transport = input.transport ?? 'session_fetch'
    if (transport === 'net_request') {
      return this.requestWithNet(input)
    }
    try {
      return await this.requestWithFetch(input)
    } catch (error) {
      // Chromium 偶尔会把跨子域 iframe 请求判为 blocked-by-client；
      // 同一 Session 的 net.request 走网络栈的另一条路径，作为只读兜底。
      if (input.transport) throw error
      return this.requestWithNet(input)
    }
  }

  /**
   * 只统计“有多少个 chaoxing/xuexitong 域下有 Cookie”，用于判断登录态是否
   * 跨子域生效；不读取、不返回任何 Cookie 值。
   */
  async countCookieDomains(): Promise<number> {
    const portalSession = this.getSession()
    const domains = new Set<string>()
    for (const filter of [{ domain: 'chaoxing.com' }, { domain: 'xuexitong.com' }]) {
      const cookies = await portalSession.cookies.get(filter)
      for (const cookie of cookies) {
        const domain = (cookie.domain ?? '').replace(/^\./, '').toLowerCase()
        if (domain === 'chaoxing.com' || domain.endsWith('.chaoxing.com')) domains.add(domain)
        if (domain === 'xuexitong.com' || domain.endsWith('.xuexitong.com')) domains.add(domain)
      }
    }
    return domains.size
  }

  private async requestWithFetch(input: SessionHttpRequest): Promise<SessionHttpResponse> {
    const portalSession = this.getSession()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await portalSession.fetch(input.url, {
        method: input.method ?? 'GET',
        headers: this.buildHeaders(portalSession, input),
        ...(input.form ? { body: new URLSearchParams(input.form).toString() } : {}),
        redirect: 'follow',
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal
      })
      const body = await readLimitedBody(response)
      return {
        status: response.status,
        finalUrl: response.url || input.url,
        body,
        transport: 'session_fetch'
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private requestWithNet(input: SessionHttpRequest): Promise<SessionHttpResponse> {
    const portalSession = this.getSession()
    return new Promise<SessionHttpResponse>((resolve, reject) => {
      const request = net.request({
        url: input.url,
        method: input.method ?? 'GET',
        session: portalSession,
        credentials: 'include',
        useSessionCookies: true,
        redirect: 'follow'
      })
      const headers = this.buildHeaders(portalSession, input)
      for (const [key, value] of Object.entries(headers)) request.setHeader(key, value)
      const timer = setTimeout(() => {
        request.abort()
        reject(new Error('请求超时'))
      }, REQUEST_TIMEOUT_MS)
      request.on('response', (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size <= MAX_BODY_BYTES) chunks.push(chunk)
        })
        response.on('end', () => {
          clearTimeout(timer)
          resolve({
            status: response.statusCode,
            finalUrl: input.url,
            body: Buffer.concat(chunks).toString('utf8'),
            transport: 'net_request'
          })
        })
        response.on('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
      })
      request.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      if (input.form) {
        request.setHeader('Content-Type', 'application/x-www-form-urlencoded')
        request.write(new URLSearchParams(input.form).toString())
      }
      request.end()
    })
  }

  private buildHeaders(
    portalSession: Session,
    input: SessionHttpRequest
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: input.accept ?? 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'User-Agent': portalSession.getUserAgent()
    }
    if (input.referer && isAllowedPortalUrl(input.referer)) headers.Referer = input.referer
    return headers
  }
}

async function readLimitedBody(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel()
      break
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(size > MAX_BODY_BYTES ? MAX_BODY_BYTES : size)
  let offset = 0
  for (const chunk of chunks) {
    const remaining = merged.length - offset
    if (remaining <= 0) break
    merged.set(chunk.subarray(0, remaining), offset)
    offset += Math.min(chunk.byteLength, remaining)
  }
  return new TextDecoder('utf-8').decode(merged)
}
