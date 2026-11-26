import { describe, expect, it } from 'vitest'
import { resolvePortalNavigation } from '../../src/main/portal/navigation'

describe('Portal 页面内导航主框架隔离', () => {
  it('主框架导航会更新当前 URL 与登录状态', () => {
    const result = resolvePortalNavigation('unknown', 'https://i.chaoxing.com/base', true)

    expect(result).toEqual({
      url: 'https://i.chaoxing.com/base',
      loginState: 'logged_in',
      isLoginPage: false
    })
  })

  it('主框架进入登录页会标记未登录', () => {
    const result = resolvePortalNavigation(
      'logged_in',
      'https://passport2.chaoxing.com/login',
      true
    )

    expect(result?.loginState).toBe('logged_out')
    expect(result?.isLoginPage).toBe(true)
  })

  it('校园 SSO /authserver/index 保持登录页判定', () => {
    const result = resolvePortalNavigation(
      'logged_in',
      'https://authserver.example.edu.cn/authserver/index',
      true
    )

    expect(result?.loginState).toBe('logged_out')
    expect(result?.isLoginPage).toBe(true)
  })

  it('官方 /mlogin 保持登录页判定', () => {
    const result = resolvePortalNavigation('logged_in', 'https://mooc1.chaoxing.com/mlogin', true)

    expect(result?.loginState).toBe('logged_out')
    expect(result?.isLoginPage).toBe(true)
  })

  it('子框架页内跳转不返回更新，不能覆盖主页面 URL 或登录状态', () => {
    const result = resolvePortalNavigation(
      'logged_in',
      'https://passport2.chaoxing.com/login',
      false
    )

    expect(result).toBeNull()
  })
})
