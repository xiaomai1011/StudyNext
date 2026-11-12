import { useEffect, useState } from 'react'
import { Bell, BookOpen, CalendarClock, CheckCircle2, Circle, Pencil, Trash2 } from 'lucide-react'
import type { Course, Task, TaskChange } from '@shared/types'
import { dueBucket, formatRemainingCompact } from '@shared/domain'
import { Modal } from './Modal'
import {
  BUCKET_LABEL,
  formatDateTime,
  kindLabel,
  priorityLabel,
  reminderOffsetLabel
} from '../lib/format'

interface TaskDetailProps {
  task: Task
  course: Course | null
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
  onToggle: () => Promise<void>
}

export function TaskDetail({ task, course, onClose, onEdit, onDelete, onToggle }: TaskDetailProps) {
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<TaskChange[]>([])
  const done = task.status === 'done'
  const bucket = dueBucket(task)
  const reminders = task.reminders.filter((rule) => rule.enabled)

  useEffect(() => {
    let active = true
    void window.studynext.tasks
      .history(task.id)
      .then((rows) => {
        if (active) setHistory(rows)
      })
      .catch(() => {
        if (active) setHistory([])
      })
    return () => {
      active = false
    }
  }, [task.id, task.updatedAt])

  const toggle = async (): Promise<void> => {
    setBusy(true)
    try {
      await onToggle()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="任务详情"
      subtitle={`创建于 ${formatDateTime(task.createdAt)}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn danger small" onClick={onDelete}>
            <Trash2 size={14} /> 删除
          </button>
          <span className="spacer" />
          <button type="button" className="btn small" onClick={onEdit}>
            <Pencil size={14} /> 编辑
          </button>
          <button
            type="button"
            className={done ? 'btn small' : 'btn primary small'}
            onClick={() => void toggle()}
            disabled={busy}
          >
            {done ? <Circle size={14} /> : <CheckCircle2 size={14} />}
            {done ? '标记为待完成' : '标记为完成'}
          </button>
        </>
      }
    >
      <div className="detail-hero">
        <div className="detail-title">{task.title}</div>
        <div className="detail-meta">
          <span
            className={`due-pill ${bucket === 'overdue' ? 'overdue' : bucket === 'today' ? 'today' : ''}`}
          >
            {BUCKET_LABEL[bucket]}
          </span>
          <span>{formatRemainingCompact(task.dueAt)}</span>
          <span className="dot-separator" />
          <span>{kindLabel(task.kind)}</span>
          <span className="dot-separator" />
          <span>{priorityLabel(task.priority)}</span>
        </div>
        {task.description ? <div className="detail-description">{task.description}</div> : null}
      </div>

      <div className="detail-grid">
        <div className="detail-item">
          <div className="detail-item-label">所属课程</div>
          <div
            className="detail-item-value"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <BookOpen size={13} />
            {course?.name ?? '未关联课程'}
          </div>
        </div>
        <div className="detail-item">
          <div className="detail-item-label">截止时间</div>
          <div
            className="detail-item-value"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <CalendarClock size={13} />
            {formatDateTime(task.dueAt)}
          </div>
        </div>
        <div className="detail-item">
          <div className="detail-item-label">提醒规则</div>
          <div
            className="detail-item-value"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <Bell size={13} />
            {reminders.length > 0
              ? reminders.map((rule) => reminderOffsetLabel(rule.offsetMinutes)).join('、')
              : '未设置提醒'}
          </div>
        </div>
        <div className="detail-item">
          <div className="detail-item-label">数据来源</div>
          <div className="detail-item-value">
            {task.source === 'demo'
              ? '演示数据'
              : task.source === 'manual'
                ? '手动创建'
                : task.source === 'import'
                  ? '本地学习快照'
                  : '学习通授权适配器'}
          </div>
        </div>
        <div className="detail-item">
          <div className="detail-item-label">完成方式</div>
          <div className="detail-item-value">
            {task.status !== 'done'
              ? '尚未完成'
              : task.completionSource === 'local'
                ? '本地手动标记'
                : task.completionSource === 'platform'
                  ? '平台返回已完成'
                  : '未标注'}
          </div>
        </div>
      </div>

      {task.manualFields.length > 0 || task.externalId ? (
        <div className="mini-empty" style={{ marginTop: 12, lineHeight: 1.7 }}>
          {task.externalId ? (
            <div>
              外部标识：<code>{task.externalId}</code>
            </div>
          ) : null}
          {task.manualFields.length > 0 ? (
            <div>已保留 {task.manualFields.length} 个本地修改字段；后续导入不会覆盖这些字段。</div>
          ) : null}
        </div>
      ) : null}

      {history.length > 0 ? (
        <div className="task-history">
          <div className="task-history-title">最近变更</div>
          {history.slice(0, 4).map((change) => (
            <div className="task-history-row" key={change.id}>
              <span>{formatDateTime(change.changedAt)}</span>
              <span>{change.summary}</span>
            </div>
          ))}
        </div>
      ) : null}
    </Modal>
  )
}
