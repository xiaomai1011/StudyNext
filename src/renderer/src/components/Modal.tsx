import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { registerModal } from './modal-focus'

interface ModalProps {
  title: string
  subtitle?: string
  wide?: boolean
  closeOnEscape?: boolean
  initialFocus?: RefObject<HTMLElement | null>
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

export function Modal({
  title,
  subtitle,
  wide = false,
  closeOnEscape = true,
  initialFocus,
  onClose,
  children,
  footer
}: ModalProps) {
  const id = useId()
  const titleId = `${id}-title`
  const subtitleId = `${id}-subtitle`
  // Capture before React's autoFocus moves focus into the dialog. This keeps
  // the trigger element available for restoration when the dialog closes.
  const [restoreTarget] = useState<HTMLElement | null>(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  )
  const sectionRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  const closeOnEscapeRef = useRef(closeOnEscape)
  onCloseRef.current = onClose
  closeOnEscapeRef.current = closeOnEscape

  useEffect(() => {
    const element = sectionRef.current
    if (!element) return
    return registerModal({
      id,
      element,
      onClose: () => onCloseRef.current(),
      closeOnEscape: () => closeOnEscapeRef.current,
      initialFocus: initialFocus?.current ?? null,
      restoreTarget
    })
  }, [id])

  return createPortal(
    <div
      className="modal-backdrop c3-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        ref={sectionRef}
        className={wide ? 'modal wide c3-modal' : 'modal c3-modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
      >
        <header className="modal-header">
          <div>
            <h2 className="modal-title" id={titleId}>
              {title}
            </h2>
            {subtitle ? (
              <p className="modal-subtitle" id={subtitleId}>
                {subtitle}
              </p>
            ) : null}
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </section>
    </div>,
    document.body
  )
}
