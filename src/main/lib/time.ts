export function nowIso(): string {
  return new Date().toISOString()
}

export function localDateWithOffset(daysFromToday: number, hour: number, minute = 0): Date {
  const now = new Date()
  const date = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + daysFromToday,
    hour,
    minute,
    0,
    0
  )
  return date
}

export function formatLocalDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function isWeekend(date: Date): boolean {
  const day = date.getDay()
  return day === 0 || day === 6
}
