import { describe, expect, it } from 'vitest'
import { resolveDownloadFinishState } from '../../src/main/portal/download-state'

describe('download finish state', () => {
  it('preserves an explicit user cancellation even when the transport reports interrupted', () => {
    expect(resolveDownloadFinishState('interrupted', true)).toBe('cancelled')
    expect(resolveDownloadFinishState('cancelled', true)).toBe('cancelled')
  })

  it('keeps network and internal failures as interrupted', () => {
    expect(resolveDownloadFinishState('interrupted', false)).toBe('interrupted')
    expect(resolveDownloadFinishState('completed', false)).toBe('completed')
  })
})
