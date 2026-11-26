import { useMemo, useState, type JSX } from 'react'
import { CalendarClock, ExternalLink, FileText, LogIn, Timer } from 'lucide-react'
import type { Course, Exam } from '@shared/types'
import { findUniqueCourseByName } from '@shared/course-context'
import {
  classifyExamBucket,
  normalizeExamScore,
  type ExamScheduleBucket
} from '@shared/today-schedule'
import { formatDateTime, formatOptionalDateTime } from '../lib/format'
import { Button } from '../ui/primitives'

interface ExamsProps {
  exams: Exam[]
  courses: Course[]
  embedded?: boolean
  authenticated?: boolean
  onConnectChaoxing?: () => void
  onOpenCourse: (course: Course) => void
}

type ExamBucket = ExamScheduleBucket

const BUCKET_LABEL: Record<ExamBucket, string> = {
  upcoming: '即将开始',
  ongoing: '进行中',
  past: '已结束',
  unknown: '时间待确认'
}

function examBucket(exam: Exam, now: number): ExamBucket {
  return classifyExamBucket(exam, now)
}

function statusTone(exam: Exam, bucket: ExamBucket): string {
  if (bucket === 'ongoing') return 'exam-tone-live'
  if (bucket === 'upcoming') return 'exam-tone-soon'
  if (bucket === 'past') return 'exam-tone-past'
  if (/已完成|已批阅|已通过/.test(exam.answerStatus)) return 'exam-tone-done'
  return 'exam-tone-unknown'
}

