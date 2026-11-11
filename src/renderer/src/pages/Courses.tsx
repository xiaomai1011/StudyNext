import { useMemo, useState } from 'react'
import { BookOpen, ExternalLink, MapPin, Search, Star, UserRound } from 'lucide-react'
import type { Course } from '@shared/types'
import { courseInitial } from '../lib/format'
import { CourseDetail } from '../components/CourseDetail'

const WEEKDAY_LABELS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

interface CoursesProps {
  courses: Course[]
  onToggleFavorite: (course: Course) => Promise<void>
  onOpenOfficial: () => void
}

export function Courses({ courses, onToggleFavorite, onOpenOfficial }: CoursesProps) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('全部')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const categories = useMemo(
    () => [
      '全部',
      ...Array.from(new Set(courses.map((course) => course.category).filter(Boolean)))
    ],
    [courses]
  )
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return courses.filter((course) => {
      if (favoritesOnly && !course.favorite) return false
      if (category !== '全部' && course.category !== category) return false
      if (!normalized) return true
      return `${course.name} ${course.code} ${course.teacher}`
        .toLocaleLowerCase()
        .includes(normalized)
    })
  }, [courses, query, category, favoritesOnly])

  const selected = selectedId ? (courses.find((course) => course.id === selectedId) ?? null) : null

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header-copy">
          <div className="eyebrow">
            <BookOpen size={12} /> 课程中心
          </div>
          <h1 className="page-title">我的课程</h1>
          <p className="page-subtitle">
            统一浏览课程信息、收藏常用课程，或前往学习通官方页面继续学习。
          </p>
        </div>
        <div className="header-actions">
          <button type="button" className="btn primary" onClick={onOpenOfficial}>
            <ExternalLink size={15} /> 打开官方课程页
          </button>
        </div>
      </header>

      <div className="card course-toolbar" style={{ padding: 12 }}>
        <div className="search-box">
          <Search />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索课程名称、课程号或教师"
            aria-label="搜索课程"
          />
        </div>
        <div className="category-chips">
          {categories.map((item) => (
            <button
              key={item}
              type="button"
              className={category === item ? 'chip active' : 'chip'}
              onClick={() => setCategory(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={favoritesOnly ? 'chip active' : 'chip'}
          onClick={() => setFavoritesOnly((value) => !value)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
        >
          <Star size={12} fill={favoritesOnly ? 'currentColor' : 'none'} /> 仅看收藏
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          margin: '0 2px 12px'
        }}
      >
        <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>
          共 {filtered.length} 门课程
          {courses.length > 0
            ? ` · 收藏 ${courses.filter((course) => course.favorite).length} 门`
            : ''}
        </span>
        <span style={{ color: 'var(--text-faint)', fontSize: 10.5 }}>演示课程数据保存在本机</span>
      </div>

      {filtered.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-icon">
              <BookOpen />
            </div>
            <div className="empty-title">没有匹配的课程</div>
            <div className="empty-text">调整搜索词或分类筛选；也可以从设置页恢复演示数据。</div>
          </div>
        </div>
      ) : (
        <div className="course-grid">
          {filtered.map((course) => (
            <article
              key={course.id}
              className="course-card"
              style={{ ['--course-color' as string]: course.color }}
              onClick={() => setSelectedId(course.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') setSelectedId(course.id)
              }}
            >
              <div className="course-card-top">
                <div
                  className="course-avatar"
                  style={{ ['--course-color' as string]: course.color }}
                >
                  {courseInitial(course.name)}
                </div>
                <div style={{ minWidth: 0 }}>
                  <h2 className="course-name">{course.name}</h2>
                  <div className="course-code">{course.code}</div>
                </div>
                <button
                  type="button"
                  className={course.favorite ? 'favorite-btn active' : 'favorite-btn'}
                  aria-label={course.favorite ? '取消收藏' : '收藏课程'}
                  onClick={(event) => {
                    event.stopPropagation()
                    void onToggleFavorite(course)
                  }}
                >
                  <Star fill={course.favorite ? 'currentColor' : 'none'} />
                </button>
              </div>

              <div className="course-meta">
                <span className="course-tag">{course.category}</span>
                <span className="course-tag">{course.semester}</span>
                <span
                  className="course-tag"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <UserRound size={10} /> {course.teacher}
                </span>
              </div>

              <div className="course-schedule">
                {course.schedule.length === 0 ? (
                  <div style={{ color: 'var(--text-faint)', fontSize: 10.5 }}>暂无固定课表</div>
                ) : (
                  course.schedule.slice(0, 2).map((session) => (
                    <div className="course-schedule-row" key={session.id}>
                      <MapPin />
                      <span>
                        {WEEKDAY_LABELS[session.weekday]} {session.startTime}–{session.endTime} ·{' '}
                        {session.location}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {selected ? (
        <CourseDetail
          course={selected}
          onClose={() => setSelectedId(null)}
          onToggleFavorite={() => void onToggleFavorite(selected)}
          onOpenOfficial={() => {
            setSelectedId(null)
            onOpenOfficial()
          }}
        />
      ) : null}
    </div>
  )
}
