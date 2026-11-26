import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  pickActiveSettingsSection,
  type SettingsSectionPosition
} from '@shared/settings-scroll-spy'

interface UseSettingsScrollSpyOptions {
  sectionIds: readonly string[]
  navRef: RefObject<HTMLElement | null>
}

interface UseSettingsScrollSpyResult {
  activeId: string
  scrollToSection: (id: string) => void
}

const PROGRAMMATIC_SETTLE_MS = 140

export function useSettingsScrollSpy({
  sectionIds,
  navRef
}: UseSettingsScrollSpyOptions): UseSettingsScrollSpyResult {
  const [activeId, setActiveId] = useState(sectionIds[0] ?? '')
  const activeRef = useRef(activeId)
  const frameRef = useRef<number | null>(null)
  const settleTimerRef = useRef<number | null>(null)
  const suppressedRef = useRef(false)
  const targetTopRef = useRef(0)

  const setActive = useCallback((next: string | null) => {
    if (!next || next === activeRef.current) return
    activeRef.current = next
    setActiveId(next)
  }, [])

  const getContainer = useCallback((): HTMLElement | null => {
    const first = document.getElementById(sectionIds[0] ?? '')
    return first?.closest<HTMLElement>('.main-scroll') ?? null
  }, [sectionIds])

  const getActivationOffset = useCallback((): number => {
    const horizontalNav = window.matchMedia('(max-width: 901px)').matches
    const navHeight = navRef.current?.getBoundingClientRect().height ?? 0
    return horizontalNav ? navHeight + 12 : 12
  }, [navRef])

  const measure = useCallback(() => {
    if (suppressedRef.current) return
    const container = getContainer()
    if (!container) return

    const containerRect = container.getBoundingClientRect()
    const sections = sectionIds
      .map((id) => {
        const element = document.getElementById(id)
        if (!element) return null
        const rect = element.getBoundingClientRect()
        return { id, top: rect.top - containerRect.top, bottom: rect.bottom - containerRect.top }
      })
      .filter((section): section is SettingsSectionPosition => section !== null)

    const atTop = container.scrollTop <= 2
    const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 2
    setActive(pickActiveSettingsSection(sections, getActivationOffset(), atTop, atBottom))
  }, [getActivationOffset, getContainer, sectionIds, setActive])

  const scheduleMeasure = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      measure()
    })
  }, [measure])

  const finishProgrammatic = useCallback(() => {
    suppressedRef.current = false
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }
    scheduleMeasure()
  }, [scheduleMeasure])

  const scrollToSection = useCallback(
    (id: string) => {
      const container = getContainer()
      const target = document.getElementById(id)
      if (!container || !target) return

      const containerRect = container.getBoundingClientRect()
      const targetTop =
        target.getBoundingClientRect().top -
        containerRect.top +
        container.scrollTop -
        getActivationOffset()
      // Leave a 2px safety margin above the activation line: smooth scrolling
      // can settle on a fractional position and the heading must remain active.
      // Clamp to the actual scroll range so the last section's target compares
      // correctly with the browser's maximum scrollTop.
      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
      const top = Math.min(maxScrollTop, Math.max(0, targetTop + 2))

      setActive(id)

      // Clicking an already-aligned item produces no scroll/scrollend event.
      // Clear any prior suppression and measure now instead of leaving the
      // Scroll-spy blocked until an unrelated user interaction.
      if (Math.abs(container.scrollTop - top) <= 2) {
        finishProgrammatic()
        return
      }

      suppressedRef.current = true
      targetTopRef.current = top

      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (reducedMotion) {
        container.scrollTop = top
        finishProgrammatic()
        return
      }

      container.scrollTo({ top, behavior: 'smooth' })
    },
    [finishProgrammatic, getActivationOffset, getContainer, setActive]
  )

  useEffect(() => {
    const container = getContainer()
    if (!container) return

    const onScroll = (): void => {
      if (!suppressedRef.current) {
        scheduleMeasure()
        return
      }

      if (Math.abs(container.scrollTop - targetTopRef.current) <= 2) {
        finishProgrammatic()
        return
      }

      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null
        finishProgrammatic()
      }, PROGRAMMATIC_SETTLE_MS)
    }

    const onUserIntent = (): void => {
      if (!suppressedRef.current) return
      suppressedRef.current = false
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current)
        settleTimerRef.current = null
      }
      scheduleMeasure()
    }

    const onScrollEnd = (): void => {
      if (suppressedRef.current) finishProgrammatic()
    }

    const onResize = (): void => {
      scheduleMeasure()
    }

    const content = container.querySelector<HTMLElement>('.settings-content')
    const observer = new ResizeObserver(onResize)
    observer.observe(container)
    if (content) observer.observe(content)
    for (const id of sectionIds) {
      const section = document.getElementById(id)
      if (section) observer.observe(section)
    }

    container.addEventListener('scroll', onScroll, { passive: true })
    container.addEventListener('scrollend', onScrollEnd)
    container.addEventListener('wheel', onUserIntent, { passive: true })
    container.addEventListener('touchstart', onUserIntent, { passive: true })
    container.addEventListener('keydown', onUserIntent)
    window.addEventListener('resize', onResize)

    scheduleMeasure()

    return () => {
      observer.disconnect()
      container.removeEventListener('scroll', onScroll)
      container.removeEventListener('scrollend', onScrollEnd)
      container.removeEventListener('wheel', onUserIntent)
      container.removeEventListener('touchstart', onUserIntent)
      container.removeEventListener('keydown', onUserIntent)
      window.removeEventListener('resize', onResize)
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current)
        settleTimerRef.current = null
      }
    }
  }, [finishProgrammatic, getContainer, scheduleMeasure, sectionIds])

  return { activeId, scrollToSection }
}
