import { useMemo, useState, type JSX } from 'react'
import {
  BookMarked,
  CheckCircle2,
  Circle,
  Clock3,
  ExternalLink,
  FileQuestion,
  FolderOpen,
  Search
} from 'lucide-react'
import type { Chapter, Course, StudyPoint } from '@shared/types'
import { STUDY_POINT_LABEL } from '@shared/constants'
import { errorMessage, formatMinutes } from '../lib/format'
import type { ToastKind } from '../components/ToastStack'

interface StudyProps {
  courses: Course[]
  chapters: Chapter[]
  points: StudyPoint[]
  onTogglePoint: (point: StudyPoint, completed: boolean) => Promise<void>
  onImport: () => void
  notify: (kind: ToastKind, message: string) => void
}

export function Study({
  courses,
  chapters,
  points,
  onTogglePoint,
  onImport,
  notify
}: StudyProps): JSX.Element {
  const firstCourse = courses.find((course) =>
    chapters.some((chapter) => chapter.courseId === course.id)
  )
  const [courseId, setCourseId] = useState<string>(firstCourse?.id ?? 'all')
  const [query, setQuery] = useState('')
  const [pendingId, setPendingId] = useState<string | null>(null)

  const pointsByChapter = useMemo(() => {
    const map = new Map<string, StudyPoint[]>()
    for (const point of points) {
      const list = map.get(point.chapterId) ?? []
      list.push(point)
      map.set(point.chapterId, list)
    }
    for (const list of map.values()) list.sort((a, b) => a.sortOrder - b.sortOrder)
    return map
  }, [points])

  const filteredCourses = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return courses
      .filter((course) => courseId === 'all' || course.id === courseId)
      .filter((course) => {
        if (!normalized) return true
        if (course.name.toLowerCase().includes(normalized)) return true
        return chapters
          .filter((chapter) => chapter.courseId === course.id)
          .some(
            (chapter) =>
              chapter.title.toLowerCase().includes(normalized) ||
              (pointsByChapter.get(chapter.id) ?? []).some((point) =>
                point.title.toLowerCase().includes(normalized)
              )
          )
      })
  }, [courses, courseId, query, chapters, pointsByChapter])

  const courseStats = useMemo(() => {
    return courses.map((course) => {
      const courseChapters = chapters.filter((chapter) => chapter.courseId === course.id)
      const coursePoints = points.filter((point) => point.courseId === course.id)
      const done = coursePoints.filter((point) => point.status === 'done').length
      return {
        course,
        chapters: courseChapters.length,
        points: coursePoints.length,
        done,
        progress: coursePoints.length ? Math.round((done / coursePoints.length) * 100) : 0
      }
    })
  }, [courses, chapters, points])

  const activeStats = courseStats.find((item) => item.course.id === courseId) ?? null
  const totalDone = points.filter((point) => point.status === 'done').length
  const totalProgress = points.length ? Math.round((totalDone / points.length) * 100) : 0

  const togglePoint = async (point: StudyPoint): Promise<void> => {
    if (point.source === 'chaoxing') {
      notify('info', '学习通任务点进度以平台为准，应用内不修改')
      return
    }
    if (pendingId) return
    setPendingId(point.id)
    try {
      await onTogglePoint(point, point.status !== 'done')
      notify('success', point.status === 'done' ? '已恢复为未完成' : '学习点已完成')
    } catch (error) {
      notify('error', errorMessage(error))
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className="page study-page">
      <header className="page-header">
        <div>
          <div className="eyebrow">LEARNING CENTER</div>
          <h1 className="page-title">学习中心</h1>
          <p className="page-subtitle">
            章节、视频、测验与作业进度集中管理。学习通章节由本人 Web 会话只读同步，平台进度不可在应用内修改。
          </p>
        </div>
        <div className="header-actions">
          <div className="search-box">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索课程、章节或学习点"
              aria-label="搜索学习内容"
            />
          </div>
          <button type="button" className="btn ghost" onClick={onImport}>
            <FolderOpen size={16} /> 导入快照
          </button>
        </div>
      </header>

      <section className="metric-grid study-metrics">
        <article className="metric-card">
          <div className="metric-label">课程</div>
          <div className="metric-value">{courses.length}</div>
          <div className="metric-note">{chapters.length} 个章节</div>
        </article>
        <article className="metric-card teal">
          <div className="metric-label">学习点</div>
          <div className="metric-value">{points.length}</div>
          <div className="metric-note">{totalDone} 个已完成</div>
        </article>
        <article className="metric-card warning">
          <div className="metric-label">整体进度</div>
          <div className="metric-value">{totalProgress}%</div>
          <div className="progress-wrap">
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${totalProgress}%` }} />
            </div>
          </div>
        </article>
      </section>

      {courses.length === 0 || points.length === 0 ? (
        <div className="empty-state card">
          <div className="empty-icon">
            <BookMarked />
          </div>
          <div className="empty-title">还没有可展示的学习进度</div>
          <div className="empty-text">
            尚未同步学习通章节，当前可导入本地 JSON 学习快照。快照只在本机解析和保存。
          </div>
          <button type="button" className="btn primary" onClick={onImport}>
            <FolderOpen size={16} /> 导入学习快照
          </button>
        </div>
      ) : (
        <div className="study-layout">
          <aside className="study-course-list card">
            <div className="card-header">
              <div>
                <div className="card-title">课程</div>
                <div className="card-subtitle">选择一门课查看章节</div>
              </div>
            </div>
            <button
              type="button"
              className={courseId === 'all' ? 'study-course active' : 'study-course'}
              onClick={() => setCourseId('all')}
            >
              <span className="study-course-mark" style={{ background: 'var(--accent)' }}>
                <BookMarked size={14} />
              </span>
              <span className="study-course-copy">
                <strong>全部课程</strong>
                <small>{points.length} 个学习点</small>
              </span>
            </button>
            {courseStats.map(({ course, done, points: count, progress }) => (
              <button
                key={course.id}
                type="button"
                className={courseId === course.id ? 'study-course active' : 'study-course'}
                onClick={() => setCourseId(course.id)}
              >
                <span className="study-course-mark" style={{ background: course.color }}>
                  {course.name.slice(0, 1)}
                </span>
                <span className="study-course-copy">
                  <strong>{course.name}</strong>
                  <small>
                    {done}/{count} · {progress}%
                  </small>
                </span>
              </button>
            ))}
          </aside>

          <div className="study-board">
            {activeStats && courseId !== 'all' ? (
              <div className="card study-course-hero">
                <div>
                  <div className="eyebrow">COURSE PROGRESS</div>
                  <h2>{activeStats.course.name}</h2>
                  <p>
                    {activeStats.course.teacher || '教师未填写'} · {activeStats.chapters} 个章节 ·{' '}
                    {activeStats.points} 个学习点 · 已完成 {activeStats.done} 个
                  </p>
                  {activeStats.course.sourceUrl ? (
                    <button
                      type="button"
                      className="btn ghost small study-official-link"
                      onClick={() =>
                        void window.studynext.app.openExternal(activeStats.course.sourceUrl as string)
                      }
                    >
                      <ExternalLink size={14} /> 打开学习通章节
                    </button>
                  ) : null}
                </div>
                <div className="study-progress-ring" aria-label={`进度 ${activeStats.progress}%`}>
                  <strong>{activeStats.progress}%</strong>
                  <span>完成</span>
                </div>
              </div>
            ) : null}

            {filteredCourses.length === 0 ? (
              <div className="empty-state card">
                <div className="empty-icon">
                  <Search />
                </div>
                <div className="empty-title">没有匹配的学习内容</div>
                <div className="empty-text">换一个关键词或切换课程再试。</div>
              </div>
            ) : (
              filteredCourses.map((course) => {
                const courseChapters = chapters
                  .filter((chapter) => chapter.courseId === course.id)
                  .sort((a, b) => a.sortOrder - b.sortOrder)
                if (courseChapters.length === 0) return null
                return (
                  <section className="card study-course-section" key={course.id}>
                    <div className="card-header">
                      <div>
                        <div className="card-title">{course.name}</div>
                        <div className="card-subtitle">
                          {course.teacher || '教师未填写'} · {courseChapters.length} 个章节
                        </div>
                      </div>
                      <span className="course-tag">
                        {courseChapters.reduce(
                          (sum, chapter) => sum + (pointsByChapter.get(chapter.id)?.length ?? 0),
                          0
                        )}{' '}
                        个学习点
                      </span>
                    </div>
                    <div className="chapter-list">
                      {courseChapters.map((chapter, index) => {
                        const chapterPoints = pointsByChapter.get(chapter.id) ?? []
                        const done = chapterPoints.filter((point) => point.status === 'done').length
                        const progress = chapterPoints.length
                          ? Math.round((done / chapterPoints.length) * 100)
                          : chapter.progress
                        return (
                          <article className="chapter-card" key={chapter.id}>
                            <div className="chapter-head">
                              <div className="chapter-index">
                                {String(index + 1).padStart(2, '0')}
                              </div>
                              <div className="chapter-copy">
                                <h3>{chapter.title}</h3>
                                <span>
                                  {done}/{chapterPoints.length} 完成
                                  {chapter.progress > 0 && chapterPoints.length === 0
                                    ? ` · 快照进度 ${chapter.progress}%`
                                    : ''}
                                </span>
                              </div>
                              <div className="chapter-progress">
                                <div className="progress-track">
                                  <div
                                    className="progress-fill"
                                    style={{ width: `${progress}%` }}
                                  />
                                </div>
                                <strong>{progress}%</strong>
                              </div>
                            </div>
                            {chapterPoints.length === 0 ? (
                              <div className="chapter-empty">
                                <FileQuestion size={15} /> 该章节暂无学习点，可在快照中补充。
                              </div>
                            ) : (
                              <div className="study-point-list">
                                {chapterPoints.map((point) => {
                                  const donePoint = point.status === 'done'
                                  return (
                                    <button
                                      type="button"
                                      key={point.id}
                                      className={donePoint ? 'study-point done' : 'study-point'}
                                      onClick={() => void togglePoint(point)}
                                      disabled={pendingId === point.id}
                                    >
                                      <span className="study-point-check">
                                        {donePoint ? (
                                          <CheckCircle2 size={19} />
                                        ) : (
                                          <Circle size={19} />
                                        )}
                                      </span>
                                      <span className="study-point-copy">
                                        <strong>{point.title}</strong>
                                        <span>
                                          <span className="priority-badge low">
                                            {STUDY_POINT_LABEL[point.kind]}
                                          </span>
                                          {point.source === 'chaoxing' ? (
                                            <span className="priority-badge medium">平台</span>
                                          ) : null}
                                          {point.durationMinutes ? (
                                            <span className="study-point-duration">
                                              <Clock3 size={13} />{' '}
                                              {formatMinutes(point.durationMinutes)}
                                            </span>
                                          ) : null}
                                        </span>
                                      </span>
                                    </button>
                                  )
                                })}
                              </div>
                            )}
                          </article>
                        )
                      })}
                    </div>
                  </section>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
