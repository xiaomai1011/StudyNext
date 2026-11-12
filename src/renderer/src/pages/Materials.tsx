import { useMemo, useState } from 'react'
import { ExternalLink, FileText, Folder, Link2, Search } from 'lucide-react'
import type { Course, Material } from '@shared/types'

interface MaterialsProps {
  courses: Course[]
  materials: Material[]
  onDownload: (material: Material) => void
}

export function Materials({ courses, materials, onDownload }: MaterialsProps) {
  const [query, setQuery] = useState('')
  const [courseFilter, setCourseFilter] = useState('all')

  const courseNames = useMemo(
    () => new Map(courses.map((course) => [course.id, course.name])),
    [courses]
  )
  const courseById = useMemo(() => new Map(courses.map((course) => [course.id, course])), [courses])
  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const course of courses) counts.set(course.name, (counts.get(course.name) ?? 0) + 1)
    return counts
  }, [courses])
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const byCourse = new Map<string, Material[]>()
    for (const item of materials) {
      if (courseFilter !== 'all' && item.courseId !== courseFilter) continue
      if (needle && !item.name.toLowerCase().includes(needle)) continue
      const list = byCourse.get(item.courseId) ?? []
      list.push(item)
      byCourse.set(item.courseId, list)
    }
    return [...byCourse.entries()]
      .map(([courseId, items]) => {
        const course = courseById.get(courseId)
        const duplicated = course ? (nameCounts.get(course.name) ?? 0) > 1 : false
        const classLabel =
          duplicated && course?.clazzId
            ? ` · 教学班 ${course.className || course.clazzId}`
            : ''
        return {
          courseId,
          courseName: `${courseNames.get(courseId) ?? '未知课程'}${classLabel}`,
          items
        }
      })
      .sort((a, b) => a.courseName.localeCompare(b.courseName, 'zh-CN'))
  }, [courseById, courseNames, courseFilter, materials, nameCounts, query])

  const total = groups.reduce((sum, group) => sum + group.items.length, 0)
  const fileCount = materials.filter((item) => item.kind !== 'folder').length

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">MATERIALS</p>
          <h1>资料中心</h1>
          <p className="page-subtitle">
            通过本人学习通 Web Session 只读同步，共 {materials.length} 项（{fileCount} 个文件/链接）。
            应用不自动下载文件，点击条目在官方页面打开。
          </p>
        </div>
      </header>

      <div className="material-toolbar">
        <label className="search-box">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索资料名称"
          />
        </label>
        <select
          className="select"
          value={courseFilter}
          onChange={(event) => setCourseFilter(event.target.value)}
        >
          <option value="all">全部课程</option>
          {courses.map((course) => (
            <option key={course.id} value={course.id}>
              {course.name}
            </option>
          ))}
        </select>
        <span className="material-count">{total} 项</span>
      </div>

      {groups.length === 0 ? (
        <div className="empty-state">
          <Folder size={28} />
          <h3>尚未同步学习通资料</h3>
          <p>在设置页执行“仅同步学习通”后，这里会显示课程资料列表。</p>
        </div>
      ) : (
        <div className="material-groups">
          {groups.map((group) => (
            <section className="card material-group" key={group.courseId}>
              <header className="material-group-head">
                <h2>{group.courseName}</h2>
                <span>{group.items.length} 项</span>
              </header>
              <ul className="material-list">
                {group.items.map((item) => {
                  const target = item.url ?? item.sourceUrl
                  const Icon = item.kind === 'folder' ? Folder : item.kind === 'link' ? Link2 : FileText
                  return (
                    <li key={item.id} className="material-item">
                      <button
                        type="button"
                        className="material-row"
                        onClick={() => {
                          if (target) window.studynext.app.openExternal(target)
                        }}
                        disabled={!target}
                        title={target ?? '该条目没有可打开的外部地址'}
                      >
                        <Icon size={16} />
                        <span className="material-name">{item.name}</span>
                        <span className="material-type">
                          {item.kind === 'folder' ? '文件夹' : (item.fileType ?? '文件')}
                        </span>
                        {item.size ? <span className="material-size">{item.size}</span> : null}
                        {target ? <ExternalLink size={14} /> : null}
                      </button>
                      {item.kind !== 'folder' && target ? (
                        <button
                          type="button"
                          className="material-download"
                          onClick={() => onDownload(item)}
                          title="下载到本机"
                          aria-label={`下载 ${item.name}`}
                        >
                          下载
                        </button>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
