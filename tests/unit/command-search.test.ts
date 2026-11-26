import { describe, expect, it } from 'vitest'
import type { AppNotice, Chapter, Course, Exam, Material, Task } from '../../src/shared/types'
import { UNKNOWN_DUE_AT } from '../../src/shared/constants'
import {
  normalizeSearchText,
  parsePaletteQuery,
  searchCommandPalette,
  splitHighlightSegments
} from '../../src/shared/command-search'

const NOW = new Date('2026-11-24T12:00:00+08:00')

function makeCourse(overrides: Partial<Course> & { id: string; name: string }): Course {
  return {
    externalId: null,
    code: '',
    teacher: '',
    semester: '2026年秋',
    category: '必修',
    color: '#2558d9',
    favorite: false,
    clazzId: null,
    className: null,
    schedule: [],
    source: 'chaoxing',
    sourceUrl: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    ...overrides
  }
}

function makeTask(overrides: Partial<Task> & { id: string; title: string }): Task {
  return {
    description: '',
    courseId: null,
    priority: 'medium',
    kind: 'homework',
    status: 'todo',
    dueAt: '2026-11-26T23:59:00+08:00',
    completedAt: null,
    completionSource: null,
    source: 'chaoxing',
    externalId: null,
    sourceUpdatedAt: null,
    sourceUrl: null,
    platformStatus: null,
    platformStatusKind: 'not_submitted',
    submittedAt: null,
    score: null,
    fullScore: null,
    teacherFeedback: null,
    attachments: [],
    manualFields: [],
    fieldSources: {},
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    reminders: [],
    ...overrides
  }
}

function makeChapter(
  overrides: Partial<Chapter> & { id: string; courseId: string; title: string }
): Chapter {
  return {
    externalId: null,
    sortOrder: 0,
    progress: 0,
    lastStudiedAt: null,
    sourceUrl: null,
    sections: [],
    source: 'chaoxing',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    ...overrides
  }
}

function makeMaterial(
  overrides: Partial<Material> & { id: string; courseId: string; name: string }
): Material {
  return {
    externalId: `material:${overrides.id}`,
    kind: 'file',
    fileType: 'pdf',
    size: '2.1 MB',
    url: 'https://mooc1.chaoxing.com/file/1',
    sourceUrl: null,
    source: 'chaoxing',
    updatedAt: '2026-11-20T10:00:00.000Z',
    ...overrides
  }
}

function makeExam(overrides: Partial<Exam> & { id: string; title: string }): Exam {
  return {
    externalId: `exam:${overrides.id}`,
    courseName: null,
    startAt: '2026-12-01T09:00:00+08:00',
    endAt: '2026-12-01T11:00:00+08:00',
    durationMinutes: 120,
    examStatus: '待考',
    answerStatus: '未作答',
    score: null,
    mode: '线上考试',
    sourceUrl: null,
    source: 'chaoxing',
    updatedAt: '2026-11-20T10:00:00.000Z',
    ...overrides
  }
}

function makeNotice(overrides: Partial<AppNotice> & { id: string; title: string }): AppNotice {
  return {
    body: '',
    category: 'course',
    publishedAt: '2026-11-22T09:00:00+08:00',
    isDemo: false,
    source: 'chaoxing',
    sender: '教务老师',
    courseName: null,
    read: true,
    url: null,
    ...overrides
  }
}

