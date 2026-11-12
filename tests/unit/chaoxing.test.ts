import { describe, expect, it } from 'vitest'
import {
  ChaoxingParseError,
  classifyHomeworkStatus,
  detectLoginState,
  parseCourseFrameUrl,
  parseCourseList,
  parseHomeworkDetail,
  parseHomeworkList,
  parseProfile,
  readHiddenValue,
  resolveDeadline
} from '../../src/main/integrations/chaoxing/parsers'
import { UNKNOWN_DUE_AT } from '@shared/constants'
import {
  computeTaskStats,
  dueBucket,
  formatRemainingCompact,
  isDueAtUnknown
} from '@shared/domain'
import type { Task } from '@shared/types'
import { StudyNextStore } from '../../src/main/storage/store'
import {
  ChaoxingAccessError,
  type ChaoxingAdapterLike,
  type ChaoxingPullResult
} from '../../src/main/integrations/chaoxing/adapter'
import { ChaoxingSessionService } from '../../src/main/integrations/chaoxing/service'
import { buildCredentialFillScript, isChaoxingLoginUrl } from '../../src/main/portal/autofill'
import {
  compressWeeks,
  lessonToSession,
  parseSchedulePayload,
  parseScheduleWeeksPayload,
  parseSectionTimes
} from '../../src/main/integrations/chaoxing/schedule'
import { semesterWeekOf, weekInSchedule } from '@shared/domain'

const COURSE_HTML = `
<ul class="course-list">
  <li>
    <a href="/visit/stucoursemiddle?courseid=1001&clazzid=2001&cpi=3001&ismooc2=1">
      <span class="course-name" title="数据结构">数据结构</span>
    </a>
    <p class="line2 color3" title="张老师">张老师</p>
  </li>
  <li>
    <a href="https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=1001&clazzid=2002&cpi=3002">
      <span class="course-name" title="数据结构（二班）">数据结构（二班）</span>
    </a>
    <p class="line2 color3" title="李老师">李老师</p>
  </li>
  <li>
    <a href="/visit/stucoursemiddle?courseid=1001&clazzid=2001&cpi=3001">
      <span class="course-name" title="重复项">重复项</span>
    </a>
  </li>
</ul>`

