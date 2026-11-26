import { describe, expect, it } from 'vitest'
import type { Course, Task } from '@shared/types'
import { UNKNOWN_DUE_AT } from '@shared/constants'
import {
  buildTaskDeadlineGroups,
  filterAndSortRecords,
  filterAndSortWorkflowTasks,
  formatTaskRowDueCaption,
  getTaskDetailDueBanner,
  isRecordTask,
  isTaskActionableOverdue,
  matchesTaskDeadlineFilter,
  summarizeRecordQuickCounts,
  summarizeTaskWorkflow
} from '@shared/task-workflow'
import { getTaskStatusView } from '@shared/task-state'

const NOW = new Date('2026-11-25T10:00:00+08:00')

function makeCourse(overrides: Partial<Course> = {}): Course {
  return {
    id: 'course-1',
    name: '数据结构',
    code: 'CS201',
    teacher: '张老师',
    category: '专业必修',
    color: '#2563eb',
    semester: '2026秋',
    className: '计科2301班',
    clazzId: '1001',
    schedule: [],
    source: 'chaoxing',
    externalId: 'cx-course-1',
    sourceUrl: 'https://mooc1.chaoxing.com/course/1001.html',
    favorite: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    ...overrides
  }
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    courseId: 'course-1',
    title: '实验报告一',
    description: '',
    kind: 'homework',
    dueAt: '2026-11-25T18:00:00+08:00',
    priority: 'medium',
    status: 'todo',
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

describe('task-workflow', () => {
  it('summarizes cross-course DDL buckets without miscounting submitted/pending_review past-due tasks', () => {
    const overdueActionable = makeTask({
      id: 't-overdue',
      title: '逾期未交作业',
      dueAt: '2026-11-23T18:00:00+08:00',
      platformStatusKind: 'not_submitted'
    })
    const dueToday = makeTask({
      id: 't-today',
      title: '今晚截止作业',
      dueAt: '2026-11-25T20:00:00+08:00',
      platformStatusKind: 'not_submitted'
    })
    const dueSoon = makeTask({
      id: 't-soon',
      title: '两天后截止作业',
      dueAt: '2026-11-27T12:00:00+08:00',
      platformStatusKind: 'not_submitted'
    })
    const dueWeek = makeTask({
      id: 't-week',
      title: '五天后截止作业',
      dueAt: '2026-11-30T12:00:00+08:00',
      platformStatusKind: 'not_submitted'
    })
    const dueLater = makeTask({
      id: 't-later',
      title: '两周后截止作业',
      dueAt: '2026-12-10T12:00:00+08:00',
      platformStatusKind: 'not_submitted'
    })
    const unknownDue = makeTask({
      id: 't-nodue',
      title: '无明确截止作业',
      dueAt: UNKNOWN_DUE_AT,
      platformStatusKind: 'not_submitted'
    })
    const pendingReviewPastDue = makeTask({
      id: 't-review-past',
      title: '待审核且截止已过',
      dueAt: '2026-11-20T18:00:00+08:00',
      platformStatus: '待批阅',
      platformStatusKind: 'pending_review',
      submittedAt: '2026-11-19T12:00:00+08:00'
    })
    const reviewedZero = makeTask({
      id: 't-reviewed',
      title: '已批阅零分',
      dueAt: '2026-11-18T18:00:00+08:00',
      platformStatus: '已批阅',
      platformStatusKind: 'reviewed',
      score: '0',
      fullScore: '100',
      teacherFeedback: '需要补充代码说明'
    })
    const doneTask = makeTask({
      id: 't-done',
      title: '已完成作业',
      status: 'done',
      platformStatus: '已完成',
      platformStatusKind: 'done',
      dueAt: '2026-11-15T18:00:00+08:00',
      score: '95'
    })

    const summary = summarizeTaskWorkflow(
      [
        overdueActionable,
        dueToday,
        dueSoon,
        dueWeek,
        dueLater,
        unknownDue,
        pendingReviewPastDue,
        reviewedZero,
        doneTask
      ],
      NOW
    )

    expect(summary.total).toBe(9)
    expect(summary.actionableTotal).toBe(6)
    expect(summary.overdueActionable).toBe(1)
    expect(summary.dueTodayActionable).toBe(1)
    expect(summary.dueThreeDaysActionable).toBe(2)
    expect(summary.dueWeekActionable).toBe(3)
    expect(summary.noDueActionable).toBe(1)
    expect(summary.pendingReview).toBe(1)
    expect(summary.reviewed).toBe(1)
    expect(summary.completed).toBe(1)
    expect(summary.gradedCount).toBe(2) // '0' and '95' both count
    expect(summary.withFeedbackCount).toBe(1)
    expect(summary.nextUrgentTask?.id).toBe('t-today')

    expect(isTaskActionableOverdue(overdueActionable, NOW)).toBe(true)
    expect(isTaskActionableOverdue(pendingReviewPastDue, NOW)).toBe(false)
    expect(isTaskActionableOverdue(reviewedZero, NOW)).toBe(false)
  })

  it('picks most-recent overdue when no upcoming concrete deadline exists', () => {
    const olderOverdue = makeTask({
      id: 'old-over',
      dueAt: '2026-11-10T10:00:00+08:00'
    })
    const recentOverdue = makeTask({
      id: 'recent-over',
      dueAt: '2026-11-24T22:00:00+08:00'
    })
    const unknown = makeTask({
      id: 'unknown',
      dueAt: UNKNOWN_DUE_AT,
      priority: 'high'
    })

    const summary = summarizeTaskWorkflow([olderOverdue, recentOverdue, unknown], NOW)
    expect(summary.nextUrgentTask?.id).toBe('recent-over')
  })

  it('filters by deadline windows and prioritizes overdue group cleanly', () => {
    const olderOverdue = makeTask({
      id: 'over-old',
      title: '较早逾期',
      dueAt: '2026-11-18T12:00:00+08:00'
    })
    const newerOverdue = makeTask({
      id: 'over-new',
      title: '昨天逾期',
      dueAt: '2026-11-24T12:00:00+08:00'
    })
    const today = makeTask({
      id: 'today',
      title: '今天截止任务',
      dueAt: '2026-11-25T23:00:00+08:00'
    })
    const pendingReviewPast = makeTask({
      id: 'pending-past',
      title: '待审核过期',
      dueAt: '2026-11-20T12:00:00+08:00',
      platformStatusKind: 'pending_review'
    })
    const reviewed = makeTask({
      id: 'reviewed',
      title: '已批阅任务',
      dueAt: '2026-11-28T12:00:00+08:00',
      platformStatusKind: 'reviewed'
    })
    const done = makeTask({
      id: 'done',
      title: '已完成任务',
      status: 'done',
      platformStatusKind: 'done'
    })

    const all = [olderOverdue, newerOverdue, today, pendingReviewPast, reviewed, done]

    expect(matchesTaskDeadlineFilter(pendingReviewPast, 'overdue', NOW)).toBe(false)
    expect(matchesTaskDeadlineFilter(newerOverdue, 'overdue', NOW)).toBe(true)

    const overdueFiltered = filterAndSortWorkflowTasks(
      all,
      {
        query: '',
        status: 'todo',
        deadline: 'overdue',
        courseId: 'all',
        priority: 'all',
        sortMode: 'due'
      },
      NOW
    )
    expect(overdueFiltered.map((t) => t.id)).toEqual(['over-new', 'over-old'])

    const defaultGroups = buildTaskDeadlineGroups(all, NOW)
    expect(defaultGroups.map((g) => g.bucket)).toEqual([
      'today',
      'overdue',
      'review',
      'reviewed',
      'done'
    ])
    expect(defaultGroups.find((g) => g.bucket === 'overdue')?.items.map((t) => t.id)).toEqual([
      'over-new',
      'over-old'
    ])

    const todoGroups = buildTaskDeadlineGroups(all, NOW, { prioritizeOverdue: true })
    expect(todoGroups[0]?.bucket).toBe('overdue')
    expect(todoGroups[1]?.bucket).toBe('today')
  })

  it('preserves non-actionable overdue row caption while calming TaskDetail banner', () => {
    const pendingReviewPast = makeTask({
      id: 'pending-past',
      dueAt: '2026-11-20T10:00:00+08:00',
      platformStatus: '待批阅',
      platformStatusKind: 'pending_review'
    })
    const actionableOverdue = makeTask({
      id: 'actionable-past',
      dueAt: '2026-11-23T10:00:00+08:00',
      platformStatusKind: 'not_submitted'
    })
    const actionableToday = makeTask({
      id: 'actionable-today',
      dueAt: '2026-11-25T15:00:00+08:00',
      platformStatusKind: 'not_submitted'
    })

    expect(
      formatTaskRowDueCaption(pendingReviewPast, getTaskStatusView(pendingReviewPast, NOW), NOW)
    ).toBe('截止已过')
    expect(
      formatTaskRowDueCaption(actionableOverdue, getTaskStatusView(actionableOverdue, NOW), NOW)
    ).toBe('已逾期 2 天')
    expect(
      formatTaskRowDueCaption(actionableToday, getTaskStatusView(actionableToday, NOW), NOW)
    ).toBe('5 小时后截止')

    const settledBanner = getTaskDetailDueBanner(pendingReviewPast, NOW)
    expect(settledBanner.tone).toBe('settled')
    expect(settledBanner.label).toBe('待审核 · 截止已过')

    const overdueBanner = getTaskDetailDueBanner(actionableOverdue, NOW)
    expect(overdueBanner.tone).toBe('overdue')
    expect(overdueBanner.label).toBe('已逾期 2 天')

    const todayBanner = getTaskDetailDueBanner(actionableToday, NOW)
    expect(todayBanner.tone).toBe('today')
    expect(todayBanner.label).toContain('今天截止')
  })

  it('filters and sorts Records by graded (including zero score), feedback, keyword, and due date', () => {
    const courses = [
      makeCourse({ id: 'c1', name: '高等数学', className: 'A班' }),
      makeCourse({ id: 'c2', name: '高等数学', className: 'B班' })
    ]
    const zeroGraded = makeTask({
      id: 'r-zero',
      courseId: 'c1',
      title: '第一次习题',
      dueAt: '2026-11-28T12:00:00+08:00',
      submittedAt: '2026-11-22T10:00:00+08:00',
      platformStatusKind: 'reviewed',
      score: '0',
      fullScore: '100',
      teacherFeedback: '过程缺失，请重做'
    })
    const ungradedSubmitted = makeTask({
      id: 'r-ungraded',
      courseId: 'c2',
      title: '第二次习题',
      dueAt: '2026-11-26T12:00:00+08:00',
      submittedAt: '2026-11-24T10:00:00+08:00',
      platformStatusKind: 'submitted',
      score: null,
      fullScore: '100',
      teacherFeedback: null
    })
    const unknownDueGraded = makeTask({
      id: 'r-unknown-due',
      courseId: 'c1',
      title: '随堂测验',
      dueAt: UNKNOWN_DUE_AT,
      submittedAt: '2026-11-25T08:00:00+08:00',
      platformStatusKind: 'reviewed',
      score: '92',
      fullScore: '100',
      teacherFeedback: null
    })

    const homework = [zeroGraded, ungradedSubmitted, unknownDueGraded]
    expect(summarizeRecordQuickCounts(homework)).toEqual({ graded: 2, withFeedback: 1 })

    const gradedOnly = filterAndSortRecords(homework, courses, {
      filter: 'all',
      courseId: 'all',
      keyword: '',
      gradedOnly: true,
      feedbackOnly: false,
      sortMode: 'updated'
    })
    expect(gradedOnly.map((t) => t.id)).toEqual(['r-unknown-due', 'r-zero'])

    const feedbackOnly = filterAndSortRecords(homework, courses, {
      filter: 'all',
      courseId: 'all',
      keyword: '重做',
      gradedOnly: false,
      feedbackOnly: true,
      sortMode: 'updated'
    })
    expect(feedbackOnly.map((t) => t.id)).toEqual(['r-zero'])

    const sortedByDue = filterAndSortRecords(homework, courses, {
      filter: 'all',
      courseId: 'all',
      keyword: '',
      gradedOnly: false,
      feedbackOnly: false,
      sortMode: 'due'
    })
    expect(sortedByDue.map((t) => t.id)).toEqual(['r-ungraded', 'r-zero', 'r-unknown-due'])
  })

  it('uses a rolling 168-hour week window and aligns record score counts with the Records scope', () => {
    const withinWeek = makeTask({
      id: 'week-167h',
      dueAt: new Date(NOW.getTime() + 167 * 60 * 60 * 1000).toISOString()
    })
    const beyondWeek = makeTask({
      id: 'week-169h',
      dueAt: new Date(NOW.getTime() + 169 * 60 * 60 * 1000).toISOString()
    })
    expect(matchesTaskDeadlineFilter(withinWeek, 'week', NOW)).toBe(true)
    expect(matchesTaskDeadlineFilter(beyondWeek, 'week', NOW)).toBe(false)

    const gradedExam = makeTask({
      id: 'exam-graded',
      kind: 'exam',
      platformStatusKind: 'reviewed',
      score: '88',
      teacherFeedback: '考试讲评'
    })
    const summary = summarizeTaskWorkflow([gradedExam], NOW)
    expect(summary.gradedCount).toBe(0)
    expect(summary.withFeedbackCount).toBe(0)
    expect(summarizeRecordQuickCounts([gradedExam].filter(isRecordTask))).toEqual({
      graded: 0,
      withFeedback: 0
    })
  })
})
