import { useMemo, useState, type FormEvent } from 'react'
import { BellPlus, Plus } from 'lucide-react'
import type {
  Course,
  Task,
  TaskKind,
  TaskPriority,
  TaskStatus,
  TaskUpsertInput
} from '@shared/types'
import {
  REMINDER_MAX_MINUTES,
  REMINDER_MIN_MINUTES,
  REMINDER_PRESETS,
  TASK_KIND_LABEL
} from '@shared/constants'
import { normalizeReminderOffsets, toDateTimeLocalValue } from '@shared/domain'
import { Modal } from './Modal'
import { ConfirmDialog } from './ConfirmDialog'
import { errorMessage, reminderOffsetLabel } from '../lib/format'

interface TaskEditorProps {
  task: Task | null
  defaultCourseId?: string | null
  courses: Course[]
  defaultReminderOffsets: number[]
  onClose: () => void
  onSubmit: (input: TaskUpsertInput) => Promise<void>
}

function defaultDueValue(): string {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  date.setHours(22, 0, 0, 0)
  return toDateTimeLocalValue(date.toISOString())
}

export function TaskEditor({
  task,
  defaultCourseId = null,
  courses,
  defaultReminderOffsets,
  onClose,
  onSubmit
}: TaskEditorProps) {
  const [title, setTitle] = useState(task?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  const [courseId, setCourseId] = useState(task?.courseId ?? defaultCourseId ?? '')
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'medium')
  const [kind, setKind] = useState<TaskKind>(task?.kind ?? 'homework')
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'todo')
  const [dueLocal, setDueLocal] = useState(
    task ? toDateTimeLocalValue(task.dueAt) : defaultDueValue()
  )
  const [offsets, setOffsets] = useState<number[]>(() =>
    normalizeReminderOffsets(
      task
        ? task.reminders.filter((rule) => rule.enabled).map((rule) => rule.offsetMinutes)
        : defaultReminderOffsets
    )
  )
  const [customMinutes, setCustomMinutes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [initialSnapshot] = useState(() =>
    JSON.stringify({ title, description, courseId, priority, kind, status, dueLocal, offsets })
  )
  const currentSnapshot = JSON.stringify({
    title,
    description,
    courseId,
    priority,
    kind,
    status,
    dueLocal,
    offsets
  })
  const dirty = currentSnapshot !== initialSnapshot

  const allOffsets = useMemo(() => {
    const presets = REMINDER_PRESETS.map((preset) => preset.minutes)
    return [...new Set([...presets, ...offsets])].sort((a, b) => b - a)
  }, [offsets])

  const toggleOffset = (minutes: number): void => {
    setOffsets((current) =>
      current.includes(minutes)
        ? current.filter((value) => value !== minutes)
        : [...current, minutes]
    )
  }

  const addCustomOffset = (): void => {
    const value = Number.parseInt(customMinutes, 10)
    if (!Number.isFinite(value) || value < REMINDER_MIN_MINUTES || value > REMINDER_MAX_MINUTES) {
      setError(`自定义提醒需为 ${REMINDER_MIN_MINUTES}–${REMINDER_MAX_MINUTES} 分钟之间的整数`)
      return
    }
    setOffsets((current) => normalizeReminderOffsets([...current, value]))
    setCustomMinutes('')
    setError(null)
  }

  const requestClose = (): void => {
    if (busy) return
    if (dirty) {
      setConfirmDiscard(true)
      return
    }
    onClose()
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) {
      setError('请填写任务标题')
      return
    }
    const dueDate = new Date(dueLocal)
    if (!dueLocal || !Number.isFinite(dueDate.getTime())) {
      setError('请选择有效的截止时间')
      return
    }
    const input: TaskUpsertInput = {
      title: trimmed,
      description: description.trim(),
      courseId: courseId || null,
      priority,
      kind,
      dueAt: dueDate.toISOString(),
      reminderOffsets: normalizeReminderOffsets(offsets),
      status
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit(input)
    } catch (submitError) {
      setError(errorMessage(submitError))
      setBusy(false)
    }
  }

  return (
    <>
      <Modal
        title={task ? '编辑任务' : '新建任务'}
        subtitle="任务保存在本机 SQLite 数据库，不会上传到任何服务器。"
        wide
        onClose={requestClose}
        footer={
          <>
            <span className="spacer" />
            <button type="button" className="btn" onClick={requestClose} disabled={busy}>
              取消
            </button>
            <button type="submit" form="task-editor-form" className="btn primary" disabled={busy}>
              {busy ? '保存中…' : task ? '保存修改' : '创建任务'}
            </button>
          </>
        }
      >
        <form id="task-editor-form" onSubmit={(event) => void handleSubmit(event)}>
          {error ? (
            <div className="import-result failure" style={{ margin: '0 0 14px' }}>
              {error}
            </div>
          ) : null}
          <div className="form-grid">
            <label className="field full">
              <span className="field-label">任务标题</span>
              <input
                className="input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="例如：完成第 3 章在线作业"
                maxLength={200}
                autoFocus
              />
            </label>

            <label className="field">
              <span className="field-label">所属课程</span>
              <select
                className="input"
                value={courseId}
                onChange={(event) => setCourseId(event.target.value)}
              >
                <option value="">不关联课程</option>
                {courses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field-label">截止时间</span>
              <input
                className="input"
                type="datetime-local"
                value={dueLocal}
                onChange={(event) => setDueLocal(event.target.value)}
              />
              <span className="field-hint">按本机时区保存，修改时间会重新计算提醒。</span>
            </label>

            <label className="field">
              <span className="field-label">优先级</span>
              <select
                className="input"
                value={priority}
                onChange={(event) => setPriority(event.target.value as TaskPriority)}
              >
                <option value="high">高优先级</option>
                <option value="medium">普通</option>
                <option value="low">低优先级</option>
              </select>
            </label>

            <label className="field">
              <span className="field-label">任务类型</span>
              <select
                className="input"
                value={kind}
                onChange={(event) => setKind(event.target.value as TaskKind)}
              >
                {(Object.entries(TASK_KIND_LABEL) as Array<[TaskKind, string]>).map(
                  ([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  )
                )}
              </select>
            </label>

            {task ? (
              task.source === 'chaoxing' ? (
                <div className="field">
                  <span className="field-label">完成状态</span>
                  <div className="field-hint" style={{ marginTop: 8, lineHeight: 1.6 }}>
                    由学习通平台同步，本地不能修改完成状态。
                  </div>
                </div>
              ) : (
                <label className="field">
                  <span className="field-label">完成状态</span>
                  <select
                    className="input"
                    value={status}
                    onChange={(event) => setStatus(event.target.value as TaskStatus)}
                  >
                    <option value="todo">待完成</option>
                    <option value="done">已完成</option>
                  </select>
                </label>
              )
            ) : null}

            <label className="field full">
              <span className="field-label">备注说明</span>
              <textarea
                className="textarea"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="可选：记录提交要求、章节范围或复习重点"
                maxLength={2000}
              />
            </label>

            <div className="field full">
              <span
                className="field-label"
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <BellPlus size={13} /> 截止提醒
              </span>
              <span className="field-hint" style={{ marginTop: -2 }}>
                仅在本应用进程运行时触发系统通知；应用完全退出后不会定时。未勾选则表示不提醒。
              </span>
              <div className="reminder-options" style={{ marginTop: 4 }}>
                {allOffsets.map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    className={
                      offsets.includes(minutes) ? 'reminder-option active' : 'reminder-option'
                    }
                    aria-pressed={offsets.includes(minutes)}
                    onClick={() => toggleOffset(minutes)}
                  >
                    {reminderOffsetLabel(minutes)}
                  </button>
                ))}
                {offsets.length === 0 ? <span className="field-hint">当前未启用提醒</span> : null}
              </div>
              <div className="custom-reminder">
                <input
                  className="input"
                  type="number"
                  min={REMINDER_MIN_MINUTES}
                  max={REMINDER_MAX_MINUTES}
                  value={customMinutes}
                  onChange={(event) => setCustomMinutes(event.target.value)}
                  placeholder="自定义分钟"
                  aria-label="自定义提醒分钟数"
                />
                <button type="button" className="btn small" onClick={addCustomOffset}>
                  <Plus size={13} /> 添加
                </button>
                <span className="field-hint">范围 {REMINDER_MIN_MINUTES} 分钟 – 30 天</span>
              </div>
            </div>
          </div>
        </form>
      </Modal>
      {confirmDiscard ? (
        <ConfirmDialog
          title="放弃未保存的修改？"
          message="当前编辑内容尚未保存，关闭后将丢失这些修改。"
          confirmLabel="放弃修改"
          danger
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setConfirmDiscard(false)
            onClose()
          }}
        />
      ) : null}
    </>
  )
}