describe('学习通页面解析', () => {
  it('根据 URL 与页面结构判断登录态', () => {
    expect(
      detectLoginState('https://passport2.chaoxing.com/login?refer=x', '<html>登录</html>').state
    ).toBe('logged_out')
    expect(
      detectLoginState(
        'https://i.chaoxing.com/base',
        '<div aria-label="账号：张三"></div><div id="frame_content"></div>'
      ).state
    ).toBe('authenticated')
    expect(detectLoginState('https://i.chaoxing.com/base', '<html>空页面</html>').state).toBe(
      'unknown'
    )
  })

  it('解析个人资料但不返回敏感字段', () => {
    const profile = parseProfile(`
      <span aria-label="账号：张三"></span>
      <span id="siteName" title="示例大学"></span>
      <script>var uid = '9988';</script>
      <script>var fid = '427';</script>`)
    expect(profile).toEqual({ name: '张三', school: '示例大学', uid: '9988', fid: '427' })
  })

  it('从个人空间外壳解析课程 iframe 地址', () => {
    expect(
      parseCourseFrameUrl(
        '<iframe id="frame_content" src="https://mooc2-ans.chaoxing.com/visit/interaction?s=abc&amp;t=1"></iframe>'
      )
    ).toBe('https://mooc2-ans.chaoxing.com/visit/interaction?s=abc&t=1')
    expect(
      parseCourseFrameUrl('<iframe src="https://mooc2-ans.chaoxing.com/x" name="frame_content"></iframe>')
    ).toBe('https://mooc2-ans.chaoxing.com/x')
    expect(parseCourseFrameUrl('<iframe src="http://evil.example/x" id="frame_content"></iframe>')).toBeNull()
    expect(
      parseCourseFrameUrl(
        '<iframe id="frame_content" src=""></iframe><iframe id="frame_content" src="https://mooc2-ans.chaoxing.com/visit/interaction?s=ok"></iframe>'
      )
    ).toBe('https://mooc2-ans.chaoxing.com/visit/interaction?s=ok')
    expect(parseCourseFrameUrl('<div id="frame_content"></div>')).toBeNull()
    expect(
      parseCourseFrameUrl(
        '<div dataurl="https://mooc2-ans.chaoxing.com/visit/interaction?s=from-dataurl"></div>'
      )
    ).toBe('https://mooc2-ans.chaoxing.com/visit/interaction?s=from-dataurl')
  })

  it('解析课程列表并按 courseId + clazzId 去重', () => {
    const courses = parseCourseList(COURSE_HTML)
    expect(courses).toHaveLength(2)
    expect(courses[0]).toEqual({
      courseId: '1001',
      clazzId: '2001',
      cpi: '3001',
      name: '数据结构',
      teacher: '张老师'
    })
    expect(courses[1]?.clazzId).toBe('2002')
    expect(courses[1]?.name).toBe('数据结构（二班）')
  })

  it('兼容隐藏域 name/value 的不同顺序', () => {
    expect(readHiddenValue('<input value="abc" name="enc" />', 'enc')).toBe('abc')
    expect(readHiddenValue('<input name="enc" value="xyz" />', 'enc')).toBe('xyz')
    expect(readHiddenValue('<input name="other" value="no" />', 'enc')).toBeNull()
  })

  it('解析作业列表、进度与详情链接', () => {
    const html = `
      <div class="progress"><span>2/5</span></div>
      <ul>
        <li onclick="goTask(this);" data="https%3A%2F%2Fmooc1.chaoxing.com%2Fmooc2%2Fwork%2FdoHomeWork%3FworkId%3D123%26answerId%3D456">
          <p class="overHidden2 fl">第一次作业</p>
          <p class="status fl">未提交</p>
        </li>
        <li onclick="goTask(this);" data="/mooc2/work/doHomeWork?workId=789">
          <p class="overHidden2 fl">第二次作业</p>
          <p class="status fl">已完成</p>
        </li>
      </ul>`
    const result = parseHomeworkList(html)
    expect(result.progress).toEqual({ done: 2, total: 5 })
    expect(result.items).toHaveLength(2)
    expect(result.items[0]?.externalId).toBe('123')
    expect(result.items[0]?.url).toContain('https://mooc1.chaoxing.com/')
    expect(result.items[1]?.externalId).toBe('789')
    expect(classifyHomeworkStatus(result.items[0]?.status ?? '')).toBe('pending')
    expect(classifyHomeworkStatus(result.items[1]?.status ?? '')).toBe('done')
  })

  it('签名失效页抛出可识别错误，而不是返回空列表', () => {
    expect(() => parseHomeworkList('<html>没有此页面访问权限</html>')).toThrow(
      ChaoxingParseError
    )
    try {
      parseHomeworkList('<html>没有此页面访问权限</html>')
    } catch (error) {
      expect(error).toBeInstanceOf(ChaoxingParseError)
      expect((error as ChaoxingParseError).code).toBe('SIGNATURE_INVALID')
    }
  })

  it('解析作业详情中的标题、题量、满分与作答时间', () => {
    const html = `
      <div class="title">作业详情</div>
      <h1>第一章作业</h1>
      <div>题量：5</div>
      <div>满分：100</div>
      <div>作答时间: 11-20 08:00 至 11-27 23:59</div>`
    const detail = parseHomeworkDetail(html)
    expect(detail.title).toBe('第一章作业')
    expect(detail.questionCount).toBe(5)
    expect(detail.fullScore).toBe(100)
    expect(detail.deadlineText).toBe('11-27 23:59')
  })

  it('把无年份截止时间补齐到最接近当前时间的年份', () => {
    const now = new Date('2026-11-12T12:00:00+08:00')
    expect(resolveDeadline('11-27 23:59', now)).toBe('2026-11-27T15:59:00.000Z')
    expect(resolveDeadline('2026-03-01 08:00', now)).toBe('2026-03-01T00:00:00.000Z')
    expect(resolveDeadline('13-40 99:99', now)).toBeNull()
    expect(resolveDeadline(null, now)).toBeNull()
  })

  it('未知状态保持 unknown，不强行标记为未提交', () => {
    expect(classifyHomeworkStatus('')).toBe('unknown')
    expect(classifyHomeworkStatus('查看详情')).toBe('unknown')
    expect(classifyHomeworkStatus('已发布')).toBe('unknown')
    expect(classifyHomeworkStatus('待批阅')).toBe('done')
  })
})

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: crypto.randomUUID(),
    title: '任务',
    description: '',
    courseId: null,
    priority: 'medium',
    kind: 'homework',
    status: 'todo',
    dueAt: UNKNOWN_DUE_AT,
    completedAt: null,
    source: 'manual',
    externalId: null,
    completionSource: null,
    sourceUpdatedAt: null,
    sourceUrl: null,
    manualFields: [],
    fieldSources: {},
    platformStatus: null,
    platformStatusKind: 'unknown',
    createdAt: '2026-11-01T10:00:00+08:00',
    updatedAt: '2026-11-01T10:00:00+08:00',
    reminders: [],
    ...overrides
  }
}