describe('command-search', () => {
  it('separates command mode (> / ＞) from content search and includes zoom commands in command mode', () => {
    const courses = [makeCourse({ id: 'c1', name: '缩放原理与计算机图形学' })]
    const parsedAscii = parsePaletteQuery('>缩放', 'all')
    expect(parsedAscii.commandMode).toBe(true)
    expect(parsedAscii.effectiveScope).toBe('command')
    expect(parsedAscii.cleanQuery).toBe('缩放')

    const parsedFullWidth = parsePaletteQuery('＞同步', 'course')
    expect(parsedFullWidth.commandMode).toBe(true)
    expect(parsedFullWidth.effectiveScope).toBe('command')
    expect(parsedFullWidth.cleanQuery).toBe('同步')

    const cmdResult = searchCommandPalette({
      query: '>缩放',
      scope: 'all',
      courses,
      tasks: [],
      exams: [],
      materials: [],
      notices: [],
      chapters: [],
      now: NOW
    })

    expect(cmdResult.commandMode).toBe(true)
    expect(cmdResult.items.length).toBeGreaterThanOrEqual(3)
    expect(cmdResult.items.every((item) => item.scope === 'command')).toBe(true)
    expect(cmdResult.items.some((item) => item.id === 'action-zoom-in')).toBe(true)
    expect(cmdResult.items.some((item) => item.id === 'course-c1')).toBe(false)
  })

  it('keeps empty landing view concise and uncluttered instead of dumping 60 mixed entries', () => {
    const courses = Array.from({ length: 12 }, (_, idx) =>
      makeCourse({ id: `c-${idx}`, name: `课程 ${idx + 1}`, favorite: idx === 1 })
    )
    const tasks = [
      makeTask({
        id: 't-done',
        title: '已完成的作业',
        courseId: 'c-0',
        status: 'done',
        platformStatusKind: 'done'
      }),
      makeTask({
        id: 't-due-later',
        title: '下周作业',
        courseId: 'c-0',
        dueAt: '2026-12-03T23:59:00+08:00'
      }),
      makeTask({
        id: 't-overdue',
        title: '逾期作业',
        courseId: 'c-1',
        dueAt: '2026-11-23T23:59:00+08:00'
      }),
      makeTask({
        id: 't-today',
        title: '今日作业',
        courseId: 'c-1',
        dueAt: '2026-11-24T22:00:00+08:00'
      }),
      makeTask({
        id: 't-soon',
        title: '明天作业',
        courseId: 'c-0',
        dueAt: '2026-11-25T22:00:00+08:00'
      })
    ]

    const result = searchCommandPalette({
      query: '',
      scope: 'all',
      courses,
      tasks,
      exams: [],
      materials: [],
      notices: [],
      chapters: [],
      now: NOW
    })

    const urgentItems = result.items.filter((item) => item.group === 'urgent')
    expect(urgentItems.map((item) => item.title)).toEqual(['逾期作业', '今日作业', '明天作业'])
    // Zoom commands are omitted from default empty landing to avoid clutter
    expect(result.items.some((item) => item.id === 'action-zoom-in')).toBe(false)
    // Compact total size (< 16)
    expect(result.items.length).toBeLessThanOrEqual(15)
  })

  it('promotes exact page title match (e.g. 设置) to #1 for direct navigation', () => {
    const tasks = [
      makeTask({
        id: 't1',
        title: '实验环境设置说明',
        description: '请先完成开发环境设置'
      })
    ]
    const result = searchCommandPalette({
      query: '设置',
      scope: 'all',
      courses: [],
      tasks,
      exams: [],
      materials: [],
      notices: [],
      chapters: [],
      now: NOW
    })

    expect(result.items[0]?.id).toBe('page-settings')
    expect(result.items[0]?.target).toEqual({ kind: 'page', target: 'settings' })
  })

  it('distinguishes same-name courses, teaching classes, and same-name homework with Chinese status labels', () => {
    const math01 = makeCourse({
      id: 'course-math-1',
      name: '高等数学',
      className: '2026秋01班',
      teacher: '张老师',
      code: 'MATH101',
      clazzId: '1001'
    })
    const math02 = makeCourse({
      id: 'course-math-2',
      name: '高等数学',
      className: '2026秋02班',
      teacher: '李老师',
      code: 'MATH101',
      clazzId: '1002'
    })
    const hw01 = makeTask({
      id: 'task-hw-1',
      title: '第一次作业',
      courseId: math01.id,
      dueAt: '2026-11-28T23:59:00+08:00',
      platformStatusKind: 'not_submitted'
    })
    const hw02 = makeTask({
      id: 'task-hw-2',
      title: '第一次作业',
      courseId: math02.id,
      dueAt: '2026-11-20T23:59:00+08:00',
      status: 'done',
      platformStatusKind: 'reviewed',
      score: '96',
      fullScore: '100'
    })

    const courseSearch = searchCommandPalette({
      query: '高等数学',
      scope: 'all',
      courses: [math01, math02],
      tasks: [hw01, hw02],
      exams: [],
      materials: [],
      notices: [],
      chapters: [],
      now: NOW
    })

    const courseItems = courseSearch.items.filter((item) => item.group === 'course')
    expect(courseItems).toHaveLength(2)
    expect(courseItems[0]?.badge?.text).toBe('教学班 2026秋01班')
    expect(courseItems[1]?.badge?.text).toBe('教学班 2026秋02班')

    const hwSearch = searchCommandPalette({
      query: '第一次作业',
      scope: 'task',
      courses: [math01, math02],
      tasks: [hw01, hw02],
      exams: [],
      materials: [],
      notices: [],
      chapters: [],
      now: NOW
    })

    // Actionable homework ranks ahead of already-reviewed homework
    expect(hwSearch.items.map((item) => item.id)).toEqual(['task-task-hw-1', 'task-task-hw-2'])
    expect(hwSearch.items[0]?.subtitle).toContain('高等数学（教学班 2026秋01班）')
    expect(hwSearch.items[0]?.badge?.text).toBe('未提交')
    expect(hwSearch.items[1]?.subtitle).toContain('高等数学（教学班 2026秋02班）')
    expect(hwSearch.items[1]?.badge?.text).toBe('已批阅 · 96 / 100')

    // Multi-token query filters precisely to teaching class 02
    const classFiltered = searchCommandPalette({
      query: '高等数学 02班 第一次作业',
      scope: 'all',
      courses: [math01, math02],
      tasks: [hw01, hw02],
      exams: [],
      materials: [],
      notices: [],
      chapters: [],
      now: NOW
    })
    expect(classFiltered.items.map((item) => item.id)).toEqual(['task-task-hw-2'])
  })

  it('searches beyond legacy 80/100 slice limits and keeps groups contiguous with expand-scope rows', () => {
    const course = makeCourse({ id: 'c1', name: '数据结构' })
    const materials = Array.from({ length: 130 }, (_, idx) =>
      makeMaterial({
        id: `m-${idx}`,
        courseId: 'c1',
        name: `算法讲义-${String(idx + 1).padStart(3, '0')}.pdf`,
        externalId: `material:${1000 + idx}`,
        url: `https://mooc1.chaoxing.com/file/${1000 + idx}`
      })
    )
    const tasks = [makeTask({ id: 't1', title: '算法讲义阅读作业', courseId: 'c1' })]

    // Item #125 (beyond old slice(0, 100)) must be searchable!
    const deepHit = searchCommandPalette({
      query: '算法讲义-125',
      scope: 'all',
      courses: [course],
      tasks,
      exams: [],
      materials,
      notices: [],
      chapters: [],
      now: NOW
    })
    expect(deepHit.items).toHaveLength(1)
    expect(deepHit.items[0]?.title).toBe('算法讲义-125.pdf')

    // Broad query caps per-group preview in 'all' scope and emits an expand_scope row
    const broad = searchCommandPalette({
      query: '算法讲义',
      scope: 'all',
      courses: [course],
      tasks,
      exams: [],
      materials,
      notices: [],
      chapters: [],
      now: NOW,
      groupPreviewLimit: 5
    })

    expect(broad.countsByScope.material).toBe(130)
    expect(broad.countsByScope.task).toBe(1)

    // Group headers must be contiguous (no group appears twice)
    const seenGroups = new Set<string>()
    let prevGroup: string | null = null
    for (const item of broad.items) {
      if (item.group !== prevGroup) {
        expect(seenGroups.has(item.group)).toBe(false)
        seenGroups.add(item.group)
        prevGroup = item.group
      }
    }

    const expandRow = broad.items.find((item) => item.target.kind === 'expand_scope')
    expect(expandRow?.target).toEqual({ kind: 'expand_scope', scope: 'material' })
    expect(expandRow?.title).toBe('查看全部 130 条资料')

    // Following expand_scope into 'material' scope paginates cleanly with load_more until #130 is reached
    const page1 = searchCommandPalette({
      query: '算法讲义',
      scope: 'material',
      courses: [course],
      tasks,
      exams: [],
      materials,
      notices: [],
      chapters: [],
      now: NOW
    })
    expect(page1.items.filter((i) => i.target.kind === 'material')).toHaveLength(60)
    const loadMore1 = page1.items[page1.items.length - 1]
    expect(loadMore1?.target).toEqual({ kind: 'load_more', scope: 'material', nextLimit: 120 })

    const page2 = searchCommandPalette({
      query: '算法讲义',
      scope: 'material',
      courses: [course],
      tasks,
      exams: [],
      materials,
      notices: [],
      chapters: [],
      now: NOW,
      scopeLimit: 120
    })
    expect(page2.items.filter((i) => i.target.kind === 'material')).toHaveLength(120)
    const loadMore2 = page2.items[page2.items.length - 1]
    expect(loadMore2?.target).toEqual({ kind: 'load_more', scope: 'material', nextLimit: 130 })

    const page3 = searchCommandPalette({
      query: '算法讲义',
      scope: 'material',
      courses: [course],
      tasks,
      exams: [],
      materials,
      notices: [],
      chapters: [],
      now: NOW,
      scopeLimit: 130
    })
    expect(page3.items.filter((i) => i.target.kind === 'material')).toHaveLength(130)
    expect(page3.items.some((i) => i.target.kind === 'load_more')).toBe(false)
    expect(page3.items.some((i) => i.title === '算法讲义-130.pdf')).toBe(true)
  })

  it('shows 已逾期 only for actionable tasks and never overwrites submitted/pending_review/reviewed/done badges', () => {
    const course = makeCourse({ id: 'c1', name: '软件工程' })
    const pastDue = '2026-11-20T23:59:00+08:00'
    const tasks = [
      makeTask({
        id: 't-unsub',
        title: '需求分析-未交',
        courseId: 'c1',
        dueAt: pastDue,
        status: 'todo',
        platformStatusKind: 'not_submitted'
      }),
      makeTask({
        id: 't-sub',
        title: '需求分析-已交',
        courseId: 'c1',
        dueAt: pastDue,
        status: 'todo',
        platformStatusKind: 'submitted'
      }),
      makeTask({
        id: 't-pending',
        title: '需求分析-待审',
        courseId: 'c1',
        dueAt: pastDue,
        status: 'todo',
        platformStatusKind: 'pending_review'
      }),
      makeTask({
        id: 't-reviewed',
        title: '需求分析-已批',
        courseId: 'c1',
        dueAt: pastDue,
        status: 'todo',
        platformStatusKind: 'reviewed',
        score: '95',
        fullScore: '100'
      }),
      makeTask({
        id: 't-done',
        title: '需求分析-完成',
        courseId: 'c1',
        dueAt: pastDue,
        status: 'todo',
        platformStatusKind: 'done'
      })
    ]

    const res = searchCommandPalette({
      query: '需求分析',
      scope: 'task',
      courses: [course],
      tasks,
      exams: [],
      materials: [],
      notices: [],
      chapters: [],
      now: NOW
    })

    const byId = new Map(res.items.map((item) => [item.id, item]))
    expect(byId.get('task-t-unsub')?.badge).toEqual({ text: '已逾期', tone: 'danger' })
    expect(byId.get('task-t-sub')?.badge).toEqual({ text: '已提交', tone: 'accent' })
    expect(byId.get('task-t-pending')?.badge).toEqual({ text: '待审核', tone: 'info' })
    expect(byId.get('task-t-reviewed')?.badge).toEqual({
      text: '已批阅 · 95 / 100',
      tone: 'success'
    })
    expect(byId.get('task-t-done')?.badge).toEqual({ text: '已完成', tone: 'success' })
  })

  it('disambiguates colliding same-name teaching classes and same-course same-dueAt tasks without bloating normal items', () => {
    const cNormal = makeCourse({
      id: 'c-normal',
      name: '计算机网络',
      className: '01班',
      clazzId: '9001'
    })
    const cSameClass1 = makeCourse({
      id: 'c-same-1',
      name: '概率论',
      className: '公共1班',
      clazzId: '3001',
      code: 'PROB101'
    })
    const cSameClass2 = makeCourse({
      id: 'c-same-2',
      name: '概率论',
      className: '公共1班',
      clazzId: '3002',
      code: 'PROB101'
    })
    const hwDiffDue1 = makeTask({
      id: 't-diff-1',
      title: '实验报告',
      courseId: cNormal.id,
      dueAt: '2026-11-28T23:59:00+08:00'
    })
    const hwDiffDue2 = makeTask({
      id: 't-diff-2',
      title: '实验报告',
      courseId: cNormal.id,
      dueAt: '2026-12-05T23:59:00+08:00'
    })
    const hwSameDue1 = makeTask({
      id: 't-same-due-1',
      externalId: 'work:550011',
      title: '课堂小测',
      courseId: cSameClass1.id,
      dueAt: '2026-11-28T23:59:00+08:00'
    })
    const hwSameDue2 = makeTask({
      id: 't-same-due-2',
      externalId: 'work:550022',
      title: '课堂小测',
      courseId: cSameClass1.id,
      dueAt: '2026-11-28T23:59:00+08:00'
    })

    const courseRes = searchCommandPalette({
      query: '概率论',
      scope: 'course',
      courses: [cNormal, cSameClass1, cSameClass2],
      tasks: [],
      exams: [],
      materials: [],
      notices: [],
      chapters: [],
      now: NOW
    })
    expect(courseRes.items).toHaveLength(2)
    expect(courseRes.items[0]?.badge?.text).toBe('教学班 公共1班 · 班级 3001')
    expect(courseRes.items[1]?.badge?.text).toBe('教学班 公共1班 · 班级 3002')

    // Non-colliding same-title tasks with different due dates stay concise (no ID suffix)
    const diffRes = searchCommandPalette({
      query: '实验报告',
      scope: 'task',
      courses: [cNormal],
      tasks: [hwDiffDue1, hwDiffDue2],
      exams: [],
      materials: [],
      notices: [],
      chapters: [],
      now: NOW
    })
    expect(diffRes.items[0]?.subtitle).not.toContain('ID ')
    expect(diffRes.items[1]?.subtitle).not.toContain('ID ')

    // Colliding same-course same-title same-dueAt tasks append distinguishing IDs
    const sameRes = searchCommandPalette({
      query: '课堂小测',
      scope: 'task',
      courses: [cSameClass1, cSameClass2],
      tasks: [hwSameDue1, hwSameDue2],
      exams: [],
      materials: [],
      notices: [],
      chapters: [],
      now: NOW
    })
    expect(sameRes.items).toHaveLength(2)
    expect(sameRes.items[0]?.subtitle).toContain('教学班 公共1班 · 班级 3001')
    expect(sameRes.items[0]?.subtitle).toContain('ID ')
    expect(sameRes.items[0]?.subtitle).not.toBe(sameRes.items[1]?.subtitle)
  })

  it('keeps the short class id visible for long teaching-class names and normalizes repeated spaces', () => {
    const longClassA = makeCourse({
      id: 'c-long-a',
      name: '公共选修课',
      className: '这是一个非常长的教学班名称用于测试裁切',
      clazzId: '3001'
    })
    const longClassB = makeCourse({
      id: 'c-long-b',
      name: '公共选修课',
      className: '这也是一个非常长的教学班名称用于测试裁切',
      clazzId: '3002'
    })
    const res = searchCommandPalette({
      query: '公共选修课',
      scope: 'course',
      courses: [longClassA, longClassB],
      tasks: [],
      exams: [],
      materials: [],
      notices: [],
      chapters: [],
      now: NOW
    })
    expect(res.items).toHaveLength(2)
    expect(res.items[0]?.badge?.text.startsWith('班级 3001')).toBe(true)
    expect(res.items[1]?.badge?.text.startsWith('班级 3002')).toBe(true)

    const spaced = makeCourse({ id: 'c-space', name: '高等 数学' })
    expect(normalizeSearchText('  高等   数学  ')).toBe('高等 数学')
    const spacedRes = searchCommandPalette({
      query: '高等   数学',
      scope: 'course',
      courses: [spaced],
      tasks: [],
      exams: [],
      materials: [],
      notices: [],
      chapters: [],
      now: NOW
    })
    expect(spacedRes.items[0]?.id).toBe('course-c-space')
    expect(spacedRes.items[0]?.matchTier).toBe(0)
  })

  it('strictly ranks exact normalized title matches ahead of multi-token prefix matches across and within groups', () => {
    const prefixCourse = makeCourse({
      id: 'c-prefix',
      name: '高等 数学 习题',
      favorite: true
    })
    const exactTask = makeTask({
      id: 't-exact',
      title: '高等 数学',
      courseId: prefixCourse.id,
      status: 'done',
      platformStatusKind: 'done'
    })
    const prefixTask = makeTask({
      id: 't-prefix',
      title: '高等 数学 强化训练',
      courseId: prefixCourse.id,
      dueAt: '2026-11-23T23:59:00+08:00',
      platformStatusKind: 'not_submitted'
    })

    const res = searchCommandPalette({
      query: '高等 数学',
      scope: 'all',
      courses: [prefixCourse],
      tasks: [prefixTask, exactTask],
      exams: [],
      materials: [],
      notices: [],
      chapters: [],
      now: NOW
    })

    // Exact normalized title task MUST be index 0 (Enter default), ahead of both prefix course and urgent prefix task
    expect(res.items[0]?.id).toBe('task-t-exact')
    expect(res.items[1]?.id).toBe('task-t-prefix')
    expect(res.items[2]?.id).toBe('course-c-prefix')
  })

  it('matches nested chapter sections and maps directly to the chapter target', () => {
    const course = makeCourse({ id: 'c-os', name: '操作系统' })
    const chapter = makeChapter({
      id: 'ch-3',
      courseId: course.id,
      title: '进程同步与死锁',
      sortOrder: 2,
      progress: 65,
      sections: [
        {
          number: '3.1',
          title: '信号量与 PV 操作',
          completed: true,
          pendingCount: 0,
          locked: false,
          resources: []
        },
        {
          number: '3.2',
          title: '银行家算法避免死锁',
          completed: false,
          pendingCount: 1,
          locked: false,
          resources: []
        }
      ]
    })

    const result = searchCommandPalette({
      query: '银行家算法',
      scope: 'all',
      courses: [course],
      tasks: [],
      exams: [],
      materials: [],
      notices: [],
      chapters: [chapter],
      now: NOW
    })

    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.target).toMatchObject({
      kind: 'chapter',
      courseId: 'c-os',
      chapterId: 'ch-3'
    })
    expect(result.items[0]?.subtitle).toContain('操作系统')
    expect(result.items[0]?.subtitle).toContain('匹配小节：3.2 银行家算法避免死锁')
  })

  it('matches notice body with snippet, prioritizes unread notices, and annotates ambiguous same-name exams', () => {
    const c1 = makeCourse({ id: 'c1', name: '大学英语', className: 'A班' })
    const c2 = makeCourse({ id: 'c2', name: '大学英语', className: 'B班' })
    const exam = makeExam({
      id: 'ex1',
      title: '期中口语考试',
      courseName: '大学英语',
      startAt: '2026-12-05T14:00:00+08:00'
    })
    const readNotice = makeNotice({
      id: 'n1',
      title: '教学楼调整通知',
      body: '本周实验课改到综合楼 402 机房进行。',
      courseName: '计算机网络',
      read: true,
      publishedAt: '2026-11-23T08:00:00+08:00'
    })
    const unreadNotice = makeNotice({
      id: 'n2',
      title: '实验课提醒',
      body: '请提前到综合楼 402 机房调试环境。',
      courseName: '操作系统',
      read: false,
      publishedAt: '2026-11-21T08:00:00+08:00'
    })

    const examRes = searchCommandPalette({
      query: '口语考试',
      scope: 'all',
      courses: [c1, c2],
      tasks: [],
      exams: [exam],
      materials: [],
      notices: [],
      chapters: [],
      now: NOW
    })
    expect(examRes.items[0]?.subtitle).toContain('大学英语（同名多班）')

    const noticeRes = searchCommandPalette({
      query: '402 机房',
      scope: 'notice',
      courses: [c1, c2],
      tasks: [],
      exams: [],
      materials: [],
      notices: [readNotice, unreadNotice],
      chapters: [],
      now: NOW
    })
    expect(noticeRes.items.map((item) => item.id)).toEqual(['notice-n2', 'notice-n1'])
    expect(noticeRes.items[0]?.badge?.text).toBe('未读')
    expect(noticeRes.items[0]?.subtitle).toContain('402 机房')
  })

  it('reports otherScopeMatchCount when current scope is empty for a query and deduplicates exact duplicate materials only', () => {
    const course = makeCourse({ id: 'c1', name: '线性代数' })
    const dupA = makeMaterial({
      id: 'm1',
      courseId: 'c1',
      externalId: 'material:10',
      name: '矩阵讲义.pdf',
      url: 'https://mooc1.chaoxing.com/f/10'
    })
    const dupExact = makeMaterial({
      id: 'm2',
      courseId: 'c1',
      externalId: 'material:10',
      name: '矩阵讲义.pdf',
      url: 'https://mooc1.chaoxing.com/f/10'
    })
    const distinctSameName = makeMaterial({
      id: 'm3',
      courseId: 'c1',
      externalId: 'material:11',
      name: '矩阵讲义.pdf',
      url: 'https://mooc1.chaoxing.com/f/11'
    })

    const matRes = searchCommandPalette({
      query: '矩阵讲义',
      scope: 'material',
      courses: [course],
      tasks: [],
      exams: [],
      materials: [dupA, dupExact, distinctSameName],
      notices: [],
      chapters: [],
      now: NOW
    })
    expect(matRes.items).toHaveLength(2)

    const emptyInExam = searchCommandPalette({
      query: '矩阵讲义',
      scope: 'exam',
      courses: [course],
      tasks: [],
      exams: [],
      materials: [dupA, distinctSameName],
      notices: [],
      chapters: [],
      now: NOW
    })
    expect(emptyInExam.items).toHaveLength(0)
    expect(emptyInExam.otherScopeMatchCount).toBe(2)
  })

  it('disambiguates same-title tasks within the same course when dueAt is unknown', () => {
    const course = makeCourse({ id: 'c1', name: '大学物理' })
    const t1 = makeTask({
      id: 'task-aaaa1111',
      externalId: 'work:990011',
      title: '随堂测验',
      courseId: 'c1',
      dueAt: UNKNOWN_DUE_AT
    })
    const t2 = makeTask({
      id: 'task-bbbb2222',
      externalId: 'work:990022',
      title: '随堂测验',
      courseId: 'c1',
      dueAt: UNKNOWN_DUE_AT
    })
    const res = searchCommandPalette({
      query: '随堂测验',
      scope: 'task',
      courses: [course],
      tasks: [t1, t2],
      exams: [],
      materials: [],
      notices: [],
      chapters: [],
      now: NOW
    })
    expect(res.items).toHaveLength(2)
    expect(res.items[0]?.subtitle).not.toBe(res.items[1]?.subtitle)
  })

  it('splits highlight segments cleanly for overlapping and non-adjacent tokens', () => {
    expect(splitHighlightSegments('高等数学实验报告', ['高等', '高等数学', '实验'])).toEqual([
      { text: '高等数学实验', matched: true },
      { text: '报告', matched: false }
    ])
    expect(splitHighlightSegments('高等数学第一实验报告', ['高等', '高等数学', '实验'])).toEqual([
      { text: '高等数学', matched: true },
      { text: '第一', matched: false },
      { text: '实验', matched: true },
      { text: '报告', matched: false }
    ])
  })
})
