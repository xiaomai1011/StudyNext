import { describe, expect, it } from 'vitest'
import {
  ChaoxingParseError,
  classifyHomeworkStatus,
  detectLoginState,
  parseCourseFrameUrl,
  parseCourseList,
  parseExamList,
  parseChapterList,
  parseMaterialList,
  parseNoticeList,
  parseHomeworkDetail,
  parseHomeworkList,
  parseTaskAttachments,
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
    expect(classifyHomeworkStatus(result.items[0]?.status ?? '')).toBe('not_submitted')
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

  it('解析作业详情中的提交时间、成绩与教师批语', () => {
    const html = `
      <div>作业详情</div><h1>实验四</h1>
      <div>满分：100</div>
      <div>提交时间：2026-11-01 15:02</div>
      <div>得分：88</div>
      <div>教师批语：思路清晰，注意边界条件。</div>`
    const detail = parseHomeworkDetail(html)
    expect(detail.submittedAtText).toBe('2026-11-01 15:02')
    expect(detail.score).toBe('88')
    expect(detail.fullScore).toBe(100)
    expect(detail.teacherFeedback).toBe('思路清晰，注意边界条件。')
  })

  it('解析作业详情中的提交附件并去重', () => {
    const html = `
      <div class="attach" data="obj-1"><span class="dataName">实验报告.docx</span><span class="dataSize">20.79K</span></div>
      <iframe class="attach-iframe" objectid="obj-2" filename="截图.png" filesize="56B"></iframe>
      <iframe class="attach-iframe" objectid="obj-2" filename="截图.png" filesize="56B"></iframe>`
    const attachments = parseTaskAttachments(html)
    expect(attachments).toEqual([
      { name: '实验报告.docx', size: '20.79K', objectId: 'obj-1' },
      { name: '截图.png', size: '56B', objectId: 'obj-2' }
    ])
  })

  it('附件解析保留文件类型对应名称，缺失大小时不伪造', () => {
    const attachments = parseTaskAttachments(
      '<iframe class="attach-iframe" objectid="obj-pdf" filename="课程讲义.pdf" filesize=""></iframe>'
    )
    expect(attachments).toEqual([{ name: '课程讲义.pdf', size: null, objectId: 'obj-pdf' }])
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
    expect(classifyHomeworkStatus('待批阅')).toBe('pending_review')
    expect(classifyHomeworkStatus('已批阅')).toBe('reviewed')
    expect(classifyHomeworkStatus('已提交')).toBe('submitted')
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
    submittedAt: null,
    score: null,
    fullScore: null,
    teacherFeedback: null,
    attachments: [],
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
          platformStatusKind: 'not_submitted'
        }
      )
      expect(first.action).toBe('created')
      expect(first.task.platformStatusKind).toBe('not_submitted')
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

  it('单课程重试失败时抛出明确错误且不宣称同步成功', async () => {
    const store = new StudyNextStore(':memory:')
    try {
      const { course } = store.upsertProviderCourse(
        {
          externalId: '1001:2001',
          name: '数据结构',
          teacher: '张老师',
          schedule: [],
          sourceUrl: 'https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=1001&clazzid=2001'
        },
        'chaoxing'
      )
      const service = new ChaoxingSessionService(
        store,
        fakeAdapter({
          pullCourse: async () => {
            throw new ChaoxingAccessError('NETWORK', '网络失败')
          }
        })
      )
      await expect(service.retryCourse(course.id)).rejects.toThrow('课程重试失败')
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
            platformStatusKind: 'not_submitted',
            sourceUrl: null,
            submittedAt: null,
            score: null,
            fullScore: null,
            teacherFeedback: null,
            attachments: []
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
      expect(task?.platformStatusKind).toBe('not_submitted')
      expect(task?.dueAt).toBe('2026-11-20T15:59:00.000Z')
    } finally {
      store.close()
    }
  })

  it('5 分钟内重复同步使用短期缓存，force 可强制刷新', async () => {
    const store = new StudyNextStore(':memory:')
    try {
      let pulls = 0
      const result: ChaoxingPullResult = {
        courses: [],
        tasks: [],
        errors: [],
        warnings: [],
        checkedAt: new Date().toISOString()
      }
      const service = new ChaoxingSessionService(
        store,
        fakeAdapter({
          pull: async () => {
            pulls += 1
            return result
          }
        })
      )
      await service.sync()
      const cached = await service.sync()
      expect(cached.message).toContain('短期缓存')
      expect(pulls).toBe(1)
      await service.sync(true)
      expect(pulls).toBe(2)
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

  it('解析章节目录、二级小节与任务点状态', () => {
    const html = `
      <div class="progress">已完成任务点: <span>3</span>/7</div>
      <div class="catalog_num fl"><span><i><em>1</em></i></span></div>
      <div class="catalog_name newCatalog_name"><a class="clicktitle"><span title="第一章 绪论">第一章 绪论</span></a></div>
      <div class="chapter_item" title="1.1 课程介绍"><span class="catalog_sbar">1.1</span><i class="icon_yiwanc"></i></div>
      <div class="chapter_item" title="1.2 学习要求"><span class="catalog_sbar">1.2</span><span class="catalog_points_yi">2</span></div>
      <div class="catalog_num fl"><span><i><em>2</em></i></span></div>
      <div class="catalog_name newCatalog_name"><a class="clicktitle"><span title="第二章 基础">第二章 基础</span></a></div>
      <div class="chapter_item" title="2.1 基本概念"><span class="catalog_sbar">2.1</span><i class="icon_yiwanc"></i></div>
      <div class="chapter_item" title="2.2 暂未开放"><span class="catalog_sbar">2.2</span>暂未开放</div>
    `
    const parsed = parseChapterList(html)
    expect(parsed.done).toBe(3)
    expect(parsed.total).toBe(7)
    expect(parsed.chapters).toHaveLength(2)
    expect(parsed.chapters[0]?.title).toBe('第一章 绪论')
    expect(parsed.chapters[0]?.sections).toHaveLength(2)
    expect(parsed.chapters[0]?.sections[0]?.completed).toBe(true)
    expect(parsed.chapters[0]?.sections[1]?.pendingCount).toBe(2)
    expect(parsed.chapters[1]?.sections[1]?.locked).toBe(true)
  })

  it('章节页没有节点时返回空目录', () => {
    expect(parseChapterList('<div>暂无章节</div>')).toEqual({ chapters: [], done: 0, total: 0 })
  })

  it('解析通知列表并保留未读状态与课程归属', () => {
    const raw = JSON.stringify({
      status: true,
      notices: {
        list: [
          {
            uuid: '$CACG$notice-1',
            title: '作业:《程序设计基础》实验4',
            content: '课程名称：程序设计基础\r作业名称：实验4',
            createrName: '学习通知',
            sendTime: '2026-11-12 08:25:57',
            isread: 0,
            receiverArray: [{ name: '程序设计基础-26计科10班(智能系统)' }],
            attachment: JSON.stringify([
              { att_web: { url: 'https://mooc1-api.chaoxing.com/examApi/intoexamorwork?x=1' } }
            ])
          },
          {
            uuid: '$CACG$notice-2',
            title: '系统维护通知',
            content: '',
            rtf_content: '<p>今晚 23:00 维护</p>',
            sendTime: '2026-11-11 10:00:00',
            isread: 1
          }
        ]
      }
    })
    const parsed = parseNoticeList(raw)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]?.read).toBe(false)
    expect(parsed[0]?.courseName).toContain('程序设计基础')
    expect(parsed[0]?.url).toContain('intoexamorwork')
    expect(parsed[1]?.body).toBe('今晚 23:00 维护')
    expect(parsed[1]?.courseName).toBeNull()
    expect(parseNoticeList('not-json')).toEqual([])
  })

  it('解析考试列表的时间、状态和详情入口', () => {
    const html = `
      <table class="dataTable">
        <tbody>
          <tr class="dataTr">
            <td>1</td>
            <td><a href="/exam-ans/exam/test/examcode/examdetail?examId=88001">高等数学期中考试</a></td>
            <td>2026-11-20 14:00 至 2026-11-20 15:40</td>
            <td>100</td>
            <td>待进行</td>
            <td>未交</td>
            <td></td>
            <td>闭卷</td>
            <td><a href="/exam-ans/exam/test/examcode/examdetail?examId=88001">进入</a></td>
          </tr>
          <tr class="dataTr">
            <td>2</td>
            <td>大学英语随堂测验</td>
            <td>2026-10-12 09:00 至 2026-10-12 09:30</td>
            <td>30</td>
            <td>已结束</td>
            <td>已完成</td>
            <td>92</td>
            <td>在线</td>
            <td></td>
          </tr>
        </tbody>
      </table>
    `
    const exams = parseExamList(html)
    expect(exams).toHaveLength(2)
    expect(exams[0]).toMatchObject({
      externalId: '88001',
      title: '高等数学期中考试',
      startAt: '2026-11-20T06:00:00.000Z',
      endAt: '2026-11-20T07:40:00.000Z',
      durationMinutes: 100,
      examStatus: '待进行',
      answerStatus: '未交',
      score: null,
      mode: '闭卷',
      sourceUrl: 'https://mooc1-api.chaoxing.com/exam-ans/exam/test/examcode/examdetail?examId=88001'
    })
    expect(exams[1]?.externalId).toMatch(/^exam:[0-9a-f]+$/)
    expect(exams[1]?.score).toBe('92')
  })

  it('考试空列表返回空数组，缺少时间或列数的行跳过', () => {
    expect(parseExamList('<div>暂无符合条件的考试</div>')).toEqual([])
    expect(
      parseExamList(
        '<table><tr class="dataTr"><td>1</td><td>只有标题</td><td>没有时间</td></tr></table>'
      )
    ).toEqual([])
  })

  it('解析资料列表的文件夹、文件、外链和大小', () => {
    const html = `
      <div class="dataBody">
        <ul class="dataBody_td" type="afolder" id="1372755436" dataname="课件">
          <li class="dataBody_file" onclick="toOpen('%E8%AF%BE%E4%BB%B6','afolder',1372755436,'','','',2,1,'154619115','enc','','1794478873280','')"></li>
          <li class="dataBody_size_stu"> - </li>
        </ul>
        <ul class="dataBody_td" type="doc" id="1360097062" dataname="复习测试题.doc">
          <li class="dataBody_file" onclick="toOpen('%E5%A4%8D%E4%B9%A0%E6%B5%8B%E8%AF%95%E9%A2%98.doc','doc',1360097062,'','f06af491','',2,1,'154619115','enc','','1794478873280','')"></li>
          <li class="dataBody_size_stu"> 47KB </li>
        </ul>
        <ul class="dataBody_td" type="url" id="1360097020" dataname="python模块函数">
          <li class="dataBody_file" onclick="toOpen('python%E6%A8%A1%E5%9D%97%E5%87%BD%E6%95%B0','url',1360097020,'','','https://docs.python.org/zh-cn/3.13/py-modindex.html',2,0,'154619115','enc','','1794478873280','')"></li>
          <li class="dataBody_size_stu"> - </li>
        </ul>
      </div>
    `
    const items = parseMaterialList(html)
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({
      externalId: 'material:1372755436',
      name: '课件',
      kind: 'folder',
      fileType: 'afolder'
    })
    expect(items[1]).toMatchObject({
      externalId: 'material:1360097062',
      name: '复习测试题.doc',
      kind: 'file',
      fileType: 'doc',
      size: '47KB'
    })
    expect(items[2]).toMatchObject({
      externalId: 'material:1360097020',
      name: 'python模块函数',
      kind: 'link',
      url: 'https://docs.python.org/zh-cn/3.13/py-modindex.html'
    })
  })

  it('资料分页合并时按 externalId 去重，并对部分页失败保持容错', () => {
    const pageOne = `
      <ul class="dataBody_td" type="doc" id="2001" dataname="第一页.doc">
        <li class="dataBody_size_stu"> 10KB </li>
      </ul>
      <ul class="dataBody_td" type="doc" id="2002" dataname="重复条目.pdf">
        <li class="dataBody_size_stu"> 20KB </li>
      </ul>
    `
    const pageTwo = `
      <ul class="dataBody_td" type="doc" id="2002" dataname="重复条目.pdf">
        <li class="dataBody_size_stu"> 20KB </li>
      </ul>
      <ul class="dataBody_td" type="pdf" id="2003" dataname="第二页.pdf">
        <li class="dataBody_size_stu"> 30KB </li>
      </ul>
    `
    const merged = parseMaterialList(pageOne + pageTwo)
    expect(merged.map((item) => item.externalId)).toEqual([
      'material:2001',
      'material:2002',
      'material:2003'
    ])
    expect(merged).toHaveLength(3)

    const truncated = '<ul class="dataBody_td" type="doc" id="2004" dataname="截断'
    expect(parseMaterialList(pageOne + truncated)).toHaveLength(2)
    expect(parseMaterialList('')).toEqual([])
  })

  it('按周次判断课程是否出现在某一周', () => {
    expect(weekInSchedule('1-16', 10)).toBe(true)
    expect(weekInSchedule('1-8,10-12', 9)).toBe(false)
    expect(weekInSchedule('', 9)).toBe(true)
    expect(semesterWeekOf(new Date('2026-11-03T12:00:00+08:00'), '2026-08-31')).toBe(10)
  })
})
