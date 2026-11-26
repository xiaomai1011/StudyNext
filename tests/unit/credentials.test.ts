import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import { ChaoxingCredentialStore } from '../../src/main/integrations/chaoxing/credentials'

let directory: string
let store: ChaoxingCredentialStore

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'studynext-credentials-'))
  store = new ChaoxingCredentialStore(directory)
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('学习通凭据与身份绑定', () => {
  it('保存第二个账号不改变当前已验证的 active 账号', async () => {
    const first = await store.save('13800000001', 'pass-a')
    const firstActiveId = first.activeAccountId
    expect(firstActiveId).not.toBeNull()

    const second = await store.save('13800000002', 'pass-b')
    expect(second.accounts).toHaveLength(2)
    expect(second.activeAccountId).toBe(firstActiveId)
    expect(second.accounts.find((account) => account.id === firstActiveId)?.platformUid).toBeNull()
  })

  it('可靠 UID 只能绑定到目标账号，且不能被不同 UID 覆盖', async () => {
    const saved = await store.save('13800000003', 'pass-c')
    const accountId = saved.activeAccountId
    if (!accountId) throw new Error('missing account id')

    await store.bindIdentity(accountId, '张三', '测试大学', 'uid-1001')
    expect((await store.getAccount(accountId))?.platformUid).toBe('uid-1001')
    expect((await store.status()).accounts[0]?.displayName).toBe('张三')

    await expect(store.bindIdentity(accountId, '李四', '另一所大学', 'uid-2002')).rejects.toThrow(
      '登录身份与目标账号不一致'
    )
    expect((await store.getAccount(accountId))?.platformUid).toBe('uid-1001')
    expect((await store.getAccount(accountId))?.displayName).toBe('张三')
  })
})
