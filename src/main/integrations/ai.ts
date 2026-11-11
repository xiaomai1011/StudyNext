import { safeStorage } from 'electron'
import { DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL } from '@shared/constants'
import type { AiAnswer, AiConfig, AiConfigInput } from '@shared/types'
import { UserFacingError } from '../lib/errors'
import type { StudyNextStore } from '../storage/store'

interface StoredAiConfig {
  enabled: boolean
  baseUrl: string
  model: string
}

const AI_CONFIG_KEY = 'ai_config'
const AI_KEY_KEY = 'ai_api_key'

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

export class AiService {
  constructor(private readonly store: StudyNextStore) {}

  getConfig(): AiConfig {
    const stored = this.readStoredConfig()
    return {
      ...stored,
      hasApiKey: Boolean(this.store.getMeta(AI_KEY_KEY)),
      keyStorageAvailable: safeStorage.isEncryptionAvailable()
    }
  }

  updateConfig(input: AiConfigInput): AiConfig {
    const baseUrl = normalizeAiBaseUrl(input.baseUrl)
    if (input.apiKey && input.apiKey.trim()) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new UserFacingError(
          'SECURE_STORAGE_UNAVAILABLE',
          '当前系统安全存储不可用，API Key 未保存'
        )
      }
      const encrypted = safeStorage.encryptString(input.apiKey.trim()).toString('base64')
      this.store.setMeta(AI_KEY_KEY, encrypted)
    } else if (input.clearApiKey) {
      this.store.setMeta(AI_KEY_KEY, '')
    }
    const config: StoredAiConfig = {
      enabled: input.enabled,
      baseUrl,
      model: input.model.trim()
    }
    this.store.setMeta(AI_CONFIG_KEY, JSON.stringify(config))
    return this.getConfig()
  }

  async ask(question: string, courseId: string | null): Promise<AiAnswer> {
    const config = this.getConfig()
    if (!config.enabled) {
      throw new UserFacingError('AI_DISABLED', 'AI 助手尚未启用，请先在设置中配置')
    }
    const apiKey = this.readApiKey()
    if (!apiKey) {
      throw new UserFacingError('AI_KEY_MISSING', '尚未配置 API Key')
    }
    const course = courseId ? this.store.getCourse(courseId) : null
    const messages = buildAiMessages(question, course?.name ?? null)
    let response: Response
    try {
      response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0.3,
          max_tokens: 1400
        }),
        signal: AbortSignal.timeout(50_000)
      })
    } catch {
      throw new UserFacingError('AI_NETWORK_FAILED', '无法连接 AI 服务，请检查网络与 API 地址')
    }
    if (!response.ok) {
      throw new UserFacingError(
        'AI_HTTP_ERROR',
        `AI 服务返回 HTTP ${response.status}，请检查密钥、模型与额度`
      )
    }
    let payload: unknown
    try {
      payload = (await response.json()) as unknown
    } catch {
      throw new UserFacingError('AI_BAD_RESPONSE', 'AI 服务返回了无法解析的响应')
    }
    return parseAiCompletion(payload, config.model)
  }

  private readStoredConfig(): StoredAiConfig {
    const raw = this.store.getMeta(AI_CONFIG_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<StoredAiConfig>
        if (typeof parsed.enabled === 'boolean' && typeof parsed.baseUrl === 'string') {
          return {
            enabled: parsed.enabled,
            baseUrl: parsed.baseUrl,
            model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_AI_MODEL
          }
        }
      } catch {
        // Fall through to defaults.
      }
    }
    return { enabled: false, baseUrl: DEFAULT_AI_BASE_URL, model: DEFAULT_AI_MODEL }
  }

  private readApiKey(): string | null {
    const encrypted = this.store.getMeta(AI_KEY_KEY)
    if (!encrypted) return null
    if (!safeStorage.isEncryptionAvailable()) {
      throw new UserFacingError(
        'SECURE_STORAGE_UNAVAILABLE',
        '系统安全存储不可用，无法读取 API Key'
      )
    }
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      throw new UserFacingError('AI_KEY_INVALID', 'API Key 无法解密，请在设置中重新保存')
    }
  }
}

export function normalizeAiBaseUrl(value: string): string {
  const trimmed = value.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new UserFacingError('AI_URL_INVALID', '请输入有效的 API 地址')
  }
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost)) {
    throw new UserFacingError('AI_URL_INSECURE', 'API 地址必须使用 HTTPS（本地地址可使用 HTTP）')
  }
  if (url.username || url.password) {
    throw new UserFacingError('AI_URL_INVALID', 'API 地址不能包含账号或密码')
  }
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}`
}

export function buildAiMessages(question: string, courseName: string | null): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        '你是 StudyNext 的学习辅助助手。用简体中文回答，先说明解题思路和关键知识点，再给出结论。若题目条件不足，请指出缺少的条件。不要声称可以代替用户提交作业或参加考试，也不要编造不存在的教材页码。'
    },
    {
      role: 'user',
      content: `${courseName ? `课程：${courseName}\n` : ''}题目：${question.trim()}`
    }
  ]
}

export function parseAiCompletion(payload: unknown, fallbackModel: string): AiAnswer {
  if (!isRecord(payload)) {
    throw new UserFacingError('AI_BAD_RESPONSE', 'AI 服务返回格式不正确')
  }
  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new UserFacingError('AI_BAD_RESPONSE', 'AI 服务没有返回答案')
  }
  const first = choices[0]
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== 'string') {
    throw new UserFacingError('AI_BAD_RESPONSE', 'AI 服务没有返回可读答案')
  }
  const answer = first.message.content.trim()
  if (!answer) throw new UserFacingError('AI_BAD_RESPONSE', 'AI 返回了空答案')
  return {
    answer: answer.slice(0, 40_000),
    model: typeof payload.model === 'string' ? payload.model : fallbackModel
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
