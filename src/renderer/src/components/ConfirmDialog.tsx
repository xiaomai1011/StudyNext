import { AlertTriangle } from 'lucide-react'
import { Modal } from './Modal'

interface ConfirmDialogProps {
  title: string
  message: string
  warning?: string
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmDialog({
  title,
  message,
  warning,
  confirmLabel,
  danger = false,
  busy = false,
  onCancel,
  onConfirm
}: ConfirmDialogProps) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className={danger ? 'btn danger' : 'btn primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </>
      }
    >
      <p className="confirm-copy">{message}</p>
      {warning ? (
        <div className="confirm-warning">
          <AlertTriangle size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />
          {warning}
        </div>
      ) : null}
    </Modal>
  )
}
