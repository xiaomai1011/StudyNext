/**
 * Keep the active Settings navigation item inside the navigation viewport.
 *
 * The navigation is vertical on wide layouts and horizontally scrollable on
 * narrow layouts. The same active item can therefore become clipped when the
 * window crosses the layout breakpoint without `activeId` changing, so this
 * function is also called from a ResizeObserver on the navigation element.
 */
export function ensureActiveNavVisible(nav: HTMLElement, activeId: string): void {
  const item = nav.querySelector<HTMLElement>(`[data-settings-nav="${activeId}"]`)
  if (!item || nav.scrollWidth <= nav.clientWidth) return

  const navRect = nav.getBoundingClientRect()
  const itemRect = item.getBoundingClientRect()
  const viewLeft = nav.scrollLeft
  const viewRight = viewLeft + nav.clientWidth
  const itemLeft = itemRect.left - navRect.left + viewLeft
  const itemRight = itemLeft + itemRect.width

  let next: number
  if (itemLeft < viewLeft) {
    next = itemLeft - 8
  } else if (itemRight > viewRight) {
    next = itemRight - nav.clientWidth + 8
  } else {
    return
  }

  const max = Math.max(0, nav.scrollWidth - nav.clientWidth)
  nav.scrollTo({ left: Math.min(max, Math.max(0, next)), behavior: 'auto' })
}
