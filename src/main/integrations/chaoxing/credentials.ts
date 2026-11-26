import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChaoxingCredentialStatus, ChaoxingSavedAccount } from '@shared/types'

interface StoredAccountV2 {
  id: string
  username: string
  password: string
  displayName?: string | null
  school?: string | null
  /** 通过真实平台身份校验后写入的稳定 UID，不能由用户名或会话猜测。 */
  platformUid?: string | null
  lastUsedAt?: string | null
}

interface StoredPayloadV2 {
  version: 2
  activeId: string | null
  accounts: StoredAccountV2[]
}

interface StoredPayloadV1 {
  version: 1
  username: string
  password: string
}

function cancelledError(): Error {
  const error = new Error('请求已取消')
  error.name = 'AbortError'
  return error
}

function isStoredAccount(value: unknown): value is StoredAccountV2 {
  if (!value || typeof value !== 'object') return false
  const account = value as Partial<StoredAccountV2>
  return (
    typeof account.id === 'string' &&
    account.id.length > 0 &&
    typeof account.username === 'string' &&
    account.username.length > 0 &&
    typeof account.password === 'string' &&
    account.password.length > 0
  )
}

/**
 * Stores one or more Chaoxing accounts in the OS credential vault (DPAPI on
 * Windows). Plaintext passwords never leave this class and are only handed to
 * the official passport page through PortalService.fillCredentials().
 */
export class ChaoxingCredentialStore {
  constructor(private readonly userDataDir?: string) {}

  private get filePath(): string {
    return join(this.userDataDir ?? app.getPath('userData'), 'chaoxing-credentials.enc')
  }

  async status(): Promise<ChaoxingCredentialStatus> {
    const encryptionAvailable = safeStorage.isEncryptionAvailable()
    const payload = await this.loadPayload()
    const active = this.activeAccount(payload)
    return {
      saved: (payload?.accounts.length ?? 0) > 0,
      username: active?.username ?? null,
      encryptionAvailable,
      accounts: (payload?.accounts ?? []).map((account) => ({
        id: account.id,
        username: account.username,
        displayName: account.displayName ?? null,
        school: account.school ?? null,
        platformUid: account.platformUid ?? null,
        lastUsedAt: account.lastUsedAt ?? null
      })),
      activeAccountId: active?.id ?? null
    }
  }

