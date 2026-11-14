import { describe, expect, it } from 'vitest'
import { describeUploadCompletion, describeUploadError } from '../../src/main/portal/upload-events'

describe('附件上传状态', () => {
  it('2xx/3xx 视为上传成功', () => {
    expect(describeUploadCompletion(200)).toEqual({ state: 'completed', message: '附件上传成功' })
    expect(describeUploadCompletion(302)).toEqual({ state: 'completed', message: '附件上传成功' })
  })

  it('4xx/5xx 返回包含状态码的失败提示', () => {
    expect(describeUploadCompletion(413)).toEqual({
      state: 'failed',
      message: '附件上传失败（HTTP 413）'
    })
    expect(describeUploadCompletion(500)).toEqual({
      state: 'failed',
      message: '附件上传失败（HTTP 500）'
    })
  })

  it('没有响应状态时不会误报成功', () => {
    expect(describeUploadCompletion(null).state).toBe('failed')
  })

  it('网络错误保留原始错误原因', () => {
    expect(describeUploadError('net::ERR_CONNECTION_RESET')).toEqual({
      state: 'failed',
      message: '附件上传失败：net::ERR_CONNECTION_RESET'
    })
  })
})
