export interface UploadOutcome {
  state: 'completed' | 'failed'
  message: string
}

export function describeUploadCompletion(statusCode: number | null): UploadOutcome {
  if (typeof statusCode !== 'number') {
    return { state: 'failed', message: '附件上传失败（未收到服务器响应）' }
  }
  if (statusCode >= 200 && statusCode < 400) {
    return { state: 'completed', message: '附件上传成功' }
  }
  return { state: 'failed', message: `附件上传失败（HTTP ${statusCode}）` }
}

export function describeUploadError(error: string): UploadOutcome {
  return { state: 'failed', message: `附件上传失败：${error}` }
}
