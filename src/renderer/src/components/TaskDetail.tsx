import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Bell,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  Circle,
  Download,
  ExternalLink,
  History,
  MessageSquareText,
  Monitor,
  Pencil,
  Trash2
} from 'lucide-react'
import type { Course, Task, TaskChange } from '@shared/types'
import { formatRemainingCompact } from '@shared/domain'
import {
  getTaskPortalAction,
  getTaskScoreView,
  isTaskActionable,
  platformStatusLabel
} from '@shared/task-state'
import { getTaskDetailDueBanner } from '@shared/task-workflow'
import { Modal } from './Modal'
import {
  errorMessage,
  formatDateTime,
  formatDueAt,
  kindLabel,
  priorityLabel,
  reminderOffsetLabel
} from '../lib/format'
import { Badge, Button } from '../ui/primitives'
import { platformStatusTone, scoreTone } from '../ui/status'

interface TaskDetailProps {
  task: Task
  course: Course | null
  onClose: () => void
  onEdit: () => void
  onOpenInPortal: () => void
  onOpenCourse?: (() => void) | undefined
  onDelete: () => void
  onToggle: () => Promise<void>
}

export function TaskDetail({
  task,
  course,
  onClose,
  onEdit,
  onOpenInPortal,
  onOpenCourse,
  onDelete,
  onToggle
}: TaskDetailProps) {
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<TaskChange[]>([])
  const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [historyNonce, setHistoryNonce] = useState(0)
  const [attachmentBusyIndex, setAttachmentBusyIndex] = useState<number | null>(null)
  const [attachmentNotice, setAttachmentNotice] = useState<{
    tone: 'success' | 'error'
    text: string
  } | null>(null)
  const done = task.status === 'done'
  const actionable = isTaskActionable(task)
  const dueBanner = getTaskDetailDueBanner(task)
  const dueLabel = formatDueAt(task.dueAt)
  const remainingLabel = dueLabel ? formatRemainingCompact(task.dueAt) : ''
  const reminders = task.reminders.filter((rule) => rule.enabled)
  const platformTask = task.source === 'chaoxing'
  const scoreView = getTaskScoreView(task)
  const portalAction = getTaskPortalAction(task, course)
  const primaryPortal = portalAction.kind === 'answer'

  useEffect(() => {
    let active = true
    setHistoryState('loading')
    void window.studynext.tasks
      .history(task.id)
      .then((rows) => {
        if (!active) return
        setHistory(rows)
        setHistoryState('ready')
      })
      .catch(() => {
        if (!active) return
        setHistory([])
        setHistoryState('error')
      })
    return () => {
      active = false
    }
  }, [task.id, task.updatedAt, historyNonce])

  const toggle = async (): Promise<void> => {
    setBusy(true)
    try {
      await onToggle()
    } finally {
      setBusy(false)
    }
  }

  const downloadAttachment = async (index: number): Promise<void> => {
    setAttachmentBusyIndex(index)
    setAttachmentNotice(null)
    try {
      await window.studynext.tasks.downloadAttachment(task.id, index)
      setAttachmentNotice({
        tone: 'success',
        text: `已开始下载：${task.attachments[index]?.name ?? '附件'}`
      })
    } catch (error) {
      setAttachmentNotice({ tone: 'error', text: errorMessage(error) })
    } finally {
      setAttachmentBusyIndex(null)
    }
  }

  const openLabel = portalAction.label
  const entryNotice =
    portalAction.kind === 'unavailable'
      ? {
          tone: 'warning' as const,
          title: '没有可用的官方入口',
          body: `${portalAction.title}；不会猜测或构造官方 URL。`
        }
      : portalAction.kind === 'course'
        ? {
            tone: 'info' as const,
            title: '作业原页不可用，已降级到课程页',
            body: '该入口指向所属课程，而不是具体作业。进入课程后请在学习通内自行定位作业。'
          }
        : {
            tone: 'neutral' as const,
            title: '官方入口已就绪',
            body:
              portalAction.kind === 'view'
                ? '该作业已提交，当前入口仅用于查看原页和提交记录。'
                : '入口通过 HTTPS 与学习通域名白名单校验；打开后仍受平台登录状态和权限限制。'
          }

  return (
    <Modal
      title="任务详情"
      subtitle={`${course ? `${course.name}${course.className ? ` · ${course.className}` : ''}` : '未关联课程'} · 创建于 ${formatDateTime(task.createdAt)}`}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            className="b2-detail-delete"
            onClick={onDelete}
            disabled={platformTask}
            title={platformTask ? '平台任务不能本地删除，请在平台处理或保留记录' : '删除本地任务'}
            aria-label={platformTask ? '平台任务不能本地删除' : '删除任务'}
          >
            <Trash2 size={14} /> 删除
          </Button>
          <span className="spacer" />
          {platformTask ? (
            <>
              <Button variant="secondary" size="sm" onClick={onEdit}>
                <Pencil size={14} /> 编辑
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  if (portalAction.target)
                    void window.studynext.app.openExternal(portalAction.target.url)
                }}
                disabled={!portalAction.target}
                title={portalAction.target ? '在浏览器打开' : portalAction.title}
              >
                <ExternalLink size={14} /> 在浏览器打开
              </Button>
              <Button
                variant={primaryPortal ? 'primary' : 'secondary'}
                size="sm"
                onClick={onOpenInPortal}
                disabled={portalAction.disabled}
                aria-disabled={portalAction.disabled}
                title={portalAction.title}
              >
                <Monitor size={14} /> {openLabel}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={onEdit}>
                <Pencil size={14} /> 编辑
              </Button>
              <Button
                variant={done ? 'secondary' : 'primary'}
                size="sm"
                onClick={() => void toggle()}
                disabled={busy}
              >
                {done ? <Circle size={14} /> : <CheckCircle2 size={14} />}
                {done ? '标记为待完成' : '标记为完成'}
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="b2-detail-body">
        <header className="b2-detail-hero">
          <div className="b2-detail-eyebrow">
            <span>{kindLabel(task.kind)}</span>
            <span className="b2-detail-dot" />
            <span>{priorityLabel(task.priority)}</span>
            <span className="b2-detail-dot" />
            <span className={`b2-detail-due is-${dueBanner.tone}`}>{dueBanner.label}</span>
          </div>
          <h2 className="b2-detail-title">{task.title}</h2>
          <div className="b2-detail-course-line">
            <BookOpen size={14} />
            {course && onOpenCourse ? (
              <button
                type="button"
                className="link-button"
                onClick={onOpenCourse}
                title="进入该课程空间查看章节与资料"
              >
                {course.name}
              </button>
            ) : (
              <span>{course?.name ?? '未关联课程'}</span>
            )}
            {course?.className ? <span className="b2-detail-class">{course.className}</span> : null}
          </div>
        </header>

        <section className="b2-detail-state-grid" aria-label="任务状态">
          <div className="b2-state-panel">
            <div className="b2-state-label">平台状态</div>
            <div className="b2-state-value">
              <Badge tone={platformStatusTone(task.platformStatusKind)}>
                {platformStatusLabel(task.platformStatusKind)}
              </Badge>
              {task.platformStatus &&
              task.platformStatus !== platformStatusLabel(task.platformStatusKind) ? (
                <span className="b2-state-raw">原文：{task.platformStatus}</span>
              ) : null}
            </div>
            <p className="b2-state-note">
              {task.platformStatusKind === 'pending_review'
                ? '平台已收到提交，正在等待教师审核。'
                : task.platformStatusKind === 'submitted'
                  ? '平台已收到提交，尚未进入批阅。'
                  : task.platformStatusKind === 'reviewed'
                    ? '教师已完成批阅，成绩和批语以平台返回为准。'
                    : task.platformStatusKind === 'done'
                      ? '平台将该作业标记为已完成。'
                      : '平台状态只反映学习通返回的数据。'}
            </p>
          </div>
          <div className="b2-state-panel">
            <div className="b2-state-label">本地状态</div>
            <div className="b2-state-value">
              <Badge tone={done ? 'success' : 'neutral'}>{done ? '已完成' : '未完成'}</Badge>
            </div>
            <p className="b2-state-note">
              {task.completionSource === 'platform'
                ? '由平台完成状态同步而来。'
                : task.completionSource === 'local'
                  ? '由你本地手动标记，不会回写学习通。'
                  : '尚未记录完成方式。'}
            </p>
          </div>
        </section>

        {task.teacherFeedback ? (
          <section className="b2-detail-section">
            <div className="n7-detail-review-head">
              <h3>
                <MessageSquareText size={13} /> 教师批语
              </h3>
              {scoreView.state === 'graded' ? (
                <span className="n7-row-score" data-score-state={scoreView.state}>
                  成绩 {scoreView.text}
                </span>
              ) : null}
            </div>
            <blockquote className="b2-detail-feedback">{task.teacherFeedback}</blockquote>
          </section>
        ) : null}

        <section className="b2-detail-facts" aria-label="任务信息">
          <div className="b2-fact">
            <div className="b2-fact-label">
              <CalendarClock size={12} /> 截止时间
            </div>
            <div className="b2-fact-value">{dueLabel ?? '未设置'}</div>
            {remainingLabel ? (
              <div className="b2-fact-hint">
                {!actionable && dueBanner.tone === 'settled' && remainingLabel.startsWith('已逾期')
                  ? '截止已过（已由平台或本地处理）'
                  : remainingLabel}
              </div>
            ) : null}
          </div>
          <div className="b2-fact">
            <div className="b2-fact-label">提交时间</div>
            <div className="b2-fact-value">
              {task.submittedAt ? formatDateTime(task.submittedAt) : '平台未返回'}
            </div>
            <div className="b2-fact-hint">仅使用平台实际返回的提交时间</div>
          </div>
          <div className="b2-fact">
            <div className="b2-fact-label">成绩</div>
            <div className="b2-fact-value" data-score-state={scoreView.state}>
              <span className={`b2-score ${scoreTone(scoreView.state)}`}>{scoreView.text}</span>
            </div>
            <div className="b2-fact-hint">零分显示为 0，不当作缺失值</div>
          </div>
          <div className="b2-fact">
            <div className="b2-fact-label">数据来源</div>
            <div className="b2-fact-value">
              {task.source === 'demo'
                ? '演示数据'
                : task.source === 'manual'
                  ? '手动创建'
                  : task.source === 'import'
                    ? '本地学习快照'
                    : '学习通 Web Session'}
            </div>
          </div>
          <div className="b2-fact">
            <div className="b2-fact-label">
              <Bell size={12} /> 提醒规则
            </div>
            <div className="b2-fact-value">
              {reminders.length > 0
                ? reminders.map((rule) => reminderOffsetLabel(rule.offsetMinutes)).join('、')
                : '未设置提醒'}
            </div>
          </div>
        </section>

        {task.description ? (
          <section className="b2-detail-section">
            <h3>任务说明</h3>
            <p className="b2-detail-description">{task.description}</p>
          </section>
        ) : null}

        {task.attachments.length > 0 ? (
          <section className="b2-detail-section">
            <h3>附件</h3>
            <ul className="b2-detail-attachments">
              {task.attachments.map((attachment, index) => {
                const canDownload =
                  platformTask && Boolean(attachment.objectId) && attachmentBusyIndex === null
                return (
                  <li
                    key={`${attachment.objectId ?? attachment.name}-${attachment.name}`}
                    className="b2-attachment-row"
                  >
                    <div className="b2-attachment-info">
                      <Download size={13} />
                      <span className="b2-attachment-name">{attachment.name}</span>
                      {attachment.size ? (
                        <span className="b2-attachment-size">{attachment.size}</span>
                      ) : null}
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="b2-attachment-download"
                      disabled={!canDownload}
                      title={
                        !platformTask
                          ? '本地任务没有平台附件'
                          : !attachment.objectId
                            ? '平台没有返回附件标识'
                            : '通过学习通会话下载到本机'
                      }
                      onClick={() => void downloadAttachment(index)}
                    >
                      <Download size={12} />
                      {attachmentBusyIndex === index ? '正在准备…' : '下载'}
                    </Button>
                  </li>
                )
              })}
            </ul>
            {attachmentNotice ? (
              <p className={`b2-attachment-notice is-${attachmentNotice.tone}`}>
                {attachmentNotice.text}
              </p>
            ) : null}
          </section>
        ) : null}

        <section className={`b2-entry-notice is-${entryNotice.tone}`}>
          <div className="b2-entry-notice-icon">
            {portalAction.target ? <ExternalLink size={15} /> : <AlertTriangle size={15} />}
          </div>
          <div>
            <strong>{entryNotice.title}</strong>
            <p>{entryNotice.body}</p>
          </div>
        </section>

        <section className="b2-detail-section b2-history-section">
          <div className="b2-history-head">
            <h3>
              <History size={13} /> 最近变更
            </h3>
            {historyState === 'error' ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setHistoryNonce((value) => value + 1)}
              >
                重试
              </Button>
            ) : null}
          </div>
          {historyState === 'loading' ? (
            <p className="b2-history-state">正在读取变更历史…</p>
          ) : historyState === 'error' ? (
            <p className="b2-history-state is-error">
              变更历史读取失败，不影响任务本身的同步数据。
            </p>
          ) : history.length === 0 ? (
            <p className="b2-history-state">暂无变更记录。</p>
          ) : (
            <div className="b2-history-list">
              {history.slice(0, 6).map((change) => (
                <div className="b2-history-row" key={change.id}>
                  <span>{formatDateTime(change.changedAt)}</span>
                  <span>{change.summary}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {task.manualFields.length > 0 || task.externalId ? (
          <div className="b2-detail-footnote">
            {task.externalId ? (
              <div>
                外部标识：<code>{task.externalId}</code>
              </div>
            ) : null}
            {task.manualFields.length > 0 ? (
              <div>
                已保留 {task.manualFields.length} 个本地修改字段；后续导入不会覆盖这些字段。
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
