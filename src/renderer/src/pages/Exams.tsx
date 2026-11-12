import { useMemo, useState, type JSX } from 'react'
import { CalendarClock, ExternalLink, FileText, Timer } from 'lucide-react'
import type { Exam } from '@shared/types'
import { formatDateTime, formatOptionalDateTime } from '../lib/format'

interface ExamsProps {
  exams: Exam[]
}

type ExamBucket = 'upcoming' | 'ongoing' | 'past' | 'unknown'

const BUCKET_LABEL: Record<ExamBucket, string> = {
  upcoming: '即将开始',
  ongoing: '进行中',
  past: '已结束',
  unknown: '时间待确认'
}

function examBucket(exam: Exam, now: number): ExamBucket {
  const start = exam.startAt ? Date.parse(exam.startAt) : Number.NaN
  const end = exam.endAt ? Date.parse(exam.endAt) : Number.NaN
  if (!Number.isFinite(start)) return 'unknown'
  if (Number.isFinite(end) && end < now) return 'past'
  if (start <= now && (!Number.isFinite(end) || end >= now)) return 'ongoing'
  return 'upcoming'
}

function statusTone(exam: Exam, bucket: ExamBucket): string {
  if (bucket === 'ongoing') return 'exam-tone-live'
  if (bucket === 'upcoming') return 'exam-tone-soon'
  if (bucket === 'past') return 'exam-tone-past'
  if (/已完成|已批阅|已通过/.test(exam.answerStatus)) return 'exam-tone-done'
  return 'exam-tone-unknown'
}

export function Exams({ exams }: ExamsProps): JSX.Element {
  const [query, setQuery] = useState('')
  const now = Date.now()

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return exams.filter((exam) => {
      if (!keyword) return true
      return (
        exam.title.toLowerCase().includes(keyword) ||
        (exam.courseName ?? '').toLowerCase().includes(keyword)
      )
    })
  }, [exams, query])

  const counts = useMemo(() => {
    const next = { upcoming: 0, ongoing: 0, past: 0, unknown: 0 }
    for (const exam of exams) next[examBucket(exam, now)] += 1
    return next
  }, [exams, now])

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header-copy">
          <div className="eyebrow">
            <FileText size={12} /> 考试中心
          </div>
          <h1 className="page-title">考试安排</h1>
          <p className="page-subtitle">
            共 {exams.length} 场考试 · 即将开始 {counts.upcoming} · 已结束 {counts.past}。考试与作业任务分开管理，这里只读展示，不进入作答页面。
          </p>
        </div>
      </header>

      <div className="card toolbar">
        <div className="search-box">
          <FileText />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索考试名称或课程"
            aria-label="搜索考试"
          />
        </div>
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

      {visible.length === 0 ? (
        <div className="card exam-empty">
          <CalendarClock size={28} />
          <h2>{exams.length === 0 ? '学习通当前没有返回考试安排' : '没有匹配的考试'}</h2>
          <p>
            {exams.length === 0
              ? '已登录学习通时，这里会显示平台返回的考试列表；平台为空或当前学期没有考试时为正常空态。'
              : '换一个关键词，或清空搜索条件。'}
          </p>
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
                  {exam.answerStatus ? <span className="exam-chip">{exam.answerStatus}</span> : null}
                </div>
                <h2 className="exam-title">{exam.title}</h2>
                <p className="exam-course">{exam.courseName ?? '课程未标注'}</p>
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
                    <dd>{exam.score ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>方式</dt>
                    <dd>{exam.mode ?? '—'}</dd>
                  </div>
                </dl>
                <div className="exam-card-foot">
                  <span className="exam-updated">
                    更新于 {formatDateTime(exam.updatedAt)}
                  </span>
                  {exam.sourceUrl ? (
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => void window.studynext.app.openExternal(exam.sourceUrl as string)}
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