describe('未知截止时间的领域处理', () => {
  it('哨兵值不计入逾期、不显示倒计时', () => {
    expect(isDueAtUnknown(UNKNOWN_DUE_AT)).toBe(true)
    expect(dueBucket(task())).toBe('upcoming')
    expect(formatRemainingCompact(UNKNOWN_DUE_AT)).toBe('截止时间待确认')
    const stats = computeTaskStats([task(), task({ dueAt: '2026-11-01T10:00:00+08:00' })])
    expect(stats.overdue).toBe(1)
  })
})

describe('学习通课程与任务落库', () => {
  it('同一课程不同教学班分别落库，重复同步只更新平台字段', () => {
    const store = new StudyNextStore(':memory:')
    try {
      const first = store.upsertProviderCourse({
        externalId: '1001:2001',
        name: '数据结构',
        teacher: '张老师',
        sourceUrl: 'https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=1001&clazzid=2001'
      })
      expect(first.created).toBe(true)
      const second = store.upsertProviderCourse({
        externalId: '1001:2002',
        name: '数据结构（二班）',
        teacher: '李老师',
        sourceUrl: null
      })
      expect(second.created).toBe(true)
      expect(store.listCourses().filter((course) => course.source === 'chaoxing')).toHaveLength(2)

      store.setCourseFavorite(first.course.id, true)
      const updated = store.upsertProviderCourse({
        externalId: '1001:2001',
        name: '数据结构（修订）',
        teacher: '张老师',
        sourceUrl: null
      })
      expect(updated.created).toBe(false)
      expect(updated.course.name).toBe('数据结构（修订）')
      expect(updated.course.favorite).toBe(true)
    } finally {
      store.close()
    }
  })

  it('外部 ID 去重并同步平台状态与截止时间变化', () => {
    const store = new StudyNextStore(':memory:')
    try {
      const first = store.upsertImportedTask(
        {
          title: '第一次作业',
          description: '',
          courseId: null,
          priority: 'medium',
          kind: 'homework',
          dueAt: '2026-11-20T15:59:00.000Z',
          status: 'todo',
          reminderOffsets: [1440],
          sourceUrl: 'https://mooc1.chaoxing.com/mooc2/work/view?workId=1'
        },
        {
          externalId: 'course-1:work-1',
          source: 'chaoxing',
          platformStatus: '未提交',
          platformStatusKind: 'pending'
        }
      )
      expect(first.action).toBe('created')
      expect(first.task.platformStatusKind).toBe('pending')
      expect(first.task.sourceUrl).toBe('https://mooc1.chaoxing.com/mooc2/work/view?workId=1')

      const second = store.upsertImportedTask(
        {
          title: '第一次作业',
          description: '',
          courseId: null,
          priority: 'medium',
          kind: 'homework',
          dueAt: '2026-11-21T15:59:00.000Z',
          status: 'todo',
          reminderOffsets: [1440]
        },
        {
          externalId: 'course-1:work-1',
          source: 'chaoxing',
          platformStatus: '已提交',
          platformStatusKind: 'done'
        }
      )
      expect(second.action).toBe('updated')
      expect(second.deadlineChanged).toBe(true)
      expect(second.task.platformStatus).toBe('已提交')
      expect(second.task.platformStatusKind).toBe('done')
      expect(second.task.sourceUrl).toBe('https://mooc1.chaoxing.com/mooc2/work/view?workId=1')
      expect(store.listTasks().filter((item) => item.externalId === 'course-1:work-1')).toHaveLength(
        1
      )
    } finally {
      store.close()
    }
  })
})

const AUTH_PROFILE = { name: '张三', school: '示例大学', uid: '1', fid: '427' }

function fakeAdapter(overrides: Partial<ChaoxingAdapterLike> = {}): ChaoxingAdapterLike {
  return {
    checkSession: async () => ({
      authState: 'authenticated',
      message: '已登录',
      profile: AUTH_PROFILE,
      httpStatus: 200,
      transport: 'session_fetch',
      cookieDomainCount: 2
    }),
    pull: async () => ({
      courses: [],
      tasks: [],
      errors: [],
      warnings: [],
      checkedAt: new Date().toISOString()
    }),
    ...overrides
  }
}

