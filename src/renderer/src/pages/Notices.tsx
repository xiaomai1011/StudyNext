import { useEffect, useMemo, useState } from 'react'
import { BellRing, ExternalLink, Search } from 'lucide-react'
import type { AppNotice, Course } from '@shared/types'
import { findUniqueCourseByName } from '@shared/course-context'

interface NoticesProps {
  notices: AppNotice[]
  courses: Course[]
  focusCourseName?: string | null
  onFocusHandled?: () => void
  onOpenCourse: (course: Course) => void
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

export function Notices({
  notices: allNotices,
  courses,
  focusCourseName,
  onFocusHandled,
  onOpenCourse
}: NoticesProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'unread'>('all')

  useEffect(() => {
    if (!focusCourseName) return
    setQuery(focusCourseName)
    setFilter('all')
    onFocusHandled?.()
  }, [focusCourseName, onFocusHandled])

  const notices = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return allNotices.filter((notice) => {
      if (filter === 'unread' && notice.read !== false) return false
      if (!needle) return true
      return `${notice.title} ${notice.body} ${notice.courseName ?? ''} ${notice.sender ?? ''}`
        .toLowerCase()
        .includes(needle)
    })
  }, [allNotices, filter, query])

  const unread = allNotices.filter((notice) => notice.read === false).length

  return (
    <section className="page notices-page">
      <header className="page-header ds-page-header">
        <div className="page-header-copy ds-page-header-copy">
          <div className="eyebrow ds-eyebrow">
            <BellRing size={12} /> 学习通消息
          </div>
          <h1 className="page-title ds-page-title">通知中心</h1>
          <p className="page-subtitle ds-page-subtitle">
            按时间和课程查看通知，打开原始消息继续处理。
          </p>
        </div>
        <div className="notices-summary">
          <span>
            共 <strong>{allNotices.length}</strong> 条
          </span>
          <span>
            未读 <strong>{unread}</strong>
          </span>
        </div>
      </header>

      <div className="notices-toolbar">
        <label className="search-box">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、课程或发送人"
            aria-label="搜索通知"
          />
        </label>
        <div className="segmented">
          <button
            type="button"
            className={filter === 'all' ? 'active' : ''}
            onClick={() => setFilter('all')}
          >
            全部 {allNotices.length}
          </button>
          <button
            type="button"
            className={filter === 'unread' ? 'active' : ''}
            onClick={() => setFilter('unread')}
          >
            未读 {unread}
          </button>
        </div>
      </div>

      <div className="notices-list panel">
        {notices.length === 0 ? (
          <div className="empty-state">
            <BellRing size={22} />
            <strong>{allNotices.length === 0 ? '尚未同步通知' : '没有符合条件的通知'}</strong>
            <span>
              {allNotices.length === 0
                ? '在设置页点击“仅同步学习通”获取通知。'
                : '尝试清除搜索或切换筛选。'}
            </span>
          </div>
        ) : (
          notices.map((notice) => {
            const course = findUniqueCourseByName(courses, notice.courseName)
            return (
              <article
                className={notice.read === false ? 'notice-row unread' : 'notice-row'}
                key={notice.id}
              >
                <span className="notice-marker" aria-hidden="true" />
                <div className="notice-main">
                  <div className="notice-title">
                    <strong>{notice.title}</strong>
                    {notice.read === false ? <span className="badge info">未读</span> : null}
                  </div>
                  <p className="notice-body">{notice.body}</p>
                  <div className="notice-meta">
                    <span>{notice.courseName || '课程通知'}</span>
                    <span>{notice.sender || '学习通'}</span>
                    <span>{formatTime(notice.publishedAt)}</span>
                  </div>
                </div>
                {course ? (
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => onOpenCourse(course)}
                  >
                    进入课程
                  </button>
                ) : null}
                {notice.url ? (
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => void window.studynext.app.openExternal(notice.url!)}
                  >
                    打开 <ExternalLink size={13} />
                  </button>
                ) : null}
              </article>
            )
          })
        )}
      </div>
    </section>
  )
}
