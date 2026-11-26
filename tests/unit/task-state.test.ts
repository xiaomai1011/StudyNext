import { describe, expect, it } from 'vitest'
import type { PortalState, Task } from '@shared/types'
import {
  formatTaskScore,
  getTaskOpenTarget,
  getTaskPortalAction,
  getTaskScoreView,
  getTaskStatusView,
  isTaskActionable,
  resolveTaskPortalOpenFeedback
} from '@shared/task-state'

const now = new Date('2026-11-17T10:00:00.000Z')

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: '作业',
    description: '',
    courseId: 'course-1',
    priority: 'medium',
    kind: 'homework',
    status: 'todo',
    dueAt: '2026-11-16T15:59:00.000Z',
    completedAt: null,
    completionSource: null,
    source: 'chaoxing',
    externalId: 'ext-1',
    sourceUpdatedAt: null,
    sourceUrl: 'https://mooc1.chaoxing.com/work/view?workId=1',
    platformStatus: '待审核',
    platformStatusKind: 'pending_review',
    submittedAt: null,
    score: null,
    fullScore: null,
    teacherFeedback: null,
    attachments: [],
    manualFields: [],
    fieldSources: {},
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    reminders: [],
    ...overrides
  }
}

describe('task-state', () => {
  it('keeps platform status visible while marking an overdue task as overdue', () => {
    const view = getTaskStatusView(task({ platformStatusKind: 'not_submitted' }), now)
    expect(view.platformLabel).toBe('未提交')
    expect(view.overdue).toBe(true)
    expect(view.bucket).toBe('overdue')
  })

  it('separates platform reviewed state from local completion', () => {
    const view = getTaskStatusView(task({ platformStatusKind: 'reviewed', status: 'todo' }), now)
    expect(view.platformLabel).toBe('已批阅')
    expect(view.showLocalPill).toBe(true)
    expect(view.localLabel).toBe('未完成')
    expect(view.canToggleLocal).toBe(false)
  })

  it('allows local tasks to be toggled even when overdue', () => {
    const view = getTaskStatusView(task({ source: 'manual', status: 'todo' }), now)
    expect(view.canToggleLocal).toBe(true)
    expect(view.platformLabel).toBeNull()
    expect(view.overdue).toBe(true)
  })

  it('formats a real zero score instead of treating it as missing', () => {
    expect(formatTaskScore('0', '100', 'reviewed')).toBe('0 / 100')
    expect(getTaskScoreView(task({ score: '0', fullScore: '100' }))).toEqual({
      text: '0 / 100',
      hasScore: true,
      state: 'graded'
    })
  })

  it('distinguishes ungraded, unread and full-score-only values', () => {
    expect(formatTaskScore(null, null, 'submitted')).toBe('未评分')
    expect(formatTaskScore(null, null, 'reviewed')).toBe('成绩未读取')
    expect(formatTaskScore(null, '100', 'submitted')).toBe('未出分 / 100')
  })

  it('uses a course URL only as an explicit fallback and enforces the Portal allowlist', () => {
    expect(
      getTaskOpenTarget({ sourceUrl: null }, { sourceUrl: 'https://mooc1.chaoxing.com/course' })
    ).toEqual({ url: 'https://mooc1.chaoxing.com/course', kind: 'course' })
    expect(getTaskOpenTarget({ sourceUrl: 'not-a-url' }, { sourceUrl: null })).toBeNull()
    expect(
      getTaskOpenTarget({ sourceUrl: 'https://example.com/task' }, { sourceUrl: null })
    ).toBeNull()
    expect(
      getTaskOpenTarget(
        { sourceUrl: 'https://example.com/task' },
        { sourceUrl: 'https://mooc1.chaoxing.com/course' }
      )
    ).toEqual({
      url: 'https://mooc1.chaoxing.com/course',
      kind: 'course'
    })
    expect(
      getTaskOpenTarget(
        { sourceUrl: 'https://chaoxing.com.evil.example/work?id=1' },
        { sourceUrl: 'https://www.xuexitong.com/course' }
      )
    ).toEqual({
      url: 'https://www.xuexitong.com/course',
      kind: 'course'
    })
    expect(
      getTaskOpenTarget(
        { sourceUrl: 'https://user:pass@mooc1.chaoxing.com/work?id=1' },
        { sourceUrl: 'https://mooc1.chaoxing.com/course' }
      )
    ).toEqual({
      url: 'https://mooc1.chaoxing.com/course',
      kind: 'course'
    })
    expect(
      getTaskOpenTarget(
        { sourceUrl: 'http://mooc1.chaoxing.com/work/view?workId=1' },
        { sourceUrl: null }
      )
    ).toEqual({
      url: 'https://mooc1.chaoxing.com/work/view?workId=1',
      kind: 'task'
    })
  })

  it('keeps submitted visible on an overdue task', () => {
    const view = getTaskStatusView(task({ platformStatusKind: 'submitted' }), now)
    expect(view.platformLabel).toBe('已提交')
    expect(view.overdue).toBe(true)
  })

  it('does not show a local mismatch pill when platform and local agree', () => {
    const view = getTaskStatusView(task({ platformStatusKind: 'reviewed', status: 'done' }), now)
    expect(view.showLocalPill).toBe(false)
    expect(view.canToggleLocal).toBe(false)
  })

  it('treats submitted and pending_review as platform statuses, not local completion', () => {
    expect(getTaskStatusView(task({ platformStatusKind: 'submitted' }), now).canToggleLocal).toBe(
      false
    )
    expect(
      getTaskStatusView(task({ platformStatusKind: 'pending_review' }), now).canToggleLocal
    ).toBe(false)
  })

  it('never invents an open target from a blank or invalid URL', () => {
    expect(getTaskOpenTarget({ sourceUrl: '   ' }, { sourceUrl: '  ' })).toBeNull()
    expect(
      getTaskOpenTarget({ sourceUrl: 'ftp://example.com/file' }, { sourceUrl: null })
    ).toBeNull()
  })

  it('resolves the action label from both task state and the actual portal target', () => {
    const course = { sourceUrl: 'https://mooc1.chaoxing.com/course' }
    expect(
      getTaskPortalAction(task({ platformStatusKind: 'not_submitted' }), course)
    ).toMatchObject({
      kind: 'answer',
      label: '去作答',
      disabled: false
    })
    expect(getTaskPortalAction(task({ platformStatusKind: 'submitted' }), course)).toMatchObject({
      kind: 'view',
      label: '查看作业',
      disabled: false
    })
    expect(
      getTaskPortalAction(task({ platformStatusKind: 'pending_review' }), course)
    ).toMatchObject({
      kind: 'view',
      label: '查看作业'
    })
    expect(getTaskPortalAction(task({ platformStatusKind: 'reviewed' }), course)).toMatchObject({
      kind: 'view',
      label: '查看作业'
    })
    expect(getTaskPortalAction(task({ platformStatusKind: 'done' }), course)).toMatchObject({
      kind: 'view',
      label: '查看作业'
    })
    expect(
      getTaskPortalAction(task({ sourceUrl: null, platformStatusKind: 'not_submitted' }), course)
    ).toMatchObject({ kind: 'course', label: '打开课程页', disabled: false })
    expect(
      getTaskPortalAction(task({ sourceUrl: 'not-a-url', platformStatusKind: 'pending_review' }), {
        sourceUrl: null
      })
    ).toMatchObject({ kind: 'unavailable', label: '无可用入口', disabled: true })
    expect(
      getTaskPortalAction(
        task({ sourceUrl: 'https://example.com/task', platformStatusKind: 'not_submitted' }),
        course
      )
    ).toMatchObject({
      kind: 'course',
      label: '打开课程页',
      disabled: false,
      target: { url: course.sourceUrl, kind: 'course' }
    })
    expect(isTaskActionable(task({ status: 'done', platformStatusKind: 'not_submitted' }))).toBe(
      false
    )
  })

  it('classifies Portal open outcomes accurately when redirected to a login page', () => {
    const baseState: Pick<
      PortalState,
      'state' | 'loginState' | 'loggedIn' | 'url' | 'displayUrl' | 'error'
    > = {
      state: 'ready',
      loginState: 'logged_in',
      loggedIn: true,
      url: 'https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew',
      displayUrl: 'https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew',
      error: null
    }

    expect(resolveTaskPortalOpenFeedback('answer', baseState)).toEqual({
      status: 'opened',
      message: '已在官方页面打开作业，可直接编辑、上传附件并提交'
    })

    expect(
      resolveTaskPortalOpenFeedback('answer', {
        ...baseState,
        loginState: 'logged_out',
        loggedIn: false,
        url: 'https://passport2.chaoxing.com/login',
        displayUrl: 'https://passport2.chaoxing.com/login',
        error: '请在官方登录页手动完成登录；账号、密码和 Cookie 不会写入日志'
      })
    ).toMatchObject({
      status: 'login_required'
    })
    expect(
      resolveTaskPortalOpenFeedback('answer', {
        ...baseState,
        loginState: 'logged_out',
        loggedIn: false,
        url: 'https://passport2.chaoxing.com/login',
        displayUrl: 'https://passport2.chaoxing.com/login'
      }).message
    ).not.toContain('可直接编辑')

    expect(
      resolveTaskPortalOpenFeedback('answer', {
        ...baseState,
        loginState: 'unknown',
        loggedIn: null,
        url: 'https://passport2.chaoxing.com/v11/loginregister',
        displayUrl: 'https://passport2.chaoxing.com/v11/loginregister'
      }).status
    ).toBe('login_required')

    expect(
      resolveTaskPortalOpenFeedback('course', {
        ...baseState,
        loginState: 'unknown',
        loggedIn: null,
        url: 'https://ids.example.edu.cn/authserver/index',
        displayUrl: 'https://ids.example.edu.cn/authserver/index'
      }).status
    ).toBe('login_required')

    expect(
      resolveTaskPortalOpenFeedback('view', {
        ...baseState,
        state: 'blocked',
        error: '已拦截未授权域名的跳转'
      })
    ).toEqual({
      status: 'error',
      message: '已拦截未授权域名的跳转'
    })

    expect(
      resolveTaskPortalOpenFeedback('answer', {
        ...baseState,
        state: 'idle',
        url: '',
        displayUrl: ''
      }).status
    ).toBe('error')
  })
})
