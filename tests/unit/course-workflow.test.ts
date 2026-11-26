import { describe, expect, it } from 'vitest'
import type { Chapter, Course, StudyPoint, Task } from '@shared/types'
import {
  associateChapterPointsWithSections,
  courseNeedsAttention,
  getChapterResumeOfficialUrl,
  getChapterWorkflowSummary,
  parseStudyResumeStorage,
  resolveChapterOfficialDestination,
  resolveCourseResumeTarget,
  resolveGlobalLastStudiedCourse,
  upsertStudyResumeRecord,
  type StudyResumeMap
} from '@shared/course-workflow'
import { getCourseProgress } from '@shared/study-progress'

const STAMP = '2026-11-20T10:00:00.000Z'

function makeCourse(overrides: Partial<Course> & { id: string; name: string }): Course {
  return {
    externalId: null,
    code: '',
    teacher: '张老师',
    semester: '2026年秋',
    category: '必修',
    color: '#2558d9',
    favorite: false,
    clazzId: null,
    className: null,
    schedule: [],
    source: 'chaoxing',
    sourceUrl: 'https://mooc1.chaoxing.com/course/100',
    createdAt: STAMP,
    updatedAt: STAMP,
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
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides
  }
}

function makePoint(
  overrides: Partial<StudyPoint> & { id: string; courseId: string; chapterId: string }
): StudyPoint {
  return {
    externalId: null,
    title: `任务点 ${overrides.id}`,
    kind: 'video',
    status: 'todo',
    durationMinutes: 15,
    sortOrder: 0,
    source: 'chaoxing',
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides
  }
}

function makeTask(overrides: Partial<Task> & { id: string; courseId: string }): Task {
  return {
    title: `作业 ${overrides.id}`,
    description: '',
    priority: 'medium',
    kind: 'homework',
    status: 'todo',
    dueAt: '2026-11-30T23:59:00+08:00',
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
    createdAt: STAMP,
    updatedAt: STAMP,
    reminders: [],
    ...overrides
  }
}

