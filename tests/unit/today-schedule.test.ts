import { describe, expect, it } from 'vitest'
import type { AppNotice, Course, Exam, Task } from '@shared/types'
import { UNKNOWN_DUE_AT } from '@shared/constants'
import {
  buildCourseDisplayMap,
  buildDaySessions,
  classifyExamBucket,
  findNextUpcomingClass,
  getUpcomingDashboardExams,
  groupExamsByLocalDay,
  groupTasksByLocalDay,
  hasRealExamScore,
  normalizeExamScore,
  partitionTimelineTasks,
  prioritizeDashboardNotices,
  resolveDefaultCalendarSemesterKey,
  resolveEffectiveCalendarSemesterKey,
  selectCoursesActiveAt,
  sliceMonthCellEvents
} from '@shared/today-schedule'

// 2026-11-25 is Wednesday (weekday 3)
const WED_MORNING = new Date('2026-11-25T09:10:00+08:00')
const WED_EVENING = new Date('2026-11-25T21:30:00+08:00')

function makeCourse(overrides: Partial<Course> = {}): Course {
  return {
    id: 'course-1',
    externalId: 'cx-1',
    name: '数据结构',
    code: 'CS201',
    teacher: '张老师',
    semester: '2026秋',
    category: '专业必修',
    color: '#2563eb',
    favorite: false,
    clazzId: '1001',
    className: '计科2301班',
    semesterStart: '2026-09-07',
    maxWeek: 18,
    schedule: [],
    source: 'chaoxing',
    sourceUrl: 'https://mooc1.chaoxing.com/course/1001.html',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    ...overrides
  }
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: '实验报告',
    description: '',
    courseId: 'course-1',
    priority: 'medium',
    kind: 'homework',
    status: 'todo',
    dueAt: '2026-11-25T23:59:00+08:00',
    completedAt: null,
    completionSource: null,
    source: 'chaoxing',
    externalId: 'cx-work-1',
    sourceUrl: 'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/task?workId=1',
    sourceUpdatedAt: null,
    platformStatus: '未交',
    platformStatusKind: 'not_submitted',
    submittedAt: null,
    score: null,
    fullScore: '100',
    teacherFeedback: null,
    attachments: [],
    reminders: [],
    manualFields: [],
    fieldSources: {},
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:00.000Z',
    ...overrides
  }
}

function makeExam(overrides: Partial<Exam> = {}): Exam {
  return {
    id: 'exam-1',
    externalId: 'cx-exam-1',
    title: '数据结构期中考试',
    courseName: '数据结构',
    startAt: '2026-11-27T14:00:00+08:00',
    endAt: '2026-11-27T16:00:00+08:00',
    durationMinutes: 120,
    examStatus: '未开始',
    answerStatus: '',
    score: null,
    mode: '线上考试',
    source: 'chaoxing',
    sourceUrl: 'https://mooc1.chaoxing.com/exam/1',
    updatedAt: '2026-11-24T00:00:00.000Z',
    ...overrides
  }
}

function makeNotice(overrides: Partial<AppNotice> = {}): AppNotice {
  return {
    id: 'notice-1',
    title: '作业截止提醒',
    body: '请按时提交',
    category: 'course',
    courseName: '数据结构',
    sender: '张老师',
    publishedAt: '2026-11-24T10:00:00+08:00',
    url: null,
    read: true,
    isDemo: false,
    source: 'chaoxing',
    ...overrides
  }
}

