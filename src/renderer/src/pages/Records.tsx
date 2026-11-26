import { useMemo, useState, type JSX } from 'react'
import { ClipboardList, ExternalLink, FileText, Search } from 'lucide-react'
import type { Course, Task } from '@shared/types'
import { getCourseClassLabel } from '@shared/course-identity'
import { getTaskPortalAction, getTaskScoreView, platformStatusLabel } from '@shared/task-state'
import {
  filterAndSortRecords,
  isRecordTask,
  summarizeRecordQuickCounts,
  type RecordFilter,
  type RecordSortMode
} from '@shared/task-workflow'
import { formatDueAt, formatOptionalDateTime } from '../lib/format'
import { Badge, Button, EmptyState, PageHeader } from '../ui/primitives'
import { platformStatusTone } from '../ui/status'

interface RecordsProps {
  tasks: Task[]
  courses: Course[]
  dataUpdatedAt?: string | null
  embedded?: boolean
  onOpenTask: (task: Task) => void
  onOpenInPortal: (task: Task) => void
}

export function Records({
  tasks,
  courses,
  dataUpdatedAt,
  embedded = false,
  onOpenTask,
  onOpenInPortal
}: RecordsProps): JSX.Element {
  const [keyword, setKeyword] = useState('')
  const [filter, setFilter] = useState<RecordFilter>('all')
  const [courseId, setCourseId] = useState('all')
  const [gradedOnly, setGradedOnly] = useState(false)
  const [feedbackOnly, setFeedbackOnly] = useState(false)
  const [sortMode, setSortMode] = useState<RecordSortMode>('updated')
  const courseById = useMemo(() => new Map(courses.map((course) => [course.id, course])), [courses])
  const duplicateCourseNames = useMemo(() => {
    const seen = new Map<string, number>()
    for (const course of courses) {
      seen.set(course.name, (seen.get(course.name) ?? 0) + 1)
    }
    return new Set([...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name))
  }, [courses])
  const courseOptionLabel = (course: Course): string =>
    duplicateCourseNames.has(course.name)
      ? `${course.name}（${getCourseClassLabel(course)}）`
      : course.className
        ? `${course.name} · ${course.className}`
        : course.name

  const homework = useMemo(() => tasks.filter(isRecordTask), [tasks])
  const counts = useMemo(
    () => ({
      all: homework.length,
      not_submitted: homework.filter((task) => task.platformStatusKind === 'not_submitted').length,
      submitted: homework.filter((task) => task.platformStatusKind === 'submitted').length,
      pending_review: homework.filter((task) => task.platformStatusKind === 'pending_review')
        .length,
      reviewed: homework.filter((task) => task.platformStatusKind === 'reviewed').length,
      done: homework.filter((task) => task.platformStatusKind === 'done').length
    }),
    [homework]
  )
  const quickCounts = useMemo(() => summarizeRecordQuickCounts(homework), [homework])

  const rows = useMemo(
    () =>
      filterAndSortRecords(homework, courses, {
        filter,
        courseId,
        keyword,
        gradedOnly,
        feedbackOnly,
        sortMode
      }),
    [homework, courses, filter, courseId, keyword, gradedOnly, feedbackOnly, sortMode]
  )

  const hasActiveFilters =
    filter !== 'all' || courseId !== 'all' || keyword.trim() !== '' || gradedOnly || feedbackOnly
  const resetFilters = (): void => {
    setKeyword('')
    setFilter('all')
    setCourseId('all')
    setGradedOnly(false)
    setFeedbackOnly(false)
  }

  const summary: Array<{ value: RecordFilter; label: string; count: number }> = [
    { value: 'all', label: '全部', count: counts.all },
    { value: 'not_submitted', label: '未提交', count: counts.not_submitted },
    { value: 'submitted', label: '已提交', count: counts.submitted },
    { value: 'pending_review', label: '待审核', count: counts.pending_review },
    { value: 'reviewed', label: '已批阅', count: counts.reviewed },
    { value: 'done', label: '已完成', count: counts.done }
  ]

  return (
    <div
      className={
        embedded ? 'records-embedded b2-records-page' : 'page records-page b2-records-page'
      }
    >
      {!embedded ? (
        <PageHeader
          eyebrow="作业记录"
          title="提交、成绩与批语"
          icon={<ClipboardList size={12} />}
          subtitle={`只展示学习通实际返回的数据。零分保留为 0，未评分与未知不会混为一谈。已批阅只统计教师完成批阅，已完成单独统计。数据更新 ${formatOptionalDateTime(dataUpdatedAt ?? null)}。`}
        />
      ) : null}

      <div className="b2-records-summary" role="group" aria-label="按平台状态筛选作业记录">
        {summary.map((item) => (
          <button
            key={item.value}
            type="button"
            className={filter === item.value ? 'b2-summary-item active' : 'b2-summary-item'}
            aria-pressed={filter === item.value}
            onClick={() => setFilter(item.value)}
          >
            <span>{item.label}</span>
            <strong>{item.count}</strong>
          </button>
        ))}
      </div>

      <div className="card b2-records-toolbar n7-records-toolbar">
        <label className="search-box">
          <Search size={14} />
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索作业、课程或批语"
            aria-label="搜索作业记录"
          />
        </label>
        <select
          className="select"
          value={courseId}
          onChange={(event) => setCourseId(event.target.value)}
          aria-label="按课程筛选作业记录"
        >
          <option value="all">全部课程</option>
          {courses.map((course) => (
            <option key={course.id} value={course.id}>
              {courseOptionLabel(course)}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={sortMode}
          onChange={(event) => setSortMode(event.target.value as RecordSortMode)}
          aria-label="作业记录排序"
        >
          <option value="updated">按提交/更新时间</option>
          <option value="due">按截止时间</option>
        </select>
        <div className="n7-records-quick-filters" role="group" aria-label="成绩与批语快捷筛选">
          <button
            type="button"
            className={gradedOnly ? 'n7-filter-chip active' : 'n7-filter-chip'}
            aria-pressed={gradedOnly}
            onClick={() => setGradedOnly((prev) => !prev)}
          >
            仅看已出分 <span className="n7-chip-count">{quickCounts.graded}</span>
          </button>
          <button
            type="button"
            className={feedbackOnly ? 'n7-filter-chip active' : 'n7-filter-chip'}
            aria-pressed={feedbackOnly}
            onClick={() => setFeedbackOnly((prev) => !prev)}
          >
            仅看有批语 <span className="n7-chip-count">{quickCounts.withFeedback}</span>
          </button>
        </div>
        <span className="b2-records-count">显示 {rows.length} 条</span>
        <span className="b2-records-scroll-hint">
          <span className="b2-scroll-line" aria-hidden="true" />
          左右滚动查看全部 9 列
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="card b2-records-empty">
          <EmptyState
            icon={<FileText size={18} />}
            title="没有符合条件的作业记录"
            description={
              homework.length === 0
                ? '请先在设置页完成学习通同步，或调整筛选条件。'
                : '试试清除搜索或筛选条件，查看全部记录。'
            }
            action={
              hasActiveFilters ? (
                <Button variant="secondary" size="sm" onClick={resetFilters}>
                  清除筛选
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="card records-card b2-records-card">
          <div
            className="b2-records-scroll"
            tabIndex={0}
            role="region"
            aria-label="作业记录表格，可横向滚动"
          >
            <table className="records-table b2-records-table">
              <thead>
                <tr>
                  <th className="b2-col-task">作业名称</th>
                  <th className="b2-col-course">课程 / 教学班</th>
                  <th className="b2-col-due">截止时间</th>
                  <th className="b2-col-submitted">提交时间</th>
                  <th className="b2-col-status">平台状态</th>
                  <th className="b2-col-score">成绩</th>
                  <th className="b2-col-feedback">教师批语</th>
                  <th className="b2-col-attachments">附件</th>
                  <th className="b2-col-action">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((task) => {
                  const course = task.courseId ? courseById.get(task.courseId) : null
                  const sameName = course
                    ? courses.filter((item) => item.name === course.name).length > 1
                    : false
                  const classLabel = course ? getCourseClassLabel(course) : null
                  const portalAction = getTaskPortalAction(task, course)
                  const scoreView = getTaskScoreView(task)
                  const attachmentTitle = task.attachments.map((item) => item.name).join('\n')
                  return (
                    <tr key={task.id}>
                      <td className="b2-col-task">
                        <button
                          type="button"
                          className="b2-record-title"
                          onClick={() => onOpenTask(task)}
                          title={task.title}
                        >
                          {task.title}
                        </button>
                      </td>
                      <td className="b2-col-course">
                        <span className="b2-record-course">{course?.name ?? '未知课程'}</span>
                        {sameName && classLabel ? (
                          <span className="records-class" title={classLabel}>
                            {classLabel}
                          </span>
                        ) : null}
                      </td>
                      <td className="b2-col-due b2-record-time">
                        {formatDueAt(task.dueAt) || <span className="b2-muted">未设置</span>}
                      </td>
                      <td className="b2-col-submitted b2-record-time">
                        {task.submittedAt ? (
                          formatOptionalDateTime(task.submittedAt)
                        ) : (
                          <span className="b2-muted">未返回</span>
                        )}
                      </td>
                      <td className="b2-col-status">
                        <Badge
                          tone={platformStatusTone(task.platformStatusKind)}
                          className={`records-status b2-record-status status-${task.platformStatusKind}`}
                        >
                          {platformStatusLabel(task.platformStatusKind)}
                        </Badge>
                        {task.platformStatus &&
                        task.platformStatus !== platformStatusLabel(task.platformStatusKind) ? (
                          <span className="b2-record-raw" title={task.platformStatus}>
                            原文：{task.platformStatus}
                          </span>
                        ) : null}
                      </td>
                      <td className="b2-col-score">
                        <span className="b2-record-score" data-score-state={scoreView.state}>
                          {scoreView.text}
                        </span>
                      </td>
                      <td className="b2-col-feedback">
                        {task.teacherFeedback ? (
                          <span className="b2-record-feedback" title={task.teacherFeedback}>
                            {task.teacherFeedback}
                          </span>
                        ) : (
                          <span className="b2-muted">—</span>
                        )}
                      </td>
                      <td className="b2-col-attachments">
                        {task.attachments.length > 0 ? (
                          <span className="b2-record-attachments" title={attachmentTitle}>
                            {task.attachments.slice(0, 2).map((attachment) => (
                              <span
                                key={`${attachment.objectId ?? attachment.name}-${attachment.name}`}
                              >
                                {attachment.name}
                              </span>
                            ))}
                            {task.attachments.length > 2 ? (
                              <span className="b2-more">+{task.attachments.length - 2}</span>
                            ) : null}
                          </span>
                        ) : (
                          <span className="b2-muted">—</span>
                        )}
                      </td>
                      <td className="b2-col-action">
                        {portalAction.target ? (
                          <button
                            type="button"
                            className="b2-record-open"
                            title={portalAction.title}
                            onClick={() => onOpenInPortal(task)}
                          >
                            <ExternalLink size={13} />
                            {portalAction.label}
                          </button>
                        ) : (
                          <span className="b2-record-unavailable" title={portalAction.title}>
                            无可用入口
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
