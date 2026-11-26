import { describe, expect, it } from 'vitest'
import {
  SETTINGS_SECTION_IDS,
  pickActiveSettingsSection,
  type SettingsSectionPosition
} from '../../src/shared/settings-scroll-spy'

const sections: SettingsSectionPosition[] = [
  { id: 'settings-appearance', top: 40, bottom: 300 },
  { id: 'settings-behavior', top: 320, bottom: 700 },
  { id: 'settings-reminders', top: 720, bottom: 980 }
]

describe('settings scroll spy', () => {
  it('exposes six stable section ids in visual order', () => {
    expect(SETTINGS_SECTION_IDS).toEqual([
      'settings-appearance',
      'settings-behavior',
      'settings-reminders',
      'settings-portal',
      'settings-import',
      'settings-about'
    ])
  })

  it('returns null for an empty layout', () => {
    expect(pickActiveSettingsSection([], 80, false, false)).toBeNull()
  })

  it('forces the first section at the top of the scroll container', () => {
    expect(pickActiveSettingsSection(sections, 80, true, false)).toBe('settings-appearance')
  })

  it('forces the last section at the bottom of the scroll container', () => {
    expect(pickActiveSettingsSection(sections, 80, false, true)).toBe('settings-reminders')
  })

  it('keeps the first section active above its heading', () => {
    expect(pickActiveSettingsSection(sections, 20, false, false)).toBe('settings-appearance')
  })

  it('selects the most recent heading that crossed the activation line', () => {
    expect(pickActiveSettingsSection(sections, 360, false, false)).toBe('settings-behavior')
    expect(pickActiveSettingsSection(sections, 760, false, false)).toBe('settings-reminders')
  })

  it('keeps a tall section active while its body fills the viewport', () => {
    const tall = [
      { id: 'settings-portal', top: 40, bottom: 1600 },
      { id: 'settings-ai', top: 1620, bottom: 1800 }
    ]
    expect(pickActiveSettingsSection(tall, 400, false, false)).toBe('settings-portal')
  })

  it('handles a section whose heading is exactly on the activation line', () => {
    expect(pickActiveSettingsSection(sections, 320, false, false)).toBe('settings-behavior')
  })
})
