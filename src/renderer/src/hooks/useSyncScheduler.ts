import { useEffect, useRef } from 'react'
import { isSyncStale } from '@shared/domain'

export type AutoSyncReason = 'startup' | 'interval' | 'resume'

export interface SyncSchedulerOptions {
  enabled: boolean
  intervalMinutes: number
  getLastSyncAt: () => string | null
  canRun: () => boolean
  run: (reason: AutoSyncReason) => Promise<boolean>
}

/**
 * 集中式自动刷新调度器。
 *
 * - 页面组件不各自注册 timer。
 * - 启动后检查一次；前台每 30 秒 tick 一次，由数据新鲜度决定是否真正同步。
 * - 从后台恢复时，数据超过 1 分钟就检查（长间隔设置下也不会等满 5/10/15 分钟）。
 * - 所有触发都经过 canRun() 与 isSyncStale()，避免重复、并发和 Portal 干扰。
 * - 失败后指数退避：1、2、4 分钟，最多 8 分钟；成功立即清零。
 */
export function useSyncScheduler({
  enabled,
  intervalMinutes,
  getLastSyncAt,
  canRun,
  run
}: SyncSchedulerOptions): void {
  const getLastSyncAtRef = useRef(getLastSyncAt)
  const canRunRef = useRef(canRun)
  const runRef = useRef(run)
  const failureCountRef = useRef(0)
  const nextAllowedAtRef = useRef(0)
  getLastSyncAtRef.current = getLastSyncAt
  canRunRef.current = canRun
  runRef.current = run

  useEffect(() => {
    if (!enabled) return
    const check = async (reason: AutoSyncReason): Promise<void> => {
      if (!canRunRef.current()) return
      if (Date.now() < nextAllowedAtRef.current) return
      const threshold = reason === 'resume' ? Math.min(intervalMinutes, 1) : intervalMinutes
      if (!isSyncStale(getLastSyncAtRef.current(), threshold)) return
      const ok = await runRef.current(reason)
      if (ok) {
        failureCountRef.current = 0
        nextAllowedAtRef.current = 0
      } else {
        failureCountRef.current += 1
        const backoffMinutes = Math.min(2 ** (failureCountRef.current - 1), 8)
        nextAllowedAtRef.current = Date.now() + backoffMinutes * 60_000
      }
    }
    const startup = window.setTimeout(() => void check('startup'), 4000)
    const interval = window.setInterval(() => void check('interval'), 30_000)
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') void check('resume')
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearTimeout(startup)
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [enabled, intervalMinutes])
}
