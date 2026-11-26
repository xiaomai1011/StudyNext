import { describe, expect, it } from 'vitest'
import {
  buildTaskExternalId,
  readStableWorkId,
  resolveTaskIdentityConflicts,
  stableIdentityKey,
  stableUrlKey
} from '../../src/main/integrations/chaoxing/identity'

interface TaskRecordFixture {
  externalId: string
  title: string
  sourceUrl: string | null
  platformStatus?: string
}

function record(
  title: string,
  url: string | null,
  externalId = 'c1:clazz1:t1',
  platformStatus?: string
): TaskRecordFixture {
  return { externalId, title, sourceUrl: url, ...(platformStatus ? { platformStatus } : {}) }
}

describe('chaoxing task identity', () => {
  it('优先使用平台作业 ID，缺失时按标题哈希兜底', () => {
    expect(buildTaskExternalId('c1:clazz1', '58316675', '实验4')).toBe('c1:clazz1:58316675')
    const hashed = buildTaskExternalId('c1:clazz1', null, '实验4')
    expect(hashed.startsWith('c1:clazz1:t')).toBe(true)
    expect(hashed).toBe(buildTaskExternalId('c1:clazz1', null, '实验4'))
    expect(hashed).not.toBe(buildTaskExternalId('c1:clazz1', null, '实验5'))
  })

  it('不同课程与不同教学班的同名作业不冲突', () => {
    const a = record('作业一', 'https://mooc1.chaoxing.com/work?workid=1', 'c1:clazz1:1')
    const b = record('作业一', 'https://mooc1.chaoxing.com/work?workid=1', 'c1:clazz2:1')
    const c = record('作业一', 'https://mooc1.chaoxing.com/work?workid=1', 'c2:clazz1:1')
    const resolved = resolveTaskIdentityConflicts([a, b, c], () => [])
    expect(resolved.records).toHaveLength(3)
    expect(resolved.warnings).toHaveLength(0)
  })

  it('同平台 ID 的重复渲染安全去重，不受平台状态变化影响', () => {
    const url = 'https://mooc1.chaoxing.com/work?workid=9&enc=abc'
    const resolved = resolveTaskIdentityConflicts(
      [record('作业一', url, 'c1:c1:9', '进行中'), record('作业一', url, 'c1:c1:9', '已完成')],
      () => []
    )
    expect(resolved.records).toHaveLength(1)
    expect(resolved.records[0]?.externalId).toBe('c1:c1:9')
    expect(resolved.warnings).toHaveLength(0)
  })

  it('同教学班两个无平台 ID 但稳定参数不同的同名作业保留两条并报告冲突', () => {
    const first = record('章节测试', 'https://mooc1.chaoxing.com/work?chapterid=1&enc=aaa')
    const second = record('章节测试', 'https://mooc1.chaoxing.com/work?chapterid=2&enc=bbb')
    const resolved = resolveTaskIdentityConflicts([first, second], () => [])
    expect(resolved.records).toHaveLength(2)
    expect(new Set(resolved.records.map((item) => item.externalId)).size).toBe(2)
    expect(resolved.warnings[0]).toContain('缺少平台作业 ID')
    expect(resolved.warnings[0]).toContain('章节测试')
  })

  it('列表顺序改变不会改变稳定标识分配', () => {
    const first = record('章节测试', 'https://mooc1.chaoxing.com/work?chapterid=1')
    const second = record('章节测试', 'https://mooc1.chaoxing.com/work?chapterid=2')
    const forward = resolveTaskIdentityConflicts([first, second], () => [])
    const backward = resolveTaskIdentityConflicts([second, first], () => [])
    const mapOf = (result: typeof forward) =>
      new Map(result.records.map((item) => [item.sourceUrl, item.externalId]))
    expect(mapOf(forward)).toEqual(mapOf(backward))
  })

  it('enc、t 等临时签名不参与稳定指纹', () => {
    const a = stableUrlKey('https://mooc1.chaoxing.com/work?workid=9&enc=aaa&t=1')
    const b = stableUrlKey('https://mooc1.chaoxing.com/work?workid=9&enc=bbb&t=2')
    expect(a).toBe(b)
    expect(a).toBe('https://mooc1.chaoxing.com/work?workid=9')
    expect(stableIdentityKey('https://mooc1.chaoxing.com/work?workid=9&enc=x')).toBe('9')
  })

  it('已有记录一对一匹配时沿用旧 externalId，另一条使用稳定指纹后缀', () => {
    const existingUrl = 'https://mooc1.chaoxing.com/work?chapterid=1'
    const resolved = resolveTaskIdentityConflicts(
      [
        record('章节测试', existingUrl),
        record('章节测试', 'https://mooc1.chaoxing.com/work?chapterid=2')
      ],
      (baseId) =>
        baseId === 'c1:clazz1:t1' ? [{ externalId: 'c1:clazz1:t1', sourceUrl: existingUrl }] : []
    )
    const reused = resolved.records.find((item) => item.sourceUrl === existingUrl)
    const suffixed = resolved.records.find((item) => item.sourceUrl !== existingUrl)
    expect(reused?.externalId).toBe('c1:clazz1:t1')
    expect(suffixed?.externalId.startsWith('c1:clazz1:t1:s')).toBe(true)
  })

  it('冲突组缩减时保留历史后缀身份，不退回基础 ID', () => {
    const existingUrl = 'https://mooc1.chaoxing.com/work?chapterid=2'
    const resolved = resolveTaskIdentityConflicts([record('章节测试', existingUrl)], () => [
      { externalId: 'c1:clazz1:t1', sourceUrl: 'https://mooc1.chaoxing.com/work?chapterid=1' },
      { externalId: 'c1:clazz1:t1:sabc', sourceUrl: existingUrl }
    ])
    expect(resolved.records).toHaveLength(1)
    expect(resolved.records[0]?.externalId).toBe('c1:clazz1:t1:sabc')
  })

  it('状态变化不会改变单条作业的 externalId', () => {
    const first = resolveTaskIdentityConflicts(
      [record('章节测试', 'https://mooc1.chaoxing.com/work?chapterid=1', 'c1:c1:t', '未提交')],
      () => []
    )
    const second = resolveTaskIdentityConflicts(
      [record('章节测试', 'https://mooc1.chaoxing.com/work?chapterid=1', 'c1:c1:t', '已完成')],
      () => []
    )
    expect(first.records[0]?.externalId).toBe(second.records[0]?.externalId)
  })

  it('只有标题、状态、易变签名相同且无可靠 ID 时不合并', () => {
    const resolved = resolveTaskIdentityConflicts(
      [
        record('章节测试', 'https://mooc1.chaoxing.com/work?num=1&enc=aaa', 'c1:c1:h', '未提交'),
        record('章节测试', 'https://mooc1.chaoxing.com/work?num=2&enc=bbb', 'c1:c1:h', '未提交')
      ],
      () => []
    )
    expect(resolved.records).toHaveLength(0)
    expect(resolved.warnings[0]).toContain('identity_unknown')
    expect(resolved.warnings[0]).toContain('跳过')
  })

  it('已有基础 ID 只有易变 URL 时不会被不确定地复用给另一条记录', () => {
    const resolved = resolveTaskIdentityConflicts(
      [
        record('章节测试', 'https://mooc1.chaoxing.com/work?chapterid=1'),
        record('章节测试', 'https://mooc1.chaoxing.com/work?chapterid=2')
      ],
      () => [{ externalId: 'c1:clazz1:t1', sourceUrl: 'https://mooc1.chaoxing.com/work?enc=old' }]
    )
    expect(resolved.records).toHaveLength(2)
    expect(resolved.records.some((item) => item.externalId === 'c1:clazz1:t1')).toBe(false)
    expect(resolved.warnings.some((warning) => warning.includes('identity_conflict'))).toBe(true)
  })

  it('平台稳定 ID 参数按可信度读取', () => {
    expect(readStableWorkId('https://mooc1.chaoxing.com/work?workid=58316675')).toBe('58316675')
    expect(readStableWorkId('https://mooc1.chaoxing.com/work?answerId=55650091')).toBe('55650091')
    expect(readStableWorkId('https://mooc1.chaoxing.com/work?enc=abc')).toBeNull()
    expect(readStableWorkId(null)).toBeNull()
  })

  it('历史单条 A 被当前单条 B 取代时不得复用 A 的 externalId', () => {
    const aUrl = 'https://mooc1.chaoxing.com/work?chapterid=1&enc=a'
    const bUrl = 'https://mooc1.chaoxing.com/work?chapterid=2&enc=b'
    const resolved = resolveTaskIdentityConflicts([record('章节测试', bUrl)], () => [
      { externalId: 'c1:clazz1:t1', sourceUrl: aUrl }
    ])
    expect(resolved.records).toHaveLength(1)
    expect(resolved.records[0]?.externalId).not.toBe('c1:clazz1:t1')
    expect(resolved.records[0]?.externalId.startsWith('c1:clazz1:t1:s')).toBe(true)
    expect(resolved.warnings.some((warning) => warning.includes('identity_conflict'))).toBe(true)
  })

  it('历史单条 A 与当前单条 A 稳定身份一致时沿用旧 externalId', () => {
    const url = 'https://mooc1.chaoxing.com/work?chapterid=1&enc=new'
    const resolved = resolveTaskIdentityConflicts([record('章节测试', url)], () => [
      {
        externalId: 'c1:clazz1:t1',
        sourceUrl: 'https://mooc1.chaoxing.com/work?chapterid=1&enc=old'
      }
    ])
    expect(resolved.records[0]?.externalId).toBe('c1:clazz1:t1')
  })

  it('历史候选没有可靠身份且当前有稳定身份时生成独立 ID 并保留旧记录', () => {
    const resolved = resolveTaskIdentityConflicts(
      [record('章节测试', 'https://mooc1.chaoxing.com/work?chapterid=2')],
      () => [{ externalId: 'c1:clazz1:t1', sourceUrl: 'https://mooc1.chaoxing.com/work?enc=old' }]
    )
    expect(resolved.records[0]?.externalId.startsWith('c1:clazz1:t1:s')).toBe(true)
    expect(resolved.warnings.some((warning) => warning.includes('identity_conflict'))).toBe(true)
  })
})
