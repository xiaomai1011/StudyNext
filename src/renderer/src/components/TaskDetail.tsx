import { useState } from 'react'
import { Bell, BookOpen, CalendarClock, CheckCircle2, Circle, Pencil, Trash2 } from 'lucide-react'
import type { Course, Task } from '@shared/types'
import { formatRemainingCompact } from '@shared/domain'
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
  const done = task.status === 'done'
  const reminders = task.reminders.filter((rule) => rule.enabled)

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
            className={`due-pill ${task.status !== 'done' && new Date(task.dueAt) < new Date() ? 'overdue' : ''}`}
          >
            {task.status === 'done' ? '已完成' : BUCKET_LABEL.upcoming}
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
                  ? 'CSV / ICS 导入'
                  : '学习通适配器'}
          </div>
        </div>
      </div>
    </Modal>
  )
}
