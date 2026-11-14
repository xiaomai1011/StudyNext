import { useMemo, useState, type JSX } from 'react'
import { ExternalLink, FileText, Search } from 'lucide-react'
import type { Course, Task } from '@shared/types'
import { formatDueAt, formatOptionalDateTime } from '../lib/format'

interface RecordsProps {
  tasks: Task[]
  courses: Course[]
  onOpenTask: (task: Task) => void
  onOpenInPortal: (task: Task) => void
}

const PLATFORM_STATUS_LABEL: Record<string, string> = {
  not_submitted: '未提交',
  submitted: '已提交',
  pending_review: '待批阅',
  reviewed: '已批阅',
  done: '已完成',
  unknown: '未知'
}

export function Records({ tasks, courses, onOpenTask, onOpenInPortal }: RecordsProps): JSX.Element {
  const [keyword, setKeyword] = useState('')
  const courseById = useMemo(() => new Map(courses.map((course) => [course.id, course])), [courses])

  const rows = useMemo(() => {
    const normalized = keyword.trim().toLowerCase()
    return tasks
      .filter((task) => task.source === 'chaoxing' && task.kind === 'homework')
      .filter((task) => {
        if (!normalized) return true
        const course = task.courseId ? courseById.get(task.courseId) : null
        return (
          task.title.toLowerCase().includes(normalized) ||
          (course?.name ?? '').toLowerCase().includes(normalized)
        )
      })
      .sort((a, b) => (b.submittedAt ?? b.updatedAt).localeCompare(a.submittedAt ?? a.updatedAt))
  }, [tasks, keyword, courseById])

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>作业记录</h1>
          <p className="page-subtitle">
            展示学习通实际返回的提交、成绩与批语数据；缺失字段保持“未知”，不推断。
          </p>
        </div>
      </header>

      <div className="card records-toolbar">
        <label className="search-box">
          <Search size={14} />
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索作业或课程"
          />
        </label>
        <span className="records-count">共 {rows.length} 条</span>
      </div>

      {rows.length === 0 ? (
        <div className="card empty-state">
          <FileText size={20} />
          <p>暂无学习通作业记录，请先在设置页执行同步。</p>
        </div>
      ) : (
        <div className="card records-card">
          <table className="records-table">
            <thead>
              <tr>
                <th>作业名称</th>
                <th>课程 / 教学班</th>
                <th>截止时间</th>
                <th>提交时间</th>
                <th>平台状态</th>
                <th>成绩</th>
                <th>教师批语</th>
                <th>附件</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((task) => {
                const course = task.courseId ? courseById.get(task.courseId) : null
                const sameName = course ? courses.filter((item) => item.name === course.name).length > 1 : false
                const classLabel = course ? course.className || course.clazzId : null
                const statusText =
                  task.platformStatus ?? PLATFORM_STATUS_LABEL[task.platformStatusKind] ?? '未知'
                return (
                  <tr key={task.id}>
                    <td>
                      <button className="link-button" onClick={() => onOpenTask(task)}>
                        {task.title}
                      </button>
                    </td>
                    <td>
                      {course?.name ?? '未知课程'}
                      {sameName && classLabel ? (
                        <span className="records-class">教学班 {classLabel}</span>
                      ) : null}
                    </td>
                    <td>{formatDueAt(task.dueAt) || '未知'}</td>
                    <td>{formatOptionalDateTime(task.submittedAt)}</td>
                    <td>
                      <span className={`records-status status-${task.platformStatusKind}`}>
                        {statusText}
                      </span>
                    </td>
                    <td>
                      {task.score || task.fullScore
                        ? `${task.score ?? '未出分'}${task.fullScore ? ` / ${task.fullScore}` : ''}`
                        : '未知'}
                    </td>
                    <td className="records-feedback">{task.teacherFeedback ?? '—'}</td>
                    <td>
                      {task.attachments.length > 0 ? (
                        <ul className="records-attachments">
                          {task.attachments.map((attachment) => (
                            <li key={`${attachment.objectId ?? attachment.name}-${attachment.name}`}>
                              {attachment.name}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <button
                        className="icon-button"
                        title="打开学习通原页"
                        disabled={!task.sourceUrl}
                        onClick={() => onOpenInPortal(task)}
                      >
                        <ExternalLink size={14} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
