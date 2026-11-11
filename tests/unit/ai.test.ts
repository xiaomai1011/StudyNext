import { describe, expect, it } from 'vitest'
import {
  buildAiMessages,
  normalizeAiBaseUrl,
  parseAiCompletion
} from '../../src/main/integrations/ai'

describe('AI 助手配置与响应处理', () => {
  it('仅允许 HTTPS API 地址，保留版本路径', () => {
    expect(normalizeAiBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1')
    expect(normalizeAiBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1')
    expect(() => normalizeAiBaseUrl('http://api.example.com/v1')).toThrow('HTTPS')
    expect(() => normalizeAiBaseUrl('file:///tmp/key')).toThrow('HTTPS')
  })

  it('构造带课程上下文的提示词，不包含密钥', () => {
    const messages = buildAiMessages('求导公式是什么？', '高等数学')
    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('system')
    expect(messages[1]?.content).toContain('课程：高等数学')
    expect(messages[1]?.content).toContain('求导公式是什么')
    expect(JSON.stringify(messages)).not.toContain('sk-')
  })

  it('解析 OpenAI 兼容响应并拒绝空答案', () => {
    const result = parseAiCompletion(
      {
        model: 'test-model',
        choices: [{ message: { content: '  答案是 42。  ' } }]
      },
      'fallback'
    )
    expect(result).toEqual({ answer: '答案是 42。', model: 'test-model' })
    expect(() => parseAiCompletion({ choices: [] }, 'fallback')).toThrow('没有返回答案')
  })
})
