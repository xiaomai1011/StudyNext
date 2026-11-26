import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost'
export type ButtonSize = 'sm' | 'md'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={classes(
        'btn',
        'ds-button',
        `ds-button--${variant}`,
        `ds-button--${size}`,
        className
      )}
    />
  )
}

export type BadgeTone = 'neutral' | 'info' | 'accent' | 'success' | 'warning' | 'danger'

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
}

export function Badge({ tone = 'neutral', className, ...props }: BadgeProps) {
  return <span {...props} className={classes('ds-badge', `ds-badge--${tone}`, className)} />
}

interface PageHeaderProps {
  eyebrow?: string
  title: string
  subtitle?: string
  icon?: ReactNode
  actions?: ReactNode
  className?: string
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  icon,
  actions,
  className
}: PageHeaderProps) {
  return (
    <header className={classes('page-header', 'ds-page-header', className)}>
      <div className="page-header-copy ds-page-header-copy">
        {eyebrow ? (
          <div className="eyebrow ds-eyebrow">
            {icon}
            {eyebrow}
          </div>
        ) : null}
        <h1 className="page-title ds-page-title">{title}</h1>
        {subtitle ? <p className="page-subtitle ds-page-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="header-actions ds-page-header-actions">{actions}</div> : null}
    </header>
  )
}

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  compact?: boolean
  className?: string
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
  className
}: EmptyStateProps) {
  return (
    <div className={classes('empty-state', 'ds-empty-state', compact && 'compact', className)}>
      {icon ? <div className="ds-empty-icon">{icon}</div> : null}
      <div className="empty-title ds-empty-title">{title}</div>
      {description ? <p className="empty-text ds-empty-text">{description}</p> : null}
      {action ? <div className="ds-empty-action">{action}</div> : null}
    </div>
  )
}
