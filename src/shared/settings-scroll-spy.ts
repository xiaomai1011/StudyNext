export const SETTINGS_SECTION_IDS = [
  'settings-appearance',
  'settings-behavior',
  'settings-reminders',
  'settings-portal',
  'settings-import',
  'settings-about'
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number]

export interface SettingsSectionPosition {
  id: string
  top: number
  bottom: number
}

/** Pick the section whose heading has most recently crossed the activation line. */
export function pickActiveSettingsSection(
  sections: readonly SettingsSectionPosition[],
  threshold: number,
  atTop: boolean,
  atBottom: boolean
): string | null {
  if (sections.length === 0) return null
  if (atTop) return sections[0]?.id ?? null
  if (atBottom) return sections[sections.length - 1]?.id ?? null

  let active = sections[0]?.id ?? null
  for (const section of sections) {
    if (section.top > threshold) break
    active = section.id
  }
  return active
}