describe('学习通会话状态机', () => {
  it('未登录时明确返回 logged_out，而不是已认证', async () => {
    const store = new StudyNextStore(':memory:')
    try {
      const service = new ChaoxingSessionService(
        store,
        fakeAdapter({
          checkSession: async () => ({
            authState: 'logged_out',
            message: '请求被重定向到登录页',
            profile: { name: null, school: null, uid: null, fid: null },
            httpStatus: 200,
            transport: 'session_fetch',
            cookieDomainCount: 0
          })
        })
      )
      const status = await service.check()
      expect(status.authState).toBe('logged_out')
      expect(status.connection).toBe('web_session')
      expect(status.transport).toBe('session_fetch')
    } finally {
      store.close()
    }
  })

  it('从 authenticated 变为登出时标记 expired', async () => {
    const store = new StudyNextStore(':memory:')
    try {
      let loggedIn = true
      const service = new ChaoxingSessionService(
        store,
        fakeAdapter({
          checkSession: async () => ({
            authState: loggedIn ? 'authenticated' : 'logged_out',
            message: '探测结果',
            profile: loggedIn
              ? AUTH_PROFILE
              : { name: null, school: null, uid: null, fid: null },
            httpStatus: 200,
            transport: 'session_fetch',
            cookieDomainCount: loggedIn ? 2 : 0
          })
        })
      )
      expect((await service.check()).authState).toBe('authenticated')
      loggedIn = false
      const expired = await service.check()
      expect(expired.authState).toBe('expired')
      expect(expired.displayName).toBe('张三')
    } finally {
      store.close()
    }
  })

  it('同步未登录时记录 not_configured，且不影响本地已有数据', async () => {
    const store = new StudyNextStore(':memory:')
    try {
      const before = store.listTasks().length
      const outcomes: string[] = []
      const service = new ChaoxingSessionService(
        store,
        fakeAdapter({
          pull: async () => {
            throw new ChaoxingAccessError('NOT_LOGGED_IN', '登录页')
          }
        }),
        (outcome) => outcomes.push(outcome.state)
      )
      const status = await service.sync()
      expect(status.authState).toBe('logged_out')
      expect(outcomes).toEqual(['not_configured'])
      expect(store.listTasks()).toHaveLength(before)
      expect(status.lastSyncAt).toBeNull()
    } finally {
      store.close()
    }
  })

  it('安全验证页立即停止并提示本人处理', async () => {
    const store = new StudyNextStore(':memory:')
    try {
      const service = new ChaoxingSessionService(
        store,
        fakeAdapter({
          pull: async () => {
            throw new ChaoxingAccessError('BLOCKED', '检测到 9010')
          }
        })
      )
      const status = await service.sync()
      expect(status.message).toContain('安全验证')
      expect(status.detail).toContain('9010')
    } finally {
      store.close()
    }
  })

  it('同步成功后写入课程与作业，并记录最近成功时间', async () => {
    const store = new StudyNextStore(':memory:')
    try {
      const checkedAt = new Date().toISOString()
      const result: ChaoxingPullResult = {
        courses: [
          {
            externalId: '1001:2001',
            courseId: '1001',
            clazzId: '2001',
            cpi: '3001',
            name: '数据结构',
            teacher: '张老师',
            schedule: [],
            sourceUrl: 'https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=1001&clazzid=2001'
          }
        ],
        tasks: [
          {
            externalId: '1001:2001:work-1',
            title: '第一次作业',
            description: '',
            courseExternalId: '1001:2001',
            dueAt: '2026-11-20T15:59:00.000Z',
            platformStatus: '未提交',
            platformStatusKind: 'pending',
            sourceUrl: null
          }
        ],
        errors: [],
        warnings: [],
        checkedAt
      }
      const service = new ChaoxingSessionService(
        store,
        fakeAdapter({ pull: async () => result })
      )
      const status = await service.sync()
      expect(status.authState).toBe('authenticated')
      expect(status.syncedCourses).toBe(1)
      expect(status.syncedTasks).toBe(1)
      expect(status.lastSyncAt).not.toBeNull()
      const task = store.findTaskByExternalId('chaoxing', '1001:2001:work-1')
      expect(task?.platformStatusKind).toBe('pending')
      expect(task?.dueAt).toBe('2026-11-20T15:59:00.000Z')
    } finally {
      store.close()
    }
  })
})

