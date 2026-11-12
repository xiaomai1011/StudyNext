import { app, safeStorage } from 'electron'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChaoxingCredentialStatus } from '@shared/types'

interface StoredCredentials {
  version: 1
  username: string
  password: string
}

/**
 * Stores the user's Chaoxing account in the OS credential vault (<-> DPAPI on
 * Windows). The plaintext never leaves this class and is only handed to the
 * official passport page through PortalService.fillCredentials().
 */
export class ChaoxingCredentialStore {
  private get filePath(): string {
    return join(app.getPath('userData'), 'chaoxing-credentials.enc')
  }

  async status(): Promise<ChaoxingCredentialStatus> {
    const encryptionAvailable = safeStorage.isEncryptionAvailable()
    const credentials = await this.load()
    return {
      saved: credentials !== null,
      username: credentials?.username ?? null,
      encryptionAvailable
    }
  }

  async save(username: string, password: string): Promise<ChaoxingCredentialStatus> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统未提供安全加密（DPAPI 不可用），账号未保存。')
    }
    const payload: StoredCredentials = { version: 1, username, password }
    const encrypted = safeStorage.encryptString(JSON.stringify(payload))
    await writeFile(this.filePath, encrypted, { mode: 0o600 })
    return this.status()
  }

  async load(): Promise<{ username: string; password: string } | null> {
    try {
      const encrypted = await readFile(this.filePath)
      const decrypted = safeStorage.decryptString(encrypted)
      const parsed = JSON.parse(decrypted) as Partial<StoredCredentials>
      if (
        parsed.version !== 1 ||
        typeof parsed.username !== 'string' ||
        typeof parsed.password !== 'string' ||
        parsed.username.length === 0 ||
        parsed.password.length === 0
      ) {
        return null
      }
      return { username: parsed.username, password: parsed.password }
    } catch {
      return null
    }
  }

  async clear(): Promise<ChaoxingCredentialStatus> {
    await rm(this.filePath, { force: true })
    return this.status()
  }
}
