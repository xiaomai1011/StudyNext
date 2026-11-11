import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { BrowserWindow, screen } from 'electron'

export interface PersistedWindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

const DEFAULT_STATE: PersistedWindowState = {
  width: 1360,
  height: 860,
  maximized: false
}

export function loadWindowState(filePath: string): PersistedWindowState {
  if (!existsSync(filePath)) return { ...DEFAULT_STATE }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<PersistedWindowState>
    if (
      typeof parsed.width !== 'number' ||
      typeof parsed.height !== 'number' ||
      parsed.width < 900 ||
      parsed.height < 600
    ) {
      return { ...DEFAULT_STATE }
    }
    const candidate: PersistedWindowState = {
      width: Math.round(parsed.width),
      height: Math.round(parsed.height),
      maximized: parsed.maximized === true
    }
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      candidate.x = Math.round(parsed.x)
      candidate.y = Math.round(parsed.y)
    }
    if (!isVisibleOnAnyDisplay(candidate)) {
      delete candidate.x
      delete candidate.y
    }
    return candidate
  } catch {
    return { ...DEFAULT_STATE }
  }
}

function isVisibleOnAnyDisplay(state: PersistedWindowState): boolean {
  if (state.x === undefined || state.y === undefined) return false
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea
    const overlapX = Math.max(
      0,
      Math.min(state.x! + state.width, area.x + area.width) - Math.max(state.x!, area.x)
    )
    const overlapY = Math.max(
      0,
      Math.min(state.y! + state.height, area.y + area.height) - Math.max(state.y!, area.y)
    )
    return overlapX >= 160 && overlapY >= 120
  })
}

export function trackWindowState(window: BrowserWindow, filePath: string): () => void {
  let timer: NodeJS.Timeout | null = null
  const persist = (): void => {
    if (window.isDestroyed()) return
    const normal = window.getNormalBounds()
    const state: PersistedWindowState = {
      x: normal.x,
      y: normal.y,
      width: normal.width,
      height: normal.height,
      maximized: window.isMaximized()
    }
    try {
      writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8')
    } catch {
      // Window state persistence is best-effort and never blocks app shutdown.
    }
  }
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(persist, 350)
  }
  window.on('resize', schedule)
  window.on('move', schedule)
  window.on('maximize', schedule)
  window.on('unmaximize', schedule)
  window.on('close', persist)
  return () => {
    if (timer) clearTimeout(timer)
    persist()
  }
}