  async save(username: string, password: string): Promise<ChaoxingCredentialStatus> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统未提供安全加密（DPAPI 不可用），账号未保存。')
    }
    const payload = (await this.loadPayload()) ?? { version: 2, activeId: null, accounts: [] }
    const normalized = username.trim()
    const existing = payload.accounts.find(
      (account) => account.username.toLowerCase() === normalized.toLowerCase()
    )
    if (existing) {
      existing.password = password
      existing.username = normalized
      existing.lastUsedAt = new Date().toISOString()
      // 保存/更新凭据不等于切换身份：只有原本没有 activeId 时才选中它。
      if (!payload.activeId) payload.activeId = existing.id
    } else {
      const account: StoredAccountV2 = {
        id: randomUUID(),
        username: normalized,
        password,
        displayName: null,
        school: null,
        platformUid: null,
        lastUsedAt: new Date().toISOString()
      }
      payload.accounts.push(account)
      // 保存新账号不得改变当前已验证的登录身份；只有首次保存时才成为 active。
      if (!payload.activeId) payload.activeId = account.id
    }
    await this.writePayload(payload)
    return this.status()
  }

  async load(): Promise<{ username: string; password: string } | null> {
    const payload = await this.loadPayload()
    const active = this.activeAccount(payload)
    return active ? { username: active.username, password: active.password } : null
  }

  async loadAccount(id: string): Promise<{ username: string; password: string } | null> {
    const payload = await this.loadPayload()
    const account = payload?.accounts.find((item) => item.id === id)
    return account ? { username: account.username, password: account.password } : null
  }

  async setActive(id: string): Promise<ChaoxingCredentialStatus> {
    const payload = await this.loadPayload()
    if (!payload) throw new Error('本机尚未保存学习通账号。')
    const account = payload.accounts.find((item) => item.id === id)
    if (!account) throw new Error('找不到要切换的学习通账号。')
    payload.activeId = id
    account.lastUsedAt = new Date().toISOString()
    await this.writePayload(payload)
    return this.status()
  }

  async remove(id: string): Promise<ChaoxingCredentialStatus> {
    const payload = await this.loadPayload()
    if (!payload) return this.status()
    payload.accounts = payload.accounts.filter((account) => account.id !== id)
    if (payload.activeId === id) payload.activeId = payload.accounts[0]?.id ?? null
    if (payload.accounts.length === 0) {
      await rm(this.filePath, { force: true })
      return this.status()
    }
    await this.writePayload(payload)
    return this.status()
  }

  async getAccount(id: string): Promise<ChaoxingSavedAccount | null> {
    const status = await this.status()
    return status.accounts.find((account) => account.id === id) ?? null
  }

  /**
   * 身份绑定与激活必须在同一份凭据写入中完成，避免自动登录取消时只落下
   * 身份字段而让账号处于半提交状态。signal 只在真正写文件前检查。
   */
  async bindIdentityAndActivate(
    accountId: string,
    displayName: string | null | undefined,
    school: string | null | undefined,
    platformUid: string,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw cancelledError()
    const payload = await this.loadPayload()
    if (!payload) throw new Error('本机尚未保存学习通账号。')
    const account = payload.accounts.find((item) => item.id === accountId)
    if (!account) throw new Error('找不到要绑定身份的学习通账号。')
    const uid = platformUid.trim()
    if (!uid) throw new Error('学习通平台未返回可靠身份标识，无法绑定账号。')
    if (account.platformUid && account.platformUid !== uid) {
      throw new Error('学习通登录身份与目标账号不一致，未更新账号身份。')
    }
    if (signal?.aborted) throw cancelledError()
    account.platformUid = uid
    if (displayName && account.displayName !== displayName) account.displayName = displayName
    if (school && account.school !== school) account.school = school
    account.lastUsedAt = new Date().toISOString()
    payload.activeId = account.id
    await this.writePayload(payload)
  }

  /**
   * 只有在目标账号已完成可靠平台身份校验后才能调用。
   * 不能根据“Portal 当前已登录”直接更新身份。
   */
  async bindIdentity(
    accountId: string,
    displayName: string | null | undefined,
    school: string | null | undefined,
    platformUid: string
  ): Promise<void> {
    const payload = await this.loadPayload()
    if (!payload) throw new Error('本机尚未保存学习通账号。')
    const account = payload.accounts.find((item) => item.id === accountId)
    if (!account) throw new Error('找不到要绑定身份的学习通账号。')
    const uid = platformUid.trim()
    if (!uid) throw new Error('学习通平台未返回可靠身份标识，无法绑定账号。')
    if (account.platformUid && account.platformUid !== uid) {
      throw new Error('学习通登录身份与目标账号不一致，未更新账号身份。')
    }
    account.platformUid = uid
    if (displayName && account.displayName !== displayName) account.displayName = displayName
    if (school && account.school !== school) account.school = school
    account.lastUsedAt = new Date().toISOString()
    await this.writePayload(payload)
  }

  async updateIdentity(
    displayName: string | null | undefined,
    school: string | null | undefined
  ): Promise<void> {
    const payload = await this.loadPayload()
    const active = this.activeAccount(payload)
    if (!active) return
    let changed = false
    if (displayName && active.displayName !== displayName) {
      active.displayName = displayName
      changed = true
    }
    if (school && active.school !== school) {
      active.school = school
      changed = true
    }
    if (changed) await this.writePayload(payload as StoredPayloadV2)
  }

  async clear(): Promise<ChaoxingCredentialStatus> {
    await rm(this.filePath, { force: true })
    return this.status()
  }

  private activeAccount(payload: StoredPayloadV2 | null): StoredAccountV2 | null {
    if (!payload || payload.accounts.length === 0) return null
    return (
      payload.accounts.find((account) => account.id === payload.activeId) ??
      payload.accounts[0] ??
      null
    )
  }

  private async loadPayload(): Promise<StoredPayloadV2 | null> {
    try {
      const encrypted = await readFile(this.filePath)
      const decrypted = safeStorage.decryptString(encrypted)
      const parsed = JSON.parse(decrypted) as {
        version?: number
        activeId?: unknown
        accounts?: unknown
        username?: unknown
        password?: unknown
      }
      if (parsed.version === 2 && Array.isArray(parsed.accounts)) {
        const accounts = parsed.accounts.filter(isStoredAccount)
        if (accounts.length === 0) return null
        const activeId =
          typeof parsed.activeId === 'string' &&
          accounts.some((account) => account.id === parsed.activeId)
            ? parsed.activeId
            : (accounts[0]?.id ?? null)
        return { version: 2, activeId, accounts }
      }
      if (
        parsed.version === 1 &&
        typeof parsed.username === 'string' &&
        typeof parsed.password === 'string' &&
        parsed.username.length > 0 &&
        parsed.password.length > 0
      ) {
        const account: StoredAccountV2 = {
          id: 'legacy-account',
          username: parsed.username,
          password: parsed.password,
          displayName: null,
          school: null,
          lastUsedAt: null
        }
        return { version: 2, activeId: account.id, accounts: [account] }
      }
      return null
    } catch {
      return null
    }
  }

  private async writePayload(payload: StoredPayloadV2): Promise<void> {
    const encrypted = safeStorage.encryptString(JSON.stringify(payload))
    await writeFile(this.filePath, encrypted, { mode: 0o600 })
  }
}
