import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'

export type ToastKind = 'success' | 'error' | 'info'

export interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

interface ToastStackProps {
  toasts: ToastItem[]
  onDismiss: (id: number) => void
}

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => {
        const Icon =
          toast.kind === 'success' ? CheckCircle2 : toast.kind === 'error' ? AlertCircle : Info
        return (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            <Icon size={16} />
            <span>{toast.message}</span>
            <button
              type="button"
              className="toast-close"
              onClick={() => onDismiss(toast.id)}
              aria-label="关闭提示"
            >
              <X />
            </button>
          </div>
        )
      })}
    </div>
  )
}
