import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface UserDataPathOptions {
  platform: NodeJS.Platform
  appData: string
  localAppData?: string | undefined
  override?: string | undefined
}

/**
 * Returns per-user persistent locations in priority order. A temporary folder is
 * deliberately never included: silently losing the database after reboot is worse
 * than a clear startup failure.
 */
export function userDataPathCandidates(options: UserDataPathOptions): string[] {
  const override = options.override?.trim()
  if (override) return [resolve(override)]
  if (options.platform === 'win32') {
    const candidates: string[] = []
    if (options.localAppData?.trim()) {
      candidates.push(join(options.localAppData.trim(), 'StudyNext'))
    }
    candidates.push(join(options.appData, 'StudyNext'))
    return uniquePaths(candidates)
  }
  return [join(options.appData, 'StudyNext')]
}

export function ensureUserDataDirectory(candidates: string[]): string {
  const failures: string[] = []
  for (const candidate of candidates) {
    try {
      mkdirSync(candidate, { recursive: true })
      return candidate
    } catch (error) {
      failures.push(`${candidate}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(
    `无法创建本地数据目录。请确认当前用户对以下位置有写权限，或设置 STUDYNEXT_DATA_DIR 指向可写目录：\n${failures.join('\n')}`
  )
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))]
}