export function Exams({
  exams,
  courses,
  embedded = false,
  authenticated = false,
  onConnectChaoxing,
  onOpenCourse
}: ExamsProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [courseFilter, setCourseFilter] = useState('all')
  const now = Date.now()
  const courseFilterNames = useMemo(() => {
    const names = new Set<string>()
    for (const course of courses) {
      if (course.name.trim()) names.add(course.name.trim())
    }
    for (const exam of exams) {
      if (exam.courseName?.trim()) names.add(exam.courseName.trim())
    }
    return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  }, [courses, exams])
  const hasUnassigned = useMemo(
    () => exams.some((exam) => !exam.courseName || !exam.courseName.trim()),
    [exams]
  )

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return exams.filter((exam) => {
      const normalizedCourse = exam.courseName?.trim() ?? ''
      if (courseFilter === '__unassigned__') {
        if (normalizedCourse) return false
      } else if (courseFilter !== 'all' && normalizedCourse !== courseFilter) {
        return false
      }
      if (!keyword) return true
      return (
        exam.title.toLowerCase().includes(keyword) ||
        normalizedCourse.toLowerCase().includes(keyword) ||
        exam.examStatus.toLowerCase().includes(keyword) ||
        exam.answerStatus.toLowerCase().includes(keyword)
      )
    })
  }, [courseFilter, exams, query])

  const counts = useMemo(() => {
    const next = { upcoming: 0, ongoing: 0, past: 0, unknown: 0 }
    for (const exam of exams) next[examBucket(exam, now)] += 1
    return next
  }, [exams, now])

  return (
    <div className={embedded ? 'studio-exams-embedded' : 'page'}>
      {embedded ? (
        <div className="studio-exams-summary-bar">
          <span>
            共 <strong>{exams.length}</strong> 场考试
            {counts.ongoing > 0 ? ` · 进行中 ${counts.ongoing}` : ''}
            {counts.upcoming > 0 ? ` · 即将开始 ${counts.upcoming}` : ''}
            {counts.past > 0 ? ` · 已结束 ${counts.past}` : ''}
          </span>
          <span className="studio-exams-note">考试与作业分开只读展示，不直接进入考场作答页</span>
        </div>
      ) : (
        <header className="page-header">
          <div className="page-header-copy">
            <div className="eyebrow">
              <FileText size={12} /> 考试中心
            </div>
            <h1 className="page-title">考试安排</h1>
            <p className="page-subtitle">
              共 {exams.length} 场考试 · 即将开始 {counts.upcoming} · 已结束 {counts.past}
              。考试与作业任务分开管理，这里只读展示，不进入作答页面。
            </p>
          </div>
        </header>
      )}

      {exams.length > 0 ? (
        <div className="card toolbar studio-exams-toolbar">
          <div className="search-box">
            <FileText />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索考试名称、课程或状态"
              aria-label="搜索考试"
            />
          </div>
          <select
            className="select"
            value={courseFilter}
            onChange={(event) => setCourseFilter(event.target.value)}
            aria-label="按课程筛选考试"
          >
            <option value="all">全部课程</option>
            {courseFilterNames.map((name) => (
              <option value={name} key={name}>
                {name}
              </option>
            ))}
            {hasUnassigned ? <option value="__unassigned__">未标注课程</option> : null}
          </select>
          <div className="exam-legend">
            <span className="exam-legend-item">
              <span className="exam-dot exam-dot-soon" /> 即将开始
            </span>
            <span className="exam-legend-item">
              <span className="exam-dot exam-dot-live" /> 进行中
            </span>
            <span className="exam-legend-item">
              <span className="exam-dot exam-dot-past" /> 已结束
            </span>
          </div>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div className="card exam-empty">
          <CalendarClock size={26} />
          <h2>{exams.length === 0 ? '学习通当前没有返回考试安排' : '没有匹配的考试'}</h2>
          <p>
            {exams.length === 0
              ? authenticated
                ? '当前学期尚未同步到考试记录；平台发布考试后会自动展示在这里。'
                : '登录学习通并同步课程后，各科考试时间、考场方式与状态会集中展示在这里。'
              : '换一个关键词，或清空搜索条件。'}
          </p>
          {exams.length === 0 && !authenticated && onConnectChaoxing ? (
            <Button variant="primary" size="sm" onClick={onConnectChaoxing}>
              <LogIn size={13} /> 登录学习通
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="exam-grid">
          {visible.map((exam) => {
            const bucket = examBucket(exam, now)
            return (
              <article className="card exam-card" key={exam.id}>
                <div className="exam-card-head">
                  <span className={`exam-status ${statusTone(exam, bucket)}`}>
                    {BUCKET_LABEL[bucket]}
                  </span>
                  {exam.examStatus ? <span className="exam-chip">{exam.examStatus}</span> : null}
                  {exam.answerStatus ? (
                    <span className="exam-chip">{exam.answerStatus}</span>
                  ) : null}
                </div>
                <h2 className="exam-title">{exam.title}</h2>
                <p className="exam-course">
                  {(() => {
                    const course = findUniqueCourseByName(courses, exam.courseName)
                    return course ? (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => onOpenCourse(course)}
                      >
                        {exam.courseName}
                      </button>
                    ) : (
                      (exam.courseName ?? '课程未标注')
                    )
                  })()}
                </p>
                <dl className="exam-meta">
                  <div>
                    <dt>考试时间</dt>
                    <dd>
                      {formatOptionalDateTime(exam.startAt)} — {formatOptionalDateTime(exam.endAt)}
                    </dd>
                  </div>
                  <div>
                    <dt>
                      <Timer size={13} /> 时长
                    </dt>
                    <dd>{exam.durationMinutes ? `${exam.durationMinutes} 分钟` : '—'}</dd>
                  </div>
                  <div>
                    <dt>分数</dt>
                    <dd>{normalizeExamScore(exam.score) ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>方式</dt>
                    <dd>{exam.mode ?? '—'}</dd>
                  </div>
                </dl>
                <div className="exam-card-foot">
                  <span className="exam-updated">更新于 {formatDateTime(exam.updatedAt)}</span>
                  {(() => {
                    const course = findUniqueCourseByName(courses, exam.courseName)
                    return course ? (
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => onOpenCourse(course)}
                      >
                        进入课程
                      </button>
                    ) : null
                  })()}
                  {exam.sourceUrl ? (
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() =>
                        void window.studynext.app.openExternal(exam.sourceUrl as string)
                      }
                    >
                      <ExternalLink size={14} /> 打开官方页面
                    </button>
                  ) : null}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