describe('today-schedule', () => {
  it('computes live, single immediate next, later, and done states with per-course pending counts', () => {
    const c1 = makeCourse({
      id: 'c1',
      name: '数据结构',
      schedule: [
        {
          id: 's1',
          weekday: 3,
          startTime: '08:20',
          endTime: '10:00',
          location: '一教101',
          weeks: '1-16'
        },
        {
          id: 's2',
          weekday: 3,
          startTime: '10:20',
          endTime: '12:00',
          location: '一教102',
          weeks: '1-16'
        },
        {
          id: 's3',
          weekday: 3,
          startTime: '14:00',
          endTime: '15:40',
          location: '一教103',
          weeks: '1-16'
        }
      ]
    })
    const tasks = [
      makeTask({ id: 't1', courseId: 'c1', platformStatusKind: 'not_submitted' }),
      makeTask({ id: 't2', courseId: 'c1', platformStatusKind: 'submitted' })
    ]

    const sessions = buildDaySessions([c1], tasks, WED_MORNING, WED_MORNING)
    expect(sessions.map((s) => s.state)).toEqual(['live', 'next', 'later'])
    expect(sessions[0]?.timeHint).toContain('上课中')
    expect(sessions[1]?.timeHint).toContain('后上课')
    expect(sessions[2]?.timeHint).toBe('待上课')
    expect(sessions[0]?.pendingTaskCount).toBe(1)
  })

  it('finds next upcoming class across semesters without letting a pre-enrolled future semester mask active courses', () => {
    const currentSemCourse = makeCourse({
      id: 'c-cur',
      name: '数据结构',
      semester: '2026秋',
      semesterStart: '2026-09-07',
      maxWeek: 18,
      schedule: [
        {
          id: 's-fri',
          weekday: 5,
          startTime: '10:20',
          endTime: '12:00',
          location: 'C201',
          weeks: '1-16'
        }
      ]
    })
    const futurePreEnrolledCourse = makeCourse({
      id: 'c-future',
      name: '编译原理',
      semester: '2027春',
      semesterStart: '2027-02-24',
      maxWeek: 18,
      schedule: [
        {
          id: 's-thu',
          weekday: 4,
          startTime: '08:20',
          endTime: '10:00',
          location: 'D101',
          weeks: '1-16'
        }
      ]
    })
    const endedCourse = makeCourse({
      id: 'c-ended',
      name: '已结课课程',
      semester: '2026秋',
      semesterStart: '2026-09-07',
      maxWeek: 8,
      schedule: [
        {
          id: 's-ended',
          weekday: 4,
          startTime: '08:20',
          endTime: '10:00',
          location: 'B101',
          weeks: '1-8'
        }
      ]
    })

    const allCourses = [futurePreEnrolledCourse, endedCourse, currentSemCourse]
    expect(selectCoursesActiveAt(allCourses, WED_EVENING).map((c) => c.id)).toEqual(['c-cur'])
    expect(resolveDefaultCalendarSemesterKey(allCourses, WED_EVENING)).toBe('2026秋')

    const next = findNextUpcomingClass(allCourses, WED_EVENING, 7)
    expect(next?.kind).toBe('upcoming_day')
    expect(next?.dayOffset).toBe(2)
    expect(next?.dayLabel).toBe('后天')
    expect(next?.course.id).toBe('c-cur')
  })

  it('transitions into a new semester starting within the 7-day lookahead window', () => {
    const nextMondayCourse = makeCourse({
      id: 'c-next-sem',
      name: '机器学习',
      semester: '2026冬',
      semesterStart: '2026-11-30',
      maxWeek: 16,
      schedule: [
        {
          id: 's-mon',
          weekday: 1,
          startTime: '08:20',
          endTime: '10:00',
          location: 'E301',
          weeks: '1-16'
        }
      ]
    })

    const next = findNextUpcomingClass([nextMondayCourse], WED_EVENING, 7)
    expect(next?.kind).toBe('upcoming_day')
    expect(next?.dayOffset).toBe(5)
    expect(next?.course.id).toBe('c-next-sem')
  })

  it('excludes historical exams lacking endAt or carrying terminal platform status so real upcoming exams are never crowded out', () => {
    const c1 = makeCourse({ id: 'c1', name: '高等数学', className: '1班' })
    const c2 = makeCourse({ id: 'c2', name: '高等数学', className: '2班' })
    const c3 = makeCourse({ id: 'c3', name: '数据结构' })

    const historicalNoEnd = makeExam({
      id: 'e-old-no-end',
      title: '半年前无结束时间考试',
      courseName: '数据结构',
      startAt: '2026-05-10T09:00:00+08:00',
      endAt: null,
      examStatus: '',
      answerStatus: ''
    })
    const historicalTerminalStatus = makeExam({
      id: 'e-terminal',
      title: '已结束但无结束时间',
      courseName: '数据结构',
      startAt: '2026-11-25T08:00:00+08:00',
      endAt: null,
      examStatus: '已结束',
      answerStatus: ''
    })
    const submittedEarlyWithFutureEnd = makeExam({
      id: 'e-submitted',
      title: '已交卷考试',
      courseName: '数据结构',
      startAt: '2026-11-25T08:30:00+08:00',
      endAt: '2026-11-25T10:30:00+08:00',
      examStatus: '进行中',
      answerStatus: '已提交',
      score: '92'
    })
    const explicitOngoingNoEnd = makeExam({
      id: 'e-explicit-live',
      title: '平台明确进行中考试',
      courseName: '数据结构',
      startAt: '2026-11-25T08:30:00+08:00',
      endAt: null,
      examStatus: '进行中',
      answerStatus: ''
    })
    const upcoming1 = makeExam({
      id: 'e-up-1',
      title: '高数期中',
      courseName: '高等数学',
      startAt: '2026-11-27T09:00:00+08:00',
      endAt: '2026-11-27T11:00:00+08:00'
    })
    const upcoming2 = makeExam({
      id: 'e-up-2',
      title: '数据结构小测',
      courseName: '数据结构',
      startAt: '2026-11-29T14:00:00+08:00',
      endAt: '2026-11-29T15:30:00+08:00'
    })

    expect(classifyExamBucket(historicalNoEnd, WED_MORNING.getTime())).toBe('unknown')
    expect(classifyExamBucket(historicalTerminalStatus, WED_MORNING.getTime())).toBe('past')
    expect(classifyExamBucket(submittedEarlyWithFutureEnd, WED_MORNING.getTime())).toBe('past')
    expect(classifyExamBucket(explicitOngoingNoEnd, WED_MORNING.getTime())).toBe('ongoing')

    const result = getUpcomingDashboardExams(
      [
        historicalNoEnd,
        historicalTerminalStatus,
        submittedEarlyWithFutureEnd,
        upcoming2,
        upcoming1,
        explicitOngoingNoEnd
      ],
      [c1, c2, c3],
      WED_MORNING,
      { windowDays: 14, limit: 3 }
    )
    expect(result.ongoingCount).toBe(1)
    expect(result.items.map((item) => item.exam.id)).toEqual([
      'e-explicit-live',
      'e-up-1',
      'e-up-2'
    ])
    expect(result.items[0]?.course?.id).toBe('c3')
    expect(result.items[1]?.course).toBeNull() // ambiguous same-name course must not guess
  })

  it('disambiguates same-name teaching classes even when className collides', () => {
    const unique = makeCourse({ id: 'c-uniq', name: '操作系统', className: '1班', clazzId: '5001' })
    const dupA = makeCourse({
      id: 'course-aaaa1111',
      name: '数据结构',
      code: 'CS201',
      className: '1班',
      clazzId: '9001'
    })
    const dupB = makeCourse({
      id: 'course-bbbb2222',
      name: '数据结构',
      code: 'CS201',
      className: '1班',
      clazzId: '9002'
    })
    const identicalMetaA = makeCourse({
      id: 'course-id-alpha01',
      name: '线性代数',
      code: '',
      className: 'A班',
      clazzId: '8888'
    })
    const identicalMetaB = makeCourse({
      id: 'course-id-beta002',
      name: '线性代数',
      code: '',
      className: 'A班',
      clazzId: '8888'
    })

    const map = buildCourseDisplayMap([unique, dupA, dupB, identicalMetaA, identicalMetaB])
    expect(map.get('c-uniq')?.classTag).toBeNull()
    expect(map.get('course-aaaa1111')?.classTag).toContain('9001')
    expect(map.get('course-bbbb2222')?.classTag).toContain('9002')
    expect(map.get('course-aaaa1111')?.fullLabel).not.toBe(map.get('course-bbbb2222')?.fullLabel)
    expect(map.get('course-id-alpha01')?.classTag).not.toBe(map.get('course-id-beta002')?.classTag)
    expect(map.get('course-id-alpha01')?.classTag).toContain('ID ')
  })

  it('computes exact month cell hidden counts for any combination of exams and tasks', () => {
    const ex = ['e1', 'e2', 'e3', 'e4']
    const tk = ['t1', 't2', 't3', 't4']

    // 2 exams, 0 tasks -> both rendered, 0 hidden
    expect(sliceMonthCellEvents(ex.slice(0, 2), [], 3)).toEqual({
      visibleExams: ['e1', 'e2'],
      visibleTasks: [],
      hiddenCount: 0
    })
    // 4 exams, 0 tasks -> 3 exams rendered, 1 hidden
    expect(sliceMonthCellEvents(ex, [], 3)).toEqual({
      visibleExams: ['e1', 'e2', 'e3'],
      visibleTasks: [],
      hiddenCount: 1
    })
    // 2 exams, 1 task -> 2 exams + 1 task rendered, 0 hidden
    expect(sliceMonthCellEvents(ex.slice(0, 2), tk.slice(0, 1), 3)).toEqual({
      visibleExams: ['e1', 'e2'],
      visibleTasks: ['t1'],
      hiddenCount: 0
    })
    // 2 exams, 2 tasks -> 1 exam + 2 tasks rendered, 1 exam hidden
    expect(sliceMonthCellEvents(ex.slice(0, 2), tk.slice(0, 2), 3)).toEqual({
      visibleExams: ['e1'],
      visibleTasks: ['t1', 't2'],
      hiddenCount: 1
    })
    // 3 exams, 2 tasks -> 1 exam + 2 tasks rendered, 2 hidden
    expect(sliceMonthCellEvents(ex.slice(0, 3), tk.slice(0, 2), 3)).toEqual({
      visibleExams: ['e1'],
      visibleTasks: ['t1', 't2'],
      hiddenCount: 2
    })
  })

  it('prioritizes unread notices ahead of newer read notices', () => {
    const readNewest = makeNotice({
      id: 'n-read',
      read: true,
      publishedAt: '2026-11-25T08:00:00+08:00'
    })
    const unreadOlder = makeNotice({
      id: 'n-unread',
      read: false,
      publishedAt: '2026-11-23T12:00:00+08:00'
    })

    const res = prioritizeDashboardNotices([readNewest, unreadOlder], 4)
    expect(res.unreadCount).toBe(1)
    expect(res.items.map((n) => n.id)).toEqual(['n-unread', 'n-read'])
  })

  it('partitions 23:59 evening deadlines into afterHours instead of dropping them and groups exams/tasks by day', () => {
    const afternoonTask = makeTask({
      id: 't-15',
      dueAt: '2026-11-25T15:00:00+08:00'
    })
    const midnightTask = makeTask({
      id: 't-2359',
      dueAt: '2026-11-25T23:59:00+08:00'
    })
    const unknownTask = makeTask({
      id: 't-unknown',
      dueAt: UNKNOWN_DUE_AT
    })

    const byDay = groupTasksByLocalDay([afternoonTask, midnightTask, unknownTask])
    expect(byDay.get('2026-11-25')?.map((t) => t.id)).toEqual(['t-15', 't-2359'])

    const partitioned = partitionTimelineTasks(byDay.get('2026-11-25') ?? [], 8, 21)
    expect(partitioned.timed.map((t) => t.id)).toEqual(['t-15'])
    expect(partitioned.afterHours.map((t) => t.id)).toEqual(['t-2359'])

    const examsByDay = groupExamsByLocalDay([makeExam()], [makeCourse()], WED_MORNING)
    expect(examsByDay.get('2026-11-27')?.length).toBe(1)
  })

  it('invalidates stale ongoing exam snapshots without endAt using fixed clock so tomorrow exams are never crowded out', () => {
    const fixedNow = new Date('2026-11-25T14:00:00+08:00')
    const course = makeCourse({ id: 'c1', name: '数据结构' })

    // Stale ongoing snapshot #1: yesterday 09:00, duration 90m, updated yesterday 09:10
    const staleYesterday = makeExam({
      id: 'e-stale-1',
      title: '昨日陈旧进行中快照',
      startAt: '2026-11-24T09:00:00+08:00',
      endAt: null,
      durationMinutes: 90,
      examStatus: '进行中',
      updatedAt: '2026-11-24T09:10:00+08:00'
    })
    // Stale ongoing snapshot #2: 4h ago, no duration, updated 4h ago
    const staleNoDuration = makeExam({
      id: 'e-stale-2',
      title: '超时无时长进行中快照',
      startAt: '2026-11-25T10:00:00+08:00',
      endAt: null,
      durationMinutes: null,
      examStatus: '进行中',
      updatedAt: '2026-11-25T10:00:00+08:00'
    })
    // Stale ongoing snapshot #3: missing startAt & endAt, updated 4h ago
    const staleNoStart = makeExam({
      id: 'e-stale-3',
      title: '无时间陈旧快照',
      startAt: null,
      endAt: null,
      durationMinutes: null,
      examStatus: '进行中',
      updatedAt: '2026-11-25T10:00:00+08:00'
    })
    // Truly active ongoing exam #1: started 40m ago, duration 120m, synced 20m ago
    const trulyLive = makeExam({
      id: 'e-live-real',
      title: '当前正在进行考试',
      startAt: '2026-11-25T13:20:00+08:00',
      endAt: null,
      durationMinutes: 120,
      examStatus: '进行中',
      updatedAt: '2026-11-25T13:40:00+08:00'
    })
    // Truly active flexible-window exam: started 2 days ago, freshly synced 10m ago
    const freshFlexible = makeExam({
      id: 'e-live-flex',
      title: '刚同步的多日窗口考试',
      startAt: '2026-11-23T08:00:00+08:00',
      endAt: null,
      durationMinutes: 90,
      examStatus: '进行中',
      updatedAt: '2026-11-25T13:50:00+08:00'
    })
    // Real exam starting tomorrow
    const tomorrowExam = makeExam({
      id: 'e-tomorrow',
      title: '明日开考考试',
      startAt: '2026-11-26T09:00:00+08:00',
      endAt: '2026-11-26T11:00:00+08:00',
      examStatus: '待进行',
      score: '--',
      updatedAt: '2026-11-25T12:00:00+08:00'
    })

    expect(classifyExamBucket(staleYesterday, fixedNow.getTime())).toBe('unknown')
    expect(classifyExamBucket(staleNoDuration, fixedNow.getTime())).toBe('unknown')
    expect(classifyExamBucket(staleNoStart, fixedNow.getTime())).toBe('unknown')
    expect(classifyExamBucket(trulyLive, fixedNow.getTime())).toBe('ongoing')
    expect(classifyExamBucket(freshFlexible, fixedNow.getTime())).toBe('ongoing')
    expect(classifyExamBucket(tomorrowExam, fixedNow.getTime())).toBe('upcoming')

    const dashboard = getUpcomingDashboardExams(
      [staleYesterday, staleNoDuration, staleNoStart, tomorrowExam, trulyLive],
      [course],
      fixedNow,
      { windowDays: 14, limit: 3 }
    )
    expect(dashboard.ongoingCount).toBe(1)
    expect(dashboard.items.map((item) => item.exam.id)).toEqual(['e-live-real', 'e-tomorrow'])
  })

  it('distinguishes score placeholders from real scores while preserving zero score', () => {
    for (const placeholder of [
      '--',
      '-',
      '—',
      '——',
      '暂无',
      '未评分',
      '未出分',
      '无',
      'N/A',
      '  '
    ]) {
      expect(normalizeExamScore(placeholder)).toBeNull()
      expect(hasRealExamScore(placeholder)).toBe(false)
    }
    for (const real of ['0', '0.0', '0分', '0 / 100', '95', '88.5', '合格']) {
      expect(normalizeExamScore(real)).toBe(real)
      expect(hasRealExamScore(real)).toBe(true)
    }

    const fixedNow = new Date('2026-11-25T14:00:00+08:00')
    const tomorrowPlaceholder = makeExam({
      id: 'e-tmr-dash',
      startAt: '2026-11-26T14:00:00+08:00',
      endAt: '2026-11-26T16:00:00+08:00',
      examStatus: '待进行',
      answerStatus: '未交',
      score: '--'
    })
    const realZeroGraded = makeExam({
      id: 'e-zero',
      startAt: '2026-11-20T14:00:00+08:00',
      endAt: null,
      examStatus: '',
      answerStatus: '',
      score: '0'
    })

    expect(classifyExamBucket(tomorrowPlaceholder, fixedNow.getTime())).toBe('upcoming')
    expect(classifyExamBucket(realZeroGraded, fixedNow.getTime())).toBe('past')
  })

  it('updates auto semester selection across semester boundaries while preserving manual selection', () => {
    const fallCourse = makeCourse({
      id: 'c-fall',
      name: '数据结构',
      semester: '2026秋',
      semesterStart: '2026-09-07',
      maxWeek: 18
    })
    const springCourse = makeCourse({
      id: 'c-spring',
      name: '编译原理',
      semester: '2027春',
      semesterStart: '2027-02-22',
      maxWeek: 18
    })
    const courses = [fallCourse, springCourse]
    const inFall = new Date('2026-11-25T10:00:00+08:00')
    const inSpring = new Date('2027-02-24T10:00:00+08:00')

    // Auto mode (undefined) transitions automatically from 2026秋 to 2027春
    expect(resolveEffectiveCalendarSemesterKey(courses, undefined, inFall)).toBe('2026秋')
    expect(resolveEffectiveCalendarSemesterKey(courses, undefined, inSpring)).toBe('2027春')

    // Auto mode uses viewed date (manualDate ?? now), so viewing an older Fall date after clock enters Spring keeps Fall
    const pinnedFallDate = new Date('2027-01-10T10:00:00+08:00')
    const fallEnding = makeCourse({
      id: 'c-fall-end',
      name: '秋季数据结构',
      semester: '2026秋',
      semesterStart: '2026-09-07',
      maxWeek: 18,
      schedule: [
        {
          id: 's-sun',
          weekday: 7,
          startTime: '10:20',
          endTime: '12:00',
          location: '秋楼101',
          weeks: '1-18'
        }
      ]
    })
    const springNextDay = makeCourse({
      id: 'c-spring-start',
      name: '春季编译原理',
      semester: '2027春',
      semesterStart: '2027-01-11',
      maxWeek: 18,
      schedule: [
        {
          id: 's-mon',
          weekday: 1,
          startTime: '08:20',
          endTime: '10:00',
          location: '春楼202',
          weeks: '1-18'
        }
      ]
    })
    const boundaryCourses = [fallEnding, springNextDay]
    const afterMidnightSpring = new Date('2027-01-11T00:10:00+08:00')

    // With manualDate pinned to Jan 10, viewedDate stays Jan 10 -> semester stays 2026秋 and Fall class remains
    const viewedPinned = pinnedFallDate
    const semForPinned = resolveEffectiveCalendarSemesterKey(
      boundaryCourses,
      undefined,
      viewedPinned
    )
    expect(semForPinned).toBe('2026秋')
    const pinnedSessions = buildDaySessions(
      boundaryCourses.filter((c) => c.semester === semForPinned),
      [],
      viewedPinned,
      afterMidnightSpring
    )
    expect(pinnedSessions.map((s) => s.course.id)).toEqual(['c-fall-end'])

    // Without manualDate, viewedDate follows now (Jan 11) -> semester switches to 2027春
    expect(
      resolveEffectiveCalendarSemesterKey(boundaryCourses, undefined, afterMidnightSpring)
    ).toBe('2027春')

    // Manual selection stays pinned across semester transition and viewed dates
    expect(resolveEffectiveCalendarSemesterKey(courses, '2026秋', inSpring)).toBe('2026秋')
    expect(resolveEffectiveCalendarSemesterKey(courses, null, inSpring)).toBeNull()
    expect(resolveEffectiveCalendarSemesterKey(boundaryCourses, '2027春', pinnedFallDate)).toBe(
      '2027春'
    )
    expect(resolveEffectiveCalendarSemesterKey(boundaryCourses, null, pinnedFallDate)).toBeNull()
  })
})
