import { afterEach, describe, expect, it, vi } from 'vitest'
import { PortalService } from '../../src/main/portal/service'
import { StudyNextStore } from '../../src/main/storage/store'

const stores: StudyNextStore[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const store of stores.splice(0)) store.close()
})

describe('D-006 Portal navigation guard ownership', () => {
  it('aborts the exam page fetch controller when the operation signal aborts', async () => {
    const store = new StudyNextStore(':memory:')
    stores.push(store)
    const service = new PortalService(store, () => null)
    const executeJavaScript = vi.fn((script: string) => {
      if (script.includes('__studyNextSyncAbort = true')) return Promise.resolve(true)
      return new Promise<string>((resolve) => setTimeout(() => resolve(''), 50))
    })
    ;(service as unknown as { view: { webContents: unknown } }).view = {
      webContents: {
        getURL: () => 'https://mooc1.chaoxing.com/exam-ans/exam/test/examcode/examlist',
        isDestroyed: () => false,
        executeJavaScript,
        stop: vi.fn()
      }
    }

    const controller = new AbortController()
    const read = service.readExamListFromPage(controller.signal)
    await vi.waitFor(() => expect(executeJavaScript).toHaveBeenCalled())
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(read).rejects.toBeDefined()
    expect(
      executeJavaScript.mock.calls.some(([script]) =>
        String(script).includes('__studyNextSyncController?.abort()')
      )
    ).toBe(true)
  })

  it('stops a local chapter/material restore when the operation signal aborts', async () => {
    vi.useFakeTimers()
    const store = new StudyNextStore(':memory:')
    stores.push(store)
    const service = new PortalService(store, () => null)
    let url = 'https://kb.chaoxing.com/res/pc/curriculum/schedule.html'
    const stop = vi.fn()
    const loadURL = vi.fn(() => new Promise<void>(() => undefined))
    ;(service as unknown as { view: { webContents: unknown } }).view = {
      webContents: {
        getURL: () => url,
        isDestroyed: () => false,
        loadURL,
        stop
      }
    }

    const guard = service.createSyncNavigationGuard()
    await guard.begin('d006-local-restore-op')
    const controller = new AbortController()
    const restore = (
      service as unknown as {
        restoreSyncPage: (previous: string, signal?: AbortSignal) => Promise<void>
      }
    ).restoreSyncPage('https://i.chaoxing.com/base', controller.signal)
    controller.abort()
    await vi.advanceTimersByTimeAsync(5_001)
    await restore

    expect(stop).toHaveBeenCalled()
    expect(loadURL).toHaveBeenCalledWith('https://i.chaoxing.com/base')
  })

  it('refuses a late restore after the user opens an official shortcut entry', async () => {
    const store = new StudyNextStore(':memory:')
    stores.push(store)
    const service = new PortalService(store, () => null)
    let url = 'https://i.chaoxing.com/base'
    const stop = vi.fn()
    const loadURL = vi.fn(() => new Promise<void>(() => undefined))
    ;(service as unknown as { view: { webContents: unknown } }).view = {
      webContents: {
        getURL: () => url,
        isDestroyed: () => false,
        loadURL,
        stop
      }
    }

    const guard = service.createSyncNavigationGuard()
    await guard.begin('d006-shortcut-op')
    url = 'https://kb.chaoxing.com/res/pc/curriculum/schedule.html'

    // User opens an official shortcut entry while the sync read is still in flight.
    await expect(service.open('entry-home')).rejects.toBeDefined()

    await expect(guard.end('d006-shortcut-op')).resolves.toEqual({
      restored: false,
      message: '同步期间检测到你的页面操作，未自动恢复原页面'
    })
    expect(loadURL).not.toHaveBeenCalled()
  })

  it('refuses a late restore after the user closes or reloads the overlay', async () => {
    const store = new StudyNextStore(':memory:')
    stores.push(store)
    const service = new PortalService(store, () => null)
    const url = 'https://kb.chaoxing.com/res/pc/curriculum/schedule.html'
    const loadURL = vi.fn(() => new Promise<void>(() => undefined))
    ;(service as unknown as { view: unknown }).view = {
      setVisible: vi.fn(),
      webContents: {
        getURL: () => url,
        isDestroyed: () => false,
        loadURL,
        stop: vi.fn(),
        reload: vi.fn(),
        setVisible: vi.fn(),
        canGoBack: () => false,
        canGoForward: () => false
      }
    }

    const guard = service.createSyncNavigationGuard()
    await guard.begin('d006-close-op')
    service.hide()

    await expect(guard.end('d006-close-op')).resolves.toEqual({
      restored: false,
      message: '同步期间检测到你的页面操作，未自动恢复原页面'
    })
    expect(loadURL).not.toHaveBeenCalled()
  })

  it('stops a restore that exceeds the bounded timeout and releases the guard', async () => {
    vi.useFakeTimers()
    const store = new StudyNextStore(':memory:')
    stores.push(store)
    const service = new PortalService(store, () => null)
    let url = 'https://i.chaoxing.com/base'
    const stop = vi.fn()
    const loadURL = vi.fn(() => new Promise<void>(() => undefined))
    ;(service as unknown as { view: { webContents: unknown } }).view = {
      webContents: {
        getURL: () => url,
        isDestroyed: () => false,
        loadURL,
        stop
      }
    }

    const guard = service.createSyncNavigationGuard()
    await guard.begin('d006-restore-op')
    url = 'https://kb.chaoxing.com/res/pc/curriculum/schedule.html'
    const restore = guard.end('d006-restore-op')
    await vi.advanceTimersByTimeAsync(5_001)

    await expect(restore).resolves.toEqual({
      restored: false,
      message: '同步原页面恢复超时，已停止恢复'
    })
    expect(loadURL).toHaveBeenCalledWith('https://i.chaoxing.com/base')
    expect(stop).toHaveBeenCalledTimes(1)

    // The guard slot is released; a later operation can begin normally.
    await expect(guard.begin('d006-next-op')).resolves.toBeUndefined()
  })
})