describe('学习通登录页自动填充', () => {
  it('只在官方 passport 登录页匹配', () => {
    expect(isChaoxingLoginUrl('https://passport2.chaoxing.com/login?fid=0')).toBe(true)
    expect(isChaoxingLoginUrl('https://i.chaoxing.com/base')).toBe(false)
    expect(isChaoxingLoginUrl('https://evil.example.com/login')).toBe(false)
    expect(isChaoxingLoginUrl('http://passport2.chaoxing.com/login')).toBe(false)
  })

  it('把账号密码安全地嵌入填充脚本', () => {
    const script = buildCredentialFillScript('138"0000', 'p\\a<script>w')
    expect(script).toContain('138\\"0000')
    expect(script).toContain('p\\\\a<script>w')
    expect(script).toContain('input#phone')
    expect(script).toContain('input#pwd')
    expect(script).toContain("dispatchEvent(new Event('input'")
  })
})

describe('学习通课表解析', () => {
  it('解析学期锚点、节次表和课程节次', () => {
    const payload = parseSchedulePayload({
      result: 1,
      data: {
        curriculum: {
          maxWeek: 16,
          currentWeek: 10,
          firstWeekDate: Date.UTC(2026, 7, 30, 16),
          lessonTimeConfigArray: ['8:00-8:50', '9:00-9:50', '10:00-10:50']
        },
        lessonArray: [
          {
            lessonId: 9001,
            name: '高等数学Ⅰ（上）',
            teacherName: '李老师',
            location: '博学楼 201',
            dayOfWeek: 2,
            beginNumber: 1,
            length: 2
          }
        ]
      }
    })
    expect(payload.semesterStart).toBe('2026-08-31')
    expect(payload.maxWeek).toBe(16)
    expect(payload.sections[0]).toEqual({ start: '08:00', end: '08:50' })
    expect(payload.lessons).toHaveLength(1)
    expect(payload.lessons[0]?.dayOfWeek).toBe(2)
  })

  it('把课表页逐周返回的 JSON 合并为同一门课的周次', () => {
    const schedule = parseScheduleWeeksPayload(
      JSON.stringify({
        curriculum: {
          maxWeek: 16,
          currentWeek: 11,
          firstWeekDate: Date.UTC(2026, 7, 30, 16),
          lessonTimeConfigArray: ['8:00-8:50', '9:00-9:50']
        },
        weeks: [
          {
            week: 1,
            lessons: [
              {
                lessonId: 9001,
                name: '高等数学Ⅰ（上）',
                teacherName: '李老师',
                location: '博学楼 201',
                dayOfWeek: 2,
                beginNumber: 1,
                length: 2
              }
            ]
          },
          {
            week: 2,
            lessons: [
              {
                lessonId: 9001,
                name: '高等数学Ⅰ（上）',
                teacherName: '李老师',
                location: '博学楼 201',
                dayOfWeek: 2,
                beginNumber: 1,
                length: 2
              }
            ]
          },
          {
            week: 3,
            lessons: [
              {
                lessonId: 9001,
                name: '高等数学Ⅰ（上）',
                teacherName: '李老师',
                location: '博学楼 201',
                dayOfWeek: 2,
                beginNumber: 1,
                length: 2
              }
            ]
          }
        ]
      })
    )
    expect(schedule.semesterStart).toBe('2026-08-31')
    expect(schedule.maxWeek).toBe(16)
    expect(schedule.lessons).toHaveLength(1)
    expect(schedule.lessons[0]?.weekNumbers).toEqual([1, 2, 3])
    expect(schedule.lessons[0]?.weeks).toBe('1-3')
  })

  it('把节次映射为起止时间，并压缩周次', () => {
    const sections = parseSectionTimes(['8:00-8:50', '9:00-9:50', '10:00-10:50'])
    const session = lessonToSession(
      {
        lessonId: '9001',
        name: '高等数学',
        teacherName: '李老师',
        location: '博学楼 201',
        dayOfWeek: 2,
        beginNumber: 1,
        length: 2,
        weeks: '',
        courseId: null,
        weekNumbers: [1, 2, 3, 5, 8, 9]
      },
      sections
    )
    expect(session).toMatchObject({
      weekday: 2,
      startTime: '08:00',
      endTime: '09:50',
      location: '博学楼 201',
      weeks: '1-3,5,8-9'
    })
    expect(compressWeeks([1, 2, 3, 5, 8, 9])).toBe('1-3,5,8-9')
  })

  it('按周次判断课程是否出现在某一周', () => {
    expect(weekInSchedule('1-16', 10)).toBe(true)
    expect(weekInSchedule('1-8,10-12', 9)).toBe(false)
    expect(weekInSchedule('', 9)).toBe(true)
    expect(semesterWeekOf(new Date('2026-11-03T12:00:00+08:00'), '2026-08-31')).toBe(10)
  })
})