describe('course-workflow', () => {
  it('distinguishes incomplete, unknown outline, locked, and completed chapter states honestly', () => {
    // 1. Empty directory chapter -> unknown
    const emptyChapter = makeChapter({ id: 'ch-empty', courseId: 'c1', title: '目录章节' })
    expect(getChapterWorkflowSummary(emptyChapter, []).status).toBe('unknown')

    // 2. Zero-task outline sections (completed: false, pendingCount: 0) -> MUST be unknown, never incomplete!
    const outlineChapter = makeChapter({
      id: 'ch-outline',
      courseId: 'c1',
      title: '纯目录讲义章节',
      sections: [
        {
          number: '0.1',
          title: '课程简介',
          completed: false,
          pendingCount: 0,
          locked: false,
          sourceUrl: 'https://mooc1.chaoxing.com/sec/0-1',
          resources: []
        },
        {
          number: '0.2',
          title: '参考书目',
          completed: false,
          pendingCount: 0,
          locked: false,
          sourceUrl: 'https://mooc1.chaoxing.com/sec/0-2',
          resources: []
        }
      ]
    })
    const outlineSummary = getChapterWorkflowSummary(outlineChapter, [])
    expect(outlineSummary.status).toBe('unknown')
    expect(outlineSummary.unfinishedUnlockedSections).toBe(0)
    expect(outlineSummary.sectionPendingCount).toBe(0)
    expect(outlineSummary.nextUnfinishedSection).toBeNull()
    expect(courseNeedsAttention('c1', [outlineChapter], [], [])).toBe(false)

    // 3. Locked chapter with pending tasks -> locked (even when an unlocked section or point is done)
    const lockedChapter = makeChapter({
      id: 'ch-locked',
      courseId: 'c1',
      title: '未开放章节',
      sections: [
        {
          number: '1.1',
          title: '已解锁小节',
          completed: true,
          pendingCount: 0,
          locked: false,
          resources: []
        },
        {
          number: '1.2',
          title: '未解锁小节',
          completed: false,
          pendingCount: 2,
          locked: true,
          sourceUrl: 'https://mooc1.chaoxing.com/sec/1-2',
          resources: []
        }
      ]
    })
    const lockedSummary = getChapterWorkflowSummary(lockedChapter, [
      makePoint({ id: 'p-done-in-locked', courseId: 'c1', chapterId: 'ch-locked', status: 'done' })
    ])
    expect(lockedSummary.status).toBe('locked')
    expect(lockedSummary.lockedSectionCount).toBe(1)
    expect(lockedSummary.lockedPendingCount).toBe(2)

    // 4. All-locked chapter even with todo study points -> locked, never incomplete
    const allLockedChapter = makeChapter({
      id: 'ch-all-locked',
      courseId: 'c1',
      title: '全部锁定章节',
      sections: [
        {
          number: '3.1',
          title: '锁定节',
          completed: false,
          pendingCount: 1,
          locked: true,
          sourceUrl: 'https://mooc1.chaoxing.com/sec/3-1',
          resources: []
        }
      ]
    })
    expect(
      getChapterWorkflowSummary(allLockedChapter, [
        makePoint({ id: 'p-locked', courseId: 'c1', chapterId: 'ch-all-locked', status: 'todo' })
      ]).status
    ).toBe('locked')

    // 5. Explicit unfinished unlocked work -> incomplete
    const activeChapter = makeChapter({
      id: 'ch-active',
      courseId: 'c1',
      title: '核心章节',
      sections: [
        {
          number: '2.1',
          title: '已完成节',
          completed: true,
          pendingCount: 0,
          locked: false,
          resources: []
        },
        {
          number: '2.2',
          title: '待学习节',
          completed: false,
          pendingCount: 2,
          locked: false,
          resources: []
        }
      ]
    })
    const points = [
      makePoint({
        id: 'p1',
        courseId: 'c1',
        chapterId: 'ch-active',
        status: 'done',
        durationMinutes: 10
      }),
      makePoint({
        id: 'p2',
        courseId: 'c1',
        chapterId: 'ch-active',
        status: 'todo',
        durationMinutes: 20
      }),
      makePoint({
        id: 'p3',
        courseId: 'c1',
        chapterId: 'ch-active',
        status: 'todo',
        durationMinutes: 15
      })
    ]
    const summary = getChapterWorkflowSummary(activeChapter, points)
    expect(summary).toMatchObject({
      status: 'incomplete',
      pointTotal: 3,
      pointDone: 1,
      remainingPoints: 2,
      remainingMinutes: 35,
      sectionTotal: 2,
      sectionDone: 1,
      unfinishedUnlockedSections: 1,
      sectionPendingCount: 2
    })
    expect(summary.nextUnfinishedSection?.number).toBe('2.2')

    // 6. Confirmed completed chapter (all sections done, no points) -> completed
    const completedSectionsChapter = makeChapter({
      id: 'ch-sec-done',
      courseId: 'c1',
      title: '全完成章节',
      sections: [
        {
          number: '4.1',
          title: '已完成节',
          completed: true,
          pendingCount: 0,
          locked: false,
          resources: []
        }
      ]
    })
    expect(getChapterWorkflowSummary(completedSectionsChapter, []).status).toBe('completed')
  })

  it('resolves unified official destinations without mismatched sections or locked targets', () => {
    const course = makeCourse({
      id: 'c1',
      name: '操作系统',
      sourceUrl: 'https://mooc1.chaoxing.com/course/10'
    })
    const chapter = makeChapter({
      id: 'ch1',
      courseId: 'c1',
      title: '内存管理',
      sourceUrl: 'https://mooc1.chaoxing.com/chapter/1',
      sections: [
        {
          number: '1.1',
          title: '已完成小节',
          completed: true,
          pendingCount: 0,
          locked: false,
          sourceUrl: 'https://mooc1.chaoxing.com/sec/1-1',
          resources: []
        },
        {
          number: '1.2',
          title: '恶意域名小节',
          completed: false,
          pendingCount: 1,
          locked: false,
          sourceUrl: 'https://evil.example/phish',
          resources: []
        },
        {
          number: '1.3',
          title: '合法未完成小节',
          completed: false,
          pendingCount: 2,
          locked: false,
          sourceUrl: 'https://mooc1.chaoxing.com/sec/1-3',
          resources: []
        },
        {
          number: '1.4',
          title: '锁定小节',
          completed: false,
          pendingCount: 1,
          locked: true,
          sourceUrl: 'https://mooc1.chaoxing.com/sec/1-4',
          resources: []
        }
      ]
    })

    // Resume mode skips completed 1.1 and non-allowlisted 1.2, returning 1.3 consistently for both section & URL
    const resumeDest = resolveChapterOfficialDestination(course, chapter, { mode: 'resume' })
    expect(resumeDest.kind).toBe('section')
    expect(resumeDest.url).toBe('https://mooc1.chaoxing.com/sec/1-3')
    expect(resumeDest.section?.number).toBe('1.3')
    expect(getChapterResumeOfficialUrl(course, chapter)).toBe('https://mooc1.chaoxing.com/sec/1-3')

    // Resume mode advances past completed preferred 1.1 to unfinished 1.3; review mode honors explicit 1.1
    expect(getChapterResumeOfficialUrl(course, chapter, '1.1')).toBe(
      'https://mooc1.chaoxing.com/sec/1-3'
    )
    const reviewDest = resolveChapterOfficialDestination(course, chapter, {
      mode: 'review',
      preferredSectionNumber: '1.1'
    })
    expect(reviewDest.kind).toBe('section')
    expect(reviewDest.url).toBe('https://mooc1.chaoxing.com/sec/1-1')
    expect(reviewDest.section?.number).toBe('1.1')

    // Never opens locked section even if preferred
    const lockedPreferred = resolveChapterOfficialDestination(course, chapter, {
      mode: 'resume',
      preferredSectionNumber: '1.4'
    })
    expect(lockedPreferred.url).toBe('https://mooc1.chaoxing.com/sec/1-3')
    expect(lockedPreferred.section?.number).toBe('1.3')

    // When NO unfinished unlocked section has a valid allowlisted URL, explicitly degrade to chapter -> course -> none
    // (NEVER silently jump to completed 1.1 or locked 1.4 while claiming 1.2!)
    const noAllowlistedUnfinishedChapter = makeChapter({
      id: 'ch-fallback',
      courseId: 'c1',
      title: '降级测试章节',
      sourceUrl: 'https://mooc1.chaoxing.com/chapter/fallback',
      sections: [
        {
          number: '2.1',
          title: '已完成节',
          completed: true,
          pendingCount: 0,
          locked: false,
          sourceUrl: 'https://mooc1.chaoxing.com/sec/2-1',
          resources: []
        },
        {
          number: '2.2',
          title: '无直达链接未完成节',
          completed: false,
          pendingCount: 2,
          locked: false,
          sourceUrl: 'https://evil.example/blocked',
          resources: []
        },
        {
          number: '2.3',
          title: '锁定节',
          completed: false,
          pendingCount: 1,
          locked: true,
          sourceUrl: 'https://mooc1.chaoxing.com/sec/2-3',
          resources: []
        }
      ]
    })
    const chapterFallback = resolveChapterOfficialDestination(
      course,
      noAllowlistedUnfinishedChapter,
      {
        mode: 'resume'
      }
    )
    expect(chapterFallback).toEqual({
      kind: 'chapter',
      url: 'https://mooc1.chaoxing.com/chapter/fallback',
      section: null
    })

    // Degrades further to course URL when chapter URL is also absent/blocked
    const courseFallback = resolveChapterOfficialDestination(
      course,
      { ...noAllowlistedUnfinishedChapter, sourceUrl: null },
      { mode: 'resume' }
    )
    expect(courseFallback).toEqual({
      kind: 'course',
      url: 'https://mooc1.chaoxing.com/course/10',
      section: null
    })

    // Degrades to none when neither chapter nor course has an allowlisted URL
    const noneFallback = resolveChapterOfficialDestination(
      makeCourse({ id: 'c-no-url', name: '无入口课', sourceUrl: null }),
      { ...noAllowlistedUnfinishedChapter, sourceUrl: null },
      { mode: 'resume' }
    )
    expect(noneFallback).toEqual({
      kind: 'none',
      url: null,
      section: null
    })
  })

  it('never misclassifies completed + locked-pending or outline-only courses as all_done or incomplete', () => {
    const course = makeCourse({
      id: 'c-mixed',
      name: '计算机网络',
      sourceUrl: 'https://mooc1.chaoxing.com/course/200'
    })

    // Case A: completed chapter + locked chapter with pending tasks -> locked_only (NEVER all_done, NEVER locked section!)
    const doneCh = makeChapter({
      id: 'ch-done',
      courseId: 'c-mixed',
      title: '第 1 章 概述',
      sortOrder: 0,
      sourceUrl: 'https://mooc1.chaoxing.com/chapter/done'
    })
    const lockedCh = makeChapter({
      id: 'ch-locked',
      courseId: 'c-mixed',
      title: '第 2 章 运输层',
      sortOrder: 1,
      sourceUrl: null,
      sections: [
        {
          number: '2.1',
          title: '未解锁小节',
          completed: false,
          pendingCount: 3,
          locked: true,
          sourceUrl: 'https://mooc1.chaoxing.com/sec/locked-2-1',
          resources: []
        }
      ]
    })
    const mixedPoints = new Map<string, StudyPoint[]>([
      [
        'ch-done',
        [makePoint({ id: 'p-done', courseId: 'c-mixed', chapterId: 'ch-done', status: 'done' })]
      ]
    ])
    const lockedOnlyTarget = resolveCourseResumeTarget(
      course,
      [doneCh, lockedCh],
      mixedPoints,
      null
    )
    expect(lockedOnlyTarget.kind).toBe('locked_only')
    expect(lockedOnlyTarget.chapter?.id).toBe('ch-locked')
    expect(lockedOnlyTarget.section).toBeNull()
    expect(lockedOnlyTarget.lockedChapterCount).toBe(1)
    expect(lockedOnlyTarget.lockedPendingCount).toBe(3)
    expect(lockedOnlyTarget.destination).toEqual({
      kind: 'course',
      url: 'https://mooc1.chaoxing.com/course/200',
      section: null
    })
    expect(lockedOnlyTarget.officialUrl).toBe('https://mooc1.chaoxing.com/course/200')

    // Case B: zero-task outline sections -> browse_only (NEVER incomplete, NEVER all_done)
    const outlineCh = makeChapter({
      id: 'ch-outline',
      courseId: 'c-mixed',
      title: '课程大纲',
      sortOrder: 0,
      sourceUrl: 'https://mooc1.chaoxing.com/chapter/outline',
      sections: [
        {
          number: '1.1',
          title: '导学文档',
          completed: false,
          pendingCount: 0,
          locked: false,
          sourceUrl: 'https://mooc1.chaoxing.com/sec/outline-1-1',
          resources: []
        }
      ]
    })
    const outlineTarget = resolveCourseResumeTarget(course, [outlineCh], new Map(), null)
    expect(outlineTarget.kind).toBe('browse_only')
    expect(outlineTarget.unfinishedChapterCount).toBe(0)
    expect(outlineTarget.destination).toEqual({
      kind: 'chapter',
      url: 'https://mooc1.chaoxing.com/chapter/outline',
      section: null
    })
  })

  it('resolves resume target priority: recent unfinished -> platform recent -> first unfinished -> all_done / browse_only', () => {
    const course = makeCourse({ id: 'c1', name: '数据结构' })
    const ch1 = makeChapter({ id: 'ch1', courseId: 'c1', title: '绪论', sortOrder: 0 })
    const ch2 = makeChapter({
      id: 'ch2',
      courseId: 'c1',
      title: '树与二叉树',
      sortOrder: 1,
      lastStudiedAt: '2026-11-23T12:00:00.000Z'
    })
    const ch3 = makeChapter({ id: 'ch3', courseId: 'c1', title: '图论', sortOrder: 2 })

    const pointsByChapter = new Map<string, StudyPoint[]>([
      ['ch1', [makePoint({ id: 'p1', courseId: 'c1', chapterId: 'ch1', status: 'done' })]],
      [
        'ch2',
        [
          makePoint({
            id: 'p2',
            courseId: 'c1',
            chapterId: 'ch2',
            status: 'todo',
            durationMinutes: 25
          })
        ]
      ],
      [
        'ch3',
        [
          makePoint({
            id: 'p3',
            courseId: 'c1',
            chapterId: 'ch3',
            status: 'todo',
            durationMinutes: 30
          })
        ]
      ]
    ])

    // 1. Local resume pointing to ch3 (unfinished) wins
    const recent = resolveCourseResumeTarget(course, [ch1, ch2, ch3], pointsByChapter, {
      courseId: 'c1',
      chapterId: 'ch3',
      sectionNumber: null,
      sectionTitle: null,
      updatedAt: '2026-11-24T09:00:00.000Z'
    })
    expect(recent.kind).toBe('resume_recent')
    expect(recent.chapter?.id).toBe('ch3')
    expect(recent.chapterIndex).toBe(3)
    expect(recent.remainingPoints).toBe(2)
    expect(recent.remainingMinutes).toBe(55)
    expect(recent.unfinishedChapterCount).toBe(2)

    // 2. Local resume pointing to already-completed ch1 automatically advances to platform-recent unfinished ch2
    const advanced = resolveCourseResumeTarget(course, [ch1, ch2, ch3], pointsByChapter, {
      courseId: 'c1',
      chapterId: 'ch1',
      sectionNumber: null,
      sectionTitle: null,
      updatedAt: '2026-11-24T09:00:00.000Z'
    })
    expect(advanced.kind).toBe('resume_platform')
    expect(advanced.chapter?.id).toBe('ch2')

    // 3. No timestamps -> picks first unfinished chapter
    const firstUnfinished = resolveCourseResumeTarget(
      course,
      [ch1, { ...ch2, lastStudiedAt: null }, ch3],
      pointsByChapter,
      null
    )
    expect(firstUnfinished.kind).toBe('next_unfinished')
    expect(firstUnfinished.chapter?.id).toBe('ch2')

    // 4. All points done -> all_done
    const allDonePoints = new Map<string, StudyPoint[]>([
      ['ch1', [makePoint({ id: 'p1', courseId: 'c1', chapterId: 'ch1', status: 'done' })]]
    ])
    const allDone = resolveCourseResumeTarget(course, [ch1], allDonePoints, null)
    expect(allDone.kind).toBe('all_done')

    // 5. Chapters without points or sections -> honest browse_only (never all_done!)
    const browseOnly = resolveCourseResumeTarget(course, [ch1], new Map(), null)
    expect(browseOnly.kind).toBe('browse_only')
  })

  it('validates course + chapter existence and ownership in global resume records and skips stale entries', () => {
    expect(parseStudyResumeStorage('{bad json')).toEqual({})
    expect(parseStudyResumeStorage('[]')).toEqual({})

    let map: StudyResumeMap = {}
    // Newest: unknown course (other account) -> invalid
    map = upsertStudyResumeRecord(
      map,
      {
        courseId: 'other-account-course',
        chapterId: 'ch-x',
        sectionNumber: null,
        sectionTitle: null,
        updatedAt: '2026-11-24T16:00:00.000Z'
      },
      10
    )
    // Second newest: existing course c2, but deleted chapter -> invalid
    map = upsertStudyResumeRecord(
      map,
      {
        courseId: 'c2',
        chapterId: 'ch-deleted',
        sectionNumber: '2.1',
        sectionTitle: '已删除章节',
        updatedAt: '2026-11-24T15:30:00.000Z'
      },
      10
    )
    // Third newest: existing course c3, but chapter belongs to c1 (ownership mismatch) -> invalid
    map = upsertStudyResumeRecord(
      map,
      {
        courseId: 'c3',
        chapterId: 'ch-1',
        sectionNumber: null,
        sectionTitle: null,
        updatedAt: '2026-11-24T15:00:00.000Z'
      },
      10
    )
    // Fourth newest: valid course c1 + chapter ch-1 belonging to c1 -> VALID!
    map = upsertStudyResumeRecord(
      map,
      {
        courseId: 'c1',
        chapterId: 'ch-1',
        sectionNumber: '1.2',
        sectionTitle: '极限',
        updatedAt: '2026-11-24T14:00:00.000Z'
      },
      10
    )

    const parsed = parseStudyResumeStorage(JSON.stringify(map))
    const c1 = makeCourse({ id: 'c1', name: '高等数学' })
    const c2 = makeCourse({ id: 'c2', name: '已学完课程' })
    const c3 = makeCourse({ id: 'c3', name: '大学物理' })
    const chapters = [
      makeChapter({ id: 'ch-1', courseId: 'c1', title: '第 1 章' }),
      makeChapter({ id: 'ch-2', courseId: 'c2', title: '第 1 章' })
    ]

    // Skips all 3 invalid/stale records and resolves to c1 / ch-1
    const globalLast = resolveGlobalLastStudiedCourse([c1, c2, c3], chapters, parsed)
    expect(globalLast?.course.id).toBe('c1')
    expect(globalLast?.chapter.id).toBe('ch-1')
    expect(globalLast?.record.sectionNumber).toBe('1.2')

    // Returns null when no valid records remain
    const allStaleOnly = resolveGlobalLastStudiedCourse(
      [c2, c3],
      [makeChapter({ id: 'ch-2', courseId: 'c2', title: '第 1 章' })],
      parsed
    )
    expect(allStaleOnly).toBeNull()

    // Attention filter: c1 has unfinished point; c2 has only completed chapter + submitted task
    const points = [
      makePoint({ id: 'p1', courseId: 'c1', chapterId: 'ch-1', status: 'todo' }),
      makePoint({ id: 'p2', courseId: 'c2', chapterId: 'ch-2', status: 'done' })
    ]
    const tasks = [makeTask({ id: 't2', courseId: 'c2', platformStatusKind: 'submitted' })]
    expect(courseNeedsAttention('c1', chapters, points, tasks)).toBe(true)
    expect(courseNeedsAttention('c2', chapters, points, tasks)).toBe(false)
  })

  it('associates synced study points with sections via stable IDs: excludes locked todos, promotes playable chapters, and directs pendingCount=0 todo sections', () => {
    const courseExtId = '24001:55001'
    const course = makeCourse({
      id: 'c-sync',
      externalId: courseExtId,
      name: '高等代数',
      sourceUrl: 'https://mooc1.chaoxing.com/course/24001'
    })

    // Ch1: real Chaoxing synced structure — 1.1 done + 1.2 locked with todo study point (pendingCount=0)
    const ch1 = makeChapter({
      id: 'ch-sync-1',
      courseId: 'c-sync',
      externalId: `${courseExtId}:ch:1`,
      title: '多项式基础',
      sortOrder: 0,
      sourceUrl: 'https://mooc1.chaoxing.com/chapter/sync-1',
      sections: [
        {
          number: '1.1',
          title: '整除概念',
          completed: true,
          pendingCount: 0,
          locked: false,
          chapterId: '90011',
          sourceUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=90011',
          resources: []
        },
        {
          number: '1.2',
          title: '未解锁综合测验',
          completed: false,
          pendingCount: 0,
          locked: true,
          chapterId: '90012',
          sourceUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=90012',
          resources: []
        }
      ]
    })

    // Ch2: subsequent playable chapter — 2.1 unlocked, pendingCount=0, BUT has explicit associated todo StudyPoint + allowlisted URL
    const ch2 = makeChapter({
      id: 'ch-sync-2',
      courseId: 'c-sync',
      externalId: `${courseExtId}:ch:2`,
      title: '行列式',
      sortOrder: 1,
      sourceUrl: 'https://mooc1.chaoxing.com/chapter/sync-2',
      sections: [
        {
          number: '2.1',
          title: '二阶与三阶行列式',
          completed: false,
          pendingCount: 0,
          locked: false,
          chapterId: '90021',
          sourceUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=90021',
          resources: []
        }
      ]
    })

    // Ch3: zero-task outline chapter (pendingCount=0, no associated StudyPoints) -> must stay unknown!
    const ch3 = makeChapter({
      id: 'ch-sync-3',
      courseId: 'c-sync',
      externalId: `${courseExtId}:ch:3`,
      title: '拓展阅读目录',
      sortOrder: 2,
      sourceUrl: 'https://mooc1.chaoxing.com/chapter/sync-3',
      sections: [
        {
          number: '3.1',
          title: '参考讲义',
          completed: false,
          pendingCount: 0,
          locked: false,
          chapterId: '90031',
          sourceUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=90031',
          resources: []
        }
      ]
    })

    const ch1Points = [
      makePoint({
        id: 'pt-1-1',
        courseId: 'c-sync',
        chapterId: 'ch-sync-1',
        externalId: `${courseExtId}:sec:1.1`,
        title: '整除概念',
        status: 'done',
        durationMinutes: 10
      }),
      makePoint({
        id: 'pt-1-2',
        courseId: 'c-sync',
        chapterId: 'ch-sync-1',
        externalId: `${courseExtId}:sec:1.2`,
        title: '未解锁综合测验',
        status: 'todo',
        durationMinutes: 25
      })
    ]
    const ch2Points = [
      makePoint({
        id: 'pt-2-1',
        courseId: 'c-sync',
        chapterId: 'ch-sync-2',
        externalId: `${courseExtId}:sec:2.1`,
        title: '二阶与三阶行列式',
        status: 'todo',
        durationMinutes: 20
      })
    ]

    // 1. Ch1 has only a completed unlocked point + locked todo -> locked (NOT incomplete!)
    const ch1Summary = getChapterWorkflowSummary(ch1, ch1Points)
    expect(ch1Summary).toMatchObject({
      status: 'locked',
      pointTotal: 2,
      pointDone: 1,
      remainingPoints: 0,
      lockedPointCount: 1,
      remainingMinutes: 0,
      lockedPendingCount: 1
    })

    // 2. Ch2 has pendingCount=0 + associated todo StudyPoint -> incomplete AND directly targets section 2.1!
    const ch2Summary = getChapterWorkflowSummary(ch2, ch2Points)
    expect(ch2Summary).toMatchObject({
      status: 'incomplete',
      remainingPoints: 1,
      remainingMinutes: 20,
      unfinishedUnlockedSections: 1
    })
    expect(ch2Summary.nextUnfinishedSection?.number).toBe('2.1')

    // 3. Ch3 zero-task outline stays unknown (no regression!)
    expect(getChapterWorkflowSummary(ch3, []).status).toBe('unknown')

    // 4. Course progress preserves real progress including locked todo (1/3 = 33%)
    const allChapters = [ch1, ch2, ch3]
    const allPoints = [...ch1Points, ...ch2Points]
    expect(getCourseProgress('c-sync', allChapters, allPoints)).toMatchObject({
      done: 1,
      total: 3,
      percent: 33
    })

    // 5. Course resume target skips locked ch1 and recommends playable ch2 -> section 2.1 directly!
    const pointsByChapter = new Map<string, StudyPoint[]>([
      ['ch-sync-1', ch1Points],
      ['ch-sync-2', ch2Points]
    ])
    const target = resolveCourseResumeTarget(course, allChapters, pointsByChapter, {
      courseId: 'c-sync',
      chapterId: 'ch-sync-1', // even if user previously visited ch1, now only locked tasks remain there
      sectionNumber: '1.1',
      sectionTitle: '整除概念',
      updatedAt: '2026-11-24T12:00:00.000Z'
    })
    expect(target.kind).toBe('next_unfinished')
    expect(target.chapter?.id).toBe('ch-sync-2')
    expect(target.section?.number).toBe('2.1')
    expect(target.destination).toEqual({
      kind: 'section',
      url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=90021',
      section: ch2.sections[0]
    })
    expect(target.remainingPoints).toBe(1)
    expect(target.remainingMinutes).toBe(20)
    expect(target.unfinishedChapterCount).toBe(1)
    expect(target.lockedChapterCount).toBe(1)
    expect(target.lockedPendingCount).toBe(1)
    expect(courseNeedsAttention('c-sync', allChapters, allPoints, [])).toBe(true)

    // 6. Locked + Unknown + Completed chapters coexisting (once ch2 is completed) -> locked_only, NOT all_done, NOT needsAttention
    const ch2DonePoints = ch2Points.map((pt) => ({ ...pt, status: 'done' as const }))
    const lockedMixedPointsByChapter = new Map<string, StudyPoint[]>([
      ['ch-sync-1', ch1Points],
      ['ch-sync-2', ch2DonePoints]
    ])
    const lockedMixedTarget = resolveCourseResumeTarget(
      course,
      allChapters,
      lockedMixedPointsByChapter,
      null
    )
    expect(lockedMixedTarget.kind).toBe('locked_only')
    expect(lockedMixedTarget.chapter?.id).toBe('ch-sync-1')
    expect(lockedMixedTarget.section).toBeNull()
    expect(lockedMixedTarget.destination).toEqual({
      kind: 'chapter',
      url: 'https://mooc1.chaoxing.com/chapter/sync-1',
      section: null
    })
    expect(lockedMixedTarget.remainingPoints).toBe(0)
    expect(lockedMixedTarget.unfinishedChapterCount).toBe(0)
    expect(lockedMixedTarget.lockedChapterCount).toBe(1)
    expect(lockedMixedTarget.lockedPendingCount).toBe(1)
    expect(courseNeedsAttention('c-sync', allChapters, [...ch1Points, ...ch2DonePoints], [])).toBe(
      false
    )
    expect(
      getCourseProgress('c-sync', allChapters, [...ch1Points, ...ch2DonePoints])
    ).toMatchObject({
      done: 2,
      total: 3,
      percent: 67
    })

    // 7. Unassociated StudyPoints (no stable section ID or mismatched prefix) are NEVER arbitrarily assigned to other sections
    const unassociatedPoint = makePoint({
      id: 'pt-unlinked',
      courseId: 'c-sync',
      chapterId: 'ch-sync-3',
      externalId: null,
      title: '参考讲义', // even identical title must NOT falsely bind without stable section ID
      status: 'todo'
    })
    const wrongPrefixPoint = makePoint({
      id: 'pt-wrong-prefix',
      courseId: 'c-sync',
      chapterId: 'ch-sync-3',
      externalId: '99999:88888:sec:3.1',
      title: '错前缀学习点',
      status: 'todo'
    })
    const assoc = associateChapterPointsWithSections(ch3, [unassociatedPoint, wrongPrefixPoint])
    expect(assoc.pointToSection.get(unassociatedPoint)).toBeNull()
    expect(assoc.pointToSection.get(wrongPrefixPoint)).toBeNull()
    expect(assoc.unassociatedPoints).toEqual([unassociatedPoint, wrongPrefixPoint])
    // Destination must NOT arbitrarily open section 3.1 when the todo point isn't linked to 3.1
    const unlinkedDest = resolveChapterOfficialDestination(course, ch3, {
      mode: 'resume',
      chapterPoints: [unassociatedPoint]
    })
    expect(unlinkedDest).toEqual({
      kind: 'chapter',
      url: 'https://mooc1.chaoxing.com/chapter/sync-3',
      section: null
    })
  })

  it('N-005-R2: skips an explicitly completed section with a stale todo and resumes the later unfinished section', () => {
    const courseExtId = '24001:55001'
    const course = makeCourse({
      id: 'c-stale',
      externalId: courseExtId,
      name: '高等数学',
      sourceUrl: 'https://mooc1.chaoxing.com/course/24001'
    })
    const chapter = makeChapter({
      id: 'ch-stale',
      courseId: 'c-stale',
      externalId: `${courseExtId}:ch:1`,
      title: '第一章 极限',
      sourceUrl: 'https://mooc1.chaoxing.com/chapter/stale-1',
      sections: [
        {
          number: '1.1',
          title: '新同步已完成小节',
          completed: true,
          pendingCount: 0,
          locked: false,
          chapterId: '90011',
          sourceUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=90011',
          resources: []
        },
        {
          number: '1.2',
          title: '后续明确待办小节',
          completed: false,
          pendingCount: 0,
          locked: false,
          chapterId: '90012',
          sourceUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=90012',
          resources: []
        }
      ]
    })
    const points = [
      makePoint({
        id: 'pt-stale-1-1',
        courseId: 'c-stale',
        chapterId: 'ch-stale',
        externalId: `${courseExtId}:sec:1.1`,
        title: '旧本地待办（小节已同步完成）',
        status: 'todo',
        durationMinutes: 10
      }),
      makePoint({
        id: 'pt-active-1-2',
        courseId: 'c-stale',
        chapterId: 'ch-stale',
        externalId: `${courseExtId}:sec:1.2`,
        title: '后续小节待办',
        status: 'todo',
        durationMinutes: 20
      })
    ]

    const summary = getChapterWorkflowSummary(chapter, points)
    expect(summary).toMatchObject({
      status: 'incomplete',
      pointTotal: 2,
      pointDone: 0,
      remainingPoints: 1,
      remainingMinutes: 20,
      sectionTotal: 2,
      sectionDone: 1,
      unfinishedUnlockedSections: 1,
      nextUnfinishedSection: chapter.sections[1]
    })
    expect(summary.nextUnfinishedSection?.number).toBe('1.2')

    // Resume mode must pick the later explicit todo section, not the completed stale section.
    const destination = resolveChapterOfficialDestination(course, chapter, {
      mode: 'resume',
      chapterPoints: points
    })
    expect(destination.kind).toBe('section')
    expect(destination.section?.number).toBe('1.2')
    expect(destination.url).toBe('https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=90012')
    expect(getChapterResumeOfficialUrl(course, chapter, '1.1', points)).toBe(
      'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=90012'
    )

    // A persisted resume record pointing at the completed 1.1 must also advance to 1.2.
    const target = resolveCourseResumeTarget(
      course,
      [chapter],
      new Map<string, StudyPoint[]>([['ch-stale', points]]),
      {
        courseId: 'c-stale',
        chapterId: 'ch-stale',
        sectionNumber: '1.1',
        sectionTitle: '新同步已完成小节',
        updatedAt: '2026-11-24T12:00:00.000Z'
      }
    )
    expect(target.kind).toBe('resume_recent')
    expect(target.chapter?.id).toBe('ch-stale')
    expect(target.section?.number).toBe('1.2')
    expect(target.destination.url).toBe(
      'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=90012'
    )
  })

  it('N-005-R2: explicit completion ignores a lone stale todo without erasing point records', () => {
    const courseExtId = '24001:55002'
    const course = makeCourse({
      id: 'c-stale-only',
      externalId: courseExtId,
      name: '线性代数',
      sourceUrl: 'https://mooc1.chaoxing.com/course/24002'
    })
    const chapter = makeChapter({
      id: 'ch-stale-only',
      courseId: 'c-stale-only',
      externalId: `${courseExtId}:ch:1`,
      title: '第一章 行列式',
      sourceUrl: 'https://mooc1.chaoxing.com/chapter/stale-only-1',
      sections: [
        {
          number: '1.1',
          title: '新同步已完成小节',
          completed: true,
          pendingCount: 0,
          locked: false,
          chapterId: '91011',
          sourceUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=91011',
          resources: []
        }
      ]
    })
    const points = [
      makePoint({
        id: 'pt-stale-only',
        courseId: 'c-stale-only',
        chapterId: 'ch-stale-only',
        externalId: `${courseExtId}:sec:1.1`,
        title: '旧本地待办（小节已同步完成）',
        status: 'todo',
        durationMinutes: 30
      })
    ]

    const summary = getChapterWorkflowSummary(chapter, points)
    expect(summary).toMatchObject({
      status: 'completed',
      pointTotal: 1,
      pointDone: 0,
      remainingPoints: 0,
      remainingMinutes: 0,
      sectionTotal: 1,
      sectionDone: 1,
      unfinishedUnlockedSections: 0,
      nextUnfinishedSection: null
    })
    expect(courseNeedsAttention('c-stale-only', [chapter], points, [])).toBe(false)

    // Resume mode must degrade to the chapter entry instead of opening completed section 1.1.
    const destination = resolveChapterOfficialDestination(course, chapter, {
      mode: 'resume',
      chapterPoints: points
    })
    expect(destination).toEqual({
      kind: 'chapter',
      url: 'https://mooc1.chaoxing.com/chapter/stale-only-1',
      section: null
    })

    const target = resolveCourseResumeTarget(
      course,
      [chapter],
      new Map<string, StudyPoint[]>([['ch-stale-only', points]]),
      null
    )
    expect(target.kind).toBe('all_done')
    expect(target.section).toBeNull()
    expect(target.remainingPoints).toBe(0)
  })

  it('N-005-R2: pendingCount=0 with an actionable todo on a non-completed section still allows direct section resume', () => {
    const courseExtId = '24001:55003'
    const course = makeCourse({
      id: 'c-direct',
      externalId: courseExtId,
      name: '概率论',
      sourceUrl: 'https://mooc1.chaoxing.com/course/24003'
    })
    const chapter = makeChapter({
      id: 'ch-direct',
      courseId: 'c-direct',
      externalId: `${courseExtId}:ch:1`,
      title: '第一章 随机事件',
      sourceUrl: 'https://mooc1.chaoxing.com/chapter/direct-1',
      sections: [
        {
          number: '1.1',
          title: '未显式完成但有本地待办的小节',
          completed: false,
          pendingCount: 0,
          locked: false,
          chapterId: '92011',
          sourceUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=92011',
          resources: []
        }
      ]
    })
    const points = [
      makePoint({
        id: 'pt-direct-1-1',
        courseId: 'c-direct',
        chapterId: 'ch-direct',
        externalId: `${courseExtId}:sec:1.1`,
        title: '待办任务点',
        status: 'todo',
        durationMinutes: 15
      })
    ]

    const summary = getChapterWorkflowSummary(chapter, points)
    expect(summary).toMatchObject({
      status: 'incomplete',
      pointTotal: 1,
      pointDone: 0,
      remainingPoints: 1,
      remainingMinutes: 15,
      sectionDone: 0,
      unfinishedUnlockedSections: 1,
      nextUnfinishedSection: chapter.sections[0]
    })
    expect(summary.nextUnfinishedSection?.number).toBe('1.1')

    expect(getChapterResumeOfficialUrl(course, chapter, '1.1', points)).toBe(
      'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=92011'
    )
    const destination = resolveChapterOfficialDestination(course, chapter, {
      mode: 'resume',
      chapterPoints: points
    })
    expect(destination.kind).toBe('section')
    expect(destination.section?.number).toBe('1.1')
  })

  it('N-005-R2: pending evidence still wins over completed flag when pendingCount > 0', () => {
    const course = makeCourse({
      id: 'c-pending-wins',
      name: '大学物理',
      sourceUrl: 'https://mooc1.chaoxing.com/course/24004'
    })
    const chapter = makeChapter({
      id: 'ch-pending-wins',
      courseId: 'c-pending-wins',
      title: '第一章 力学',
      sourceUrl: 'https://mooc1.chaoxing.com/chapter/pending-wins-1',
      sections: [
        {
          number: '1.1',
          title: '标记完成但仍有待完成项的小节',
          completed: true,
          pendingCount: 2,
          locked: false,
          chapterId: '93011',
          sourceUrl: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=93011',
          resources: []
        }
      ]
    })

    const summary = getChapterWorkflowSummary(chapter, [])
    expect(summary).toMatchObject({
      status: 'incomplete',
      pointTotal: 0,
      pointDone: 0,
      remainingPoints: 0,
      sectionTotal: 1,
      sectionDone: 0,
      unfinishedUnlockedSections: 1,
      sectionPendingCount: 2,
      nextUnfinishedSection: chapter.sections[0]
    })

    const destination = resolveChapterOfficialDestination(course, chapter, {
      mode: 'resume',
      chapterPoints: []
    })
    expect(destination.kind).toBe('section')
    expect(destination.section?.number).toBe('1.1')
  })
})
