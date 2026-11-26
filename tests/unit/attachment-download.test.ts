import { describe, expect, it } from 'vitest'
import type { Task } from '../../src/shared/types'
import {
  buildAttachmentPreviewUrl,
  parseAttachmentDownloadUrl,
  resolveTaskAttachmentSource
} from '../../src/main/integrations/chaoxing/attachment-download'

describe('作业附件下载地址', () => {
  it('生成带文件名编码的官方预览地址', () => {
    const url = buildAttachmentPreviewUrl('a'.repeat(32), '实验 4/报告.docx')
    expect(url).toBe(
      'https://mooc1.chaoxing.com/mooc-ans/ueditorupload/read?objectId=' +
        'a'.repeat(32) +
        '&fileOriName=%E5%AE%9E%E9%AA%8C+4%2F%E6%8A%A5%E5%91%8A.docx'
    )
  })

  it('拒绝非十六进制 objectId 和超长输入', () => {
    expect(() => buildAttachmentPreviewUrl('not-an-object-id', 'a.docx')).toThrow('附件标识无效')
  })

  it('从 btnDown 链接解析并解码 HTML 实体', () => {
    const html = `
      <a class="btnDown" href="https://d0.cldisk.com/download/abc?at_=1&amp;ak_=2&amp;ad_=3&amp;fn=x.docx">
        下载
      </a>`
    expect(parseAttachmentDownloadUrl(html)).toBe(
      'https://d0.cldisk.com/download/abc?at_=1&ak_=2&ad_=3&fn=x.docx'
    )
  })

  it('支持单引号属性', () => {
    const html = `<a href='https://d1.cldisk.com/download/abc?at_=1&ak_=2' class='btnDown'>下载</a>`
    expect(parseAttachmentDownloadUrl(html)).toContain('d1.cldisk.com/download/abc')
  })

  it('拒绝非 cldisk、非 HTTPS、缺签名参数的链接', () => {
    expect(() =>
      parseAttachmentDownloadUrl(
        '<a class="btnDown" href="https://evil.example/download/a?at_=1&ak_=2">'
      )
    ).toThrow('平台没有返回可用的附件下载地址')
    expect(() =>
      parseAttachmentDownloadUrl(
        '<a class="btnDown" href="http://d0.cldisk.com/download/a?at_=1&ak_=2">'
      )
    ).toThrow('平台没有返回可用的附件下载地址')
    expect(() =>
      parseAttachmentDownloadUrl(
        '<a class="btnDown" href="https://d0.cldisk.com/download/a?at_=1">'
      )
    ).toThrow('平台没有返回可用的附件下载地址')
  })

  it('忽略普通链接，只认 btnDown', () => {
    expect(() =>
      parseAttachmentDownloadUrl(
        '<a href="https://d0.cldisk.com/download/abc?at_=1&ak_=2">普通下载</a>'
      )
    ).toThrow('平台没有返回可用的附件下载地址')
  })

  it('附件重排后仍按 objectId 找到原附件', () => {
    const idA = 'a'.repeat(32)
    const idB = 'b'.repeat(32)
    const task = {
      id: 'task-a',
      source: 'chaoxing',
      sourceUrl: 'https://mooc1.chaoxing.com/work',
      attachments: [
        { name: 'B.docx', size: '1 KB', objectId: idB },
        { name: 'A.docx', size: '1 KB', objectId: idA }
      ]
    } as Task
    expect(resolveTaskAttachmentSource(task, idA)).toEqual({
      taskId: 'task-a',
      index: 1,
      objectId: idA,
      fileName: 'A.docx',
      referer: 'https://mooc1.chaoxing.com/work'
    })
  })

  it('原附件删除或同名不同 ID 时只认 objectId，无法唯一匹配就失败', () => {
    const task = {
      id: 'task-a',
      source: 'chaoxing',
      sourceUrl: null,
      attachments: [
        { name: '报告.docx', size: '1 KB', objectId: 'a'.repeat(32) },
        { name: '报告.docx', size: '1 KB', objectId: 'b'.repeat(32) }
      ]
    } as Task
    expect(resolveTaskAttachmentSource(task, 'a'.repeat(32))).toMatchObject({
      objectId: 'a'.repeat(32),
      fileName: '报告.docx'
    })
    expect(resolveTaskAttachmentSource(task, 'c'.repeat(32))).toBeNull()
    const duplicateId = {
      ...task,
      attachments: [
        { name: 'A.docx', size: '1 KB', objectId: 'a'.repeat(32) },
        { name: 'A-copy.docx', size: '1 KB', objectId: 'a'.repeat(32) }
      ]
    }
    expect(resolveTaskAttachmentSource(duplicateId, 'a'.repeat(32))).toBeNull()
  })

  it('拒绝本地任务、缺失或非法 objectId', () => {
    const task = {
      id: 'task-a',
      source: 'chaoxing',
      sourceUrl: null,
      attachments: [{ name: 'a.docx', size: '1 KB', objectId: 'a'.repeat(32) }]
    } as Task
    expect(resolveTaskAttachmentSource(task, null)).toBeNull()
    expect(resolveTaskAttachmentSource(task, '')).toBeNull()
    expect(resolveTaskAttachmentSource({ ...task, source: 'manual' }, 'a'.repeat(32))).toBeNull()
    expect(resolveTaskAttachmentSource(null, 'a'.repeat(32))).toBeNull()
  })
})
