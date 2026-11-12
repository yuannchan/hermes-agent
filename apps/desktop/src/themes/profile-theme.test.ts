import { beforeEach, describe, expect, it } from 'vitest'

import { modePref, skinPref } from './context'
import { DEFAULT_SKIN_NAME } from './presets'

// Skin and mode share one per-profile contract, so assert it once over both.
interface Pref {
  resolve: (profile: string) => string
  assign: (profile: string, value: string) => void
  stored: (profile: string) => null | string
}

const cases = [
  {
    name: 'skin',
    pref: skinPref as unknown as Pref,
    fallback: DEFAULT_SKIN_NAME,
    a: 'ember',
    b: 'catppuccin',
    resolvedA: 'ember',
    resolvedB: 'catppuccin',
    junk: 'nope'
  },
  {
    name: 'mode',
    pref: modePref as unknown as Pref,
    fallback: 'light',
    a: 'dark',
    b: 'light',
    resolvedA: 'light',
    resolvedB: 'light',
    junk: 'dusk'
  }
]

describe.each(cases)('per-profile $name', ({ pref, fallback, a, b, resolvedA, resolvedB, junk }) => {
  beforeEach(() => window.localStorage.clear())

  it('falls back to the default when unassigned', () => {
    expect(pref.resolve('default')).toBe(fallback)
    expect(pref.resolve('work')).toBe(fallback)
  })

  it('stores each profile pick independently and resolves it under the current appearance policy', () => {
    pref.assign('work', a)
    pref.assign('default', b)
    expect(pref.stored('work')).toBe(a)
    expect(pref.stored('default')).toBe(b)
    expect(pref.resolve('work')).toBe(resolvedA)
    expect(pref.resolve('default')).toBe(resolvedB)
  })

  it('lets unassigned profiles inherit the default profile as the global fallback', () => {
    pref.assign('default', a)
    expect(pref.stored('never-themed')).toBe(a)
    expect(pref.resolve('never-themed')).toBe(resolvedA)
  })

  it('normalizes an unknown stored value back to the default', () => {
    pref.assign('work', junk)
    expect(pref.resolve('work')).toBe(fallback)
  })
})
// #101216: named-profile assign must seed the global fallback so a Bot Mode
// gateway hop inherits the stored pick, while Holo still resolves every mode to light.
describe('named-profile appearance seeds the global fallback (#101216)', () => {
  beforeEach(() => window.localStorage.clear())

  it('keeps a never-themed bot light when the launch profile has a legacy Dark assignment', () => {
    modePref.assign('forge', 'dark')
    expect(modePref.stored('atlas')).toBe('dark')
    expect(modePref.resolve('atlas')).toBe('light')
  })

  it('keeps an explicit per-profile override while normalizing both profiles to light', () => {
    modePref.assign('forge', 'dark')
    modePref.assign('atlas', 'light')
    expect(modePref.stored('forge')).toBe('dark')
    expect(modePref.stored('atlas')).toBe('light')
    expect(modePref.resolve('forge')).toBe('light')
    expect(modePref.resolve('atlas')).toBe('light')
  })

  it('lets a never-themed profile inherit the last named-profile assign', () => {
    modePref.assign('forge', 'dark')
    modePref.assign('atlas', 'light')
    expect(modePref.stored('never-themed')).toBe('light')
    expect(modePref.resolve('never-themed')).toBe('light')
  })

  it('promotes a unanimous pre-existing per-profile mode but resolves it as light', () => {
    window.localStorage.setItem('hermes-desktop-profile-modes-v1', JSON.stringify({ forge: 'dark' }))
    expect(modePref.stored('atlas')).toBe('dark')
    expect(modePref.resolve('atlas')).toBe('light')
  })
})
