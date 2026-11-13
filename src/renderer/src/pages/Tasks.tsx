import { useMemo, useState, type JSX } from 'react'
import {
  Bell,
  CalendarDays,
  CheckCircle2,
  ListChecks,
  Pencil,
  Plus,
  Search,
  Trash2
} from 'lucide-react'
import type { Course, Task, TaskPriority, TaskStatus } from '@shared/types'
import { dueBucket, filterTasks, sortTasksByDue } from '@shared/domain'
import { TASK_KIND_LABEL } from '@shared/constants'
import { BUCKET_LABEL, formatDueAt, priorityLabel } from '../lib/format'

type SortMode = 'due' | 'created' | 'priority'

interface TasksProps {
  tasks: Task[]
  courses: Course[]
  onCreate: () => void
  onOpen: (task: Task) => void
  onEdit: (task: Task) => void
  onToggle: (task: Task) => void
  onDelete: (task: Task) => void
}

const PRIORITY_WEIGHT: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 }
const BUCKET_ORDER = ['today', 'soon', 'upcoming', 'overdue', 'done'] as const

export function Tasks({
  tasks,
  courses,
  onCreate,
  onOpen,
  onEdit,
  onToggle,
  onDelete
}: TasksProps) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<TaskStatus | 'all'>('all')
  const [courseId, setCourseId] = useState('all')
  const [priority, setPriority] = useState<TaskPriority | 'all'>('all')
  const [sortMode, setSortMode] = useState<SortMode>('due')

  const courseById = useMemo(() => new Map(courses.map((course) => [course.id, course])), [courses])
  // 逾期任务继续显示在任务列表；仪表盘与侧栏仍不把它计入“今日/待办”噪音。
  const visibleTasks = tasks
  const counts = useMemo(
    () => ({
      all: visibleTasks.length,
      todo: visibleTasks.filter((task) => task.status === 'todo').length,
      done: visibleTasks.filter((task) => task.status === 'done').length
    }),
    [visibleTasks]
  )
  const overdueCount = useMemo(
    () => tasks.filter((task) => task.status === 'todo' && dueBucket(task, new Date()) === 'overdue').length,
    [tasks]
  )

  const filtered = useMemo(() => {
    const scoped = filterTasks(visibleTasks, {
      query,
      status,
      priority,
      ...(courseId !== 'all' ? { courseId } : {})
    })
    if (sortMode === 'created') {
      return [...scoped].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
    }
    if (sortMode === 'priority') {
      return [...scoped].sort((a, b) => {
        const diff = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority]
        return diff !== 0 ? diff : new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()
      })
    }
    return sortTasksByDue(scoped)
  }, [visibleTasks, query, status, priority, courseId, sortMode])

  const groups = useMemo(() => {
    if (sortMode !== 'due') return null
    const now = new Date()
    return BUCKET_ORDER.map((bucket) => ({
      bucket,
      items: filtered.filter((task) => dueBucket(task, now) === bucket)
    })).filter((group) => group.items.length > 0)
  }, [filtered, sortMode])

  const renderRow = (task: Task): JSX.Element => {
    const course = task.courseId ? courseById.get(task.courseId) : null
    const bucket = dueBucket(task)
    const dueLabel = formatDueAt(task.dueAt)
    return (
      <div className={task.status === 'done' ? 'task-row done' : 'task-row'} key={task.id}>
        <button
          type="button"
          className={task.status === 'done' ? 'task-check checked' : 'task-check'}
          aria-label={task.status === 'done' ? '标记为待完成' : '标记为完成'}
          onClick={() => onToggle(task)}
        >
          <CheckCircle2 />
        </button>
        <button type="button" className="task-row-main" onClick={() => onOpen(task)}>
          <div className="task-row-title">{task.title}</div>
          <div className="task-row-meta">
            <span className={`priority-badge ${task.priority}`}>
              {priorityLabel(task.priority)}
            </span>
            {course ? (
              <span className="course-chip" style={{ ['--chip-color' as string]: course.color }}>
                {course.name}
              </span>
            ) : (
              <span>未关联课程</span>
            )}
            <span className="dot-separator" />
            <span>{TASK_KIND_LABEL[task.kind]}</span>
            {dueLabel ? (
              <>
                <span className="dot-separator" />
                <span>{dueLabel}</span>
              </>
            ) : null}
            {task.reminders.filter((rule) => rule.enabled).length > 0 ? (
              <span className="reminder-count">
                <Bell /> {task.reminders.filter((rule) => rule.enabled).length}
              </span>
            ) : null}
          </div>
        </button>
        <span
          className={`due-pill ${bucket === 'overdue' ? 'overdue' : bucket === 'today' ? 'today' : ''}`}
        >
          {task.status === 'done' ? '已完成' : BUCKET_LABEL[bucket]}
        </span>
        <div className="task-row-actions">
          <button
            type="button"
            className="task-row-action"
            onClick={() => onEdit(task)}
            aria-label="编辑任务"
          >
            <Pencil />
          </button>
          <button
            type="button"
            className="task-row-action danger"
            onClick={() => onDelete(task)}
            aria-label="删除任务"
          >
            <Trash2 />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header-copy">
          <div className="eyebrow">
            <ListChecks size={12} /> 任务中心
          </div>
          <h1 className="page-title">任务与 DDL</h1>
          <p className="page-subtitle">
            同步 {tasks.length} 项 · 显示 {visibleTasks.length} 项 · 其中逾期 {overdueCount} 项。修改截止时间后会自动重排提醒。
          </p>
        </div>
        <div className="header-actions">
          <button type="button" className="btn primary" onClick={onCreate}>
            <Plus size={15} /> 新建任务
          </button>
        </div>
      </header>

      <div className="card toolbar">
        <div className="search-box">
          <Search />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索任务标题或备注"
            aria-label="搜索任务"
          />
        </div>
        <div className="segmented">
          <button
            type="button"
            className={status === 'all' ? 'active' : ''}
            onClick={() => setStatus('all')}
          >
            全部 {counts.all}
          </button>
          <button
            type="button"
            className={status === 'todo' ? 'active' : ''}
            onClick={() => setStatus('todo')}
          >
            待完成 {counts.todo}
          </button>
          <button
            type="button"
            className={status === 'done' ? 'active' : ''}
            onClick={() => setStatus('done')}
          >
            已完成 {counts.done}
          </button>
        </div>
        <select
          className="select"
          value={courseId}
          onChange={(event) => setCourseId(event.target.value)}
          aria-label="按课程筛选"
        >
          <option value="all">全部课程</option>
          {courses.map((course) => (
            <option key={course.id} value={course.id}>
              {course.name}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={priority}
          onChange={(event) => setPriority(event.target.value as TaskPriority | 'all')}
          aria-label="按优先级筛选"
        >
          <option value="all">全部优先级</option>
          <option value="high">高优先级</option>
          <option value="medium">普通</option>
          <option value="low">低优先级</option>
        </select>
        <select
          className="select"
          value={sortMode}
          onChange={(event) => setSortMode(event.target.value as SortMode)}
          aria-label="排序方式"
        >
          <option value="due">按 DDL 排序</option>
          <option value="priority">按优先级排序</option>
          <option value="created">按创建时间排序</option>
        </select>
      </div>

      <div className="card task-page-list">
        {filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <CalendarDays />
            </div>
            <div className="empty-title">没有符合条件的任务</div>
            <div className="empty-text">试试清除搜索或筛选条件，也可以新建一个任务来开始。</div>
          </div>
        ) : groups ? (
          groups.map((group) => (
            <div key={group.bucket}>
              <div className="group-title">
                {BUCKET_LABEL[group.bucket]} · {group.items.length}
              </div>
              {group.items.map(renderRow)}
            </div>
          ))
        ) : (
          filtered.map(renderRow)
        )}
      </div>
    </div>
  )
}
