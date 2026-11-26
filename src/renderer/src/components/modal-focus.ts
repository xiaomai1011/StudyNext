interface ModalLayer {
  id: string
  element: HTMLElement
  onClose: () => void
  closeOnEscape: () => boolean
  restoreTarget: HTMLElement | null
  initialFocus: HTMLElement | null
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

const layers: ModalLayer[] = []
let listening = false

export function hasOpenModal(): boolean {
  return layers.length > 0
}
const previousInert = new Map<HTMLElement, boolean>()
let previousRootInert: boolean | null = null
let baseRestoreTarget: HTMLElement | null = null
let pendingRestoreTarget: HTMLElement | null = null
let restoreFrame: number | null = null

function isVisible(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false
  if (element.closest('[inert]')) return false
  return element.getClientRects().length > 0
}

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => isVisible(element) && element.tabIndex >= 0
  )
}

function focusElement(element: HTMLElement | null): boolean {
  if (!element || !element.isConnected) return false
  if (!isVisible(element)) return false
  element.focus({ preventScroll: true })
  return document.activeElement === element
}

function focusInitial(layer: ModalLayer): void {
  if (layer.initialFocus && focusElement(layer.initialFocus)) return
  if (layer.element.contains(document.activeElement) && document.activeElement !== document.body) {
    return
  }
  const marked = layer.element.querySelector<HTMLElement>('[data-modal-autofocus], [autofocus]')
  if (focusElement(marked)) return
  const [first] = getFocusableElements(layer.element)
  if (focusElement(first ?? null)) return
  layer.element.focus({ preventScroll: true })
}

function focusFallback(): void {
  const marked = document.querySelector<HTMLElement>('[data-modal-focus-fallback]')
  if (focusElement(marked)) return
  const navItem = document.querySelector<HTMLElement>('.nav-item')
  if (focusElement(navItem)) return
  const root = document.getElementById('root')
  if (root) {
    const previousTabIndex = root.getAttribute('tabindex')
    root.setAttribute('tabindex', '-1')
    root.focus({ preventScroll: true })
    if (previousTabIndex === null) root.removeAttribute('tabindex')
    else root.setAttribute('tabindex', previousTabIndex)
  }
}

function scheduleRestore(target: HTMLElement | null): void {
  pendingRestoreTarget = target
  if (restoreFrame !== null) return
  restoreFrame = requestAnimationFrame(() => {
    restoreFrame = null
    const isFinal = layers.length === 0
    const targetToRestore = isFinal ? baseRestoreTarget : pendingRestoreTarget
    pendingRestoreTarget = null
    if (targetToRestore && targetToRestore.isConnected && focusElement(targetToRestore)) {
      if (isFinal) baseRestoreTarget = null
      return
    }
    const lower = layers[layers.length - 1]
    if (lower) {
      const [first] = getFocusableElements(lower.element)
      if (focusElement(first ?? lower.element)) return
    }
    if (layers.length === 0) baseRestoreTarget = null
    focusFallback()
  })
}

function updateBackgroundInert(): void {
  const root = document.getElementById('root')
  if (layers.length > 0) {
    if (root && !previousRootInert && !root.hasAttribute('inert')) {
      previousRootInert = false
      root.setAttribute('inert', '')
    }
  } else if (root && previousRootInert !== null) {
    if (!previousRootInert) root.removeAttribute('inert')
    else root.setAttribute('inert', '')
    previousRootInert = null
  }

  const top = layers[layers.length - 1]
  for (const backdrop of document.querySelectorAll<HTMLElement>('.modal-backdrop')) {
    const owner = layers.find((layer) => backdrop.contains(layer.element))
    const shouldInert = Boolean(owner && owner !== top)
    if (owner && owner !== top) {
      if (!previousInert.has(backdrop) && !backdrop.hasAttribute('inert')) {
        previousInert.set(backdrop, false)
      }
      backdrop.setAttribute('inert', '')
    } else if (previousInert.has(backdrop)) {
      if (previousInert.get(backdrop)) backdrop.setAttribute('inert', '')
      else backdrop.removeAttribute('inert')
      previousInert.delete(backdrop)
    }
  }
}

function trapTab(event: KeyboardEvent, layer: ModalLayer): void {
  const focusables = getFocusableElements(layer.element)
  if (focusables.length === 0) {
    event.preventDefault()
    layer.element.focus({ preventScroll: true })
    return
  }
  const first = focusables[0]!
  const last = focusables[focusables.length - 1]!
  const active = document.activeElement as HTMLElement | null
  if (!active || !layer.element.contains(active)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus({ preventScroll: true })
    return
  }
  if (event.shiftKey && active === first) {
    event.preventDefault()
    last.focus({ preventScroll: true })
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus({ preventScroll: true })
  }
}

function handleKeyDown(event: KeyboardEvent): void {
  const top = layers[layers.length - 1]
  if (!top) return
  if (event.key === 'Tab') {
    trapTab(event, top)
    return
  }
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  if (top.closeOnEscape()) top.onClose()
}

export function registerModal(options: {
  id: string
  element: HTMLElement
  onClose: () => void
  closeOnEscape: () => boolean
  initialFocus?: HTMLElement | null
  restoreTarget?: HTMLElement | null
}): () => void {
  const layer: ModalLayer = {
    ...options,
    initialFocus: options.initialFocus ?? null,
    restoreTarget:
      options.restoreTarget ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null)
  }
  if (layers.length === 0) {
    if (restoreFrame !== null) {
      cancelAnimationFrame(restoreFrame)
      restoreFrame = null
      pendingRestoreTarget = null
    }
    baseRestoreTarget = layer.restoreTarget
  }
  layers.push(layer)
  updateBackgroundInert()
  if (!listening) {
    listening = true
    document.addEventListener('keydown', handleKeyDown, true)
  }
  requestAnimationFrame(() => {
    if (layers[layers.length - 1] === layer) focusInitial(layer)
  })

  return () => {
    const index = layers.indexOf(layer)
    if (index >= 0) layers.splice(index, 1)
    updateBackgroundInert()
    scheduleRestore(layer.restoreTarget)
    if (layers.length === 0 && listening) {
      listening = false
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }
}
