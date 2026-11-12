import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopUpdateStatus, DesktopVersionInfo, HermesConnection } from '@/global'
import { en } from '@/i18n/en'
import type * as SessionStore from '@/store/session'
import { $connection } from '@/store/session'
import type * as UpdatesStore from '@/store/updates'
import {
  $backendUpdateStatus,
  $desktopVersion,
  $updateStatus,
  checkBackendUpdates,
  checkUpdates,
  refreshDesktopVersion,
  setUpdateChannel,
  startActiveUpdate,
  type UpdateApplyState
} from '@/store/updates'

import { AboutSettings } from './about-settings'

vi.mock('@/store/session', async (importOriginal): Promise<Record<string, unknown>> => {
  const actual = await importOriginal<typeof SessionStore>()
  const { atom } = await import('nanostores')

  return { ...actual, $connection: atom<HermesConnection | null>(null) }
})

vi.mock('@/store/updates', async (): Promise<Record<string, unknown>> => {
  const { atom } = await import('nanostores')

  const idle: UpdateApplyState = {
    applying: false,
    stage: 'idle',
    message: '',
    percent: null,
    error: null,
    command: null,
    log: []
  }

  return {
    $desktopVersion: atom<DesktopVersionInfo | null>(null),
    $backendUpdateApply: atom<UpdateApplyState>(idle),
    $backendUpdateChecking: atom<boolean>(false),
    $backendUpdateStatus: atom<DesktopUpdateStatus | null>(null),
    $updateApply: atom<UpdateApplyState>(idle),
    $updateChecking: atom<boolean>(false),
    $updateStatus: atom<DesktopUpdateStatus | null>(null),
    checkBackendUpdates: vi.fn<() => Promise<DesktopUpdateStatus | null>>().mockResolvedValue(null),
    checkUpdates: vi.fn<() => Promise<DesktopUpdateStatus | null>>().mockResolvedValue(null),
    refreshDesktopVersion: vi.fn<() => Promise<DesktopVersionInfo | null>>().mockResolvedValue(null),
    setUpdateChannel: vi.fn<() => Promise<DesktopUpdateStatus | null>>().mockResolvedValue(null),
    sourceUpdateChannel: (await vi.importActual<typeof UpdatesStore>('@/store/updates')).sourceUpdateChannel,
    sourceUpdateTrack: (await vi.importActual<typeof UpdatesStore>('@/store/updates')).sourceUpdateTrack,
    openUpdateOverlayFor: vi.fn(),
    openUpdatesWindow: vi.fn(),
    startActiveUpdate: vi.fn()
  }
})

function connection(mode: 'local' | 'remote'): HermesConnection {
  return {
    baseUrl: 'http://gateway:9119',
    isFullscreen: false,
    mode,
    nativeOverlayWidth: 0,
    token: 'test-token',
    wsUrl: 'ws://gateway:9119',
    logs: [],
    windowButtonPosition: null
  }
}

describe('AboutSettings', (): void => {
  beforeEach((): void => {
    vi.clearAllMocks()
    $connection.set(connection('local'))
    $desktopVersion.set({
      appVersion: '1.2.3',
      electronVersion: '40',
      nodeVersion: '26',
      platform: 'linux',
      hermesRoot: '/test/hermes',
      installId: 'test-install'
    })
    $updateStatus.set({ supported: true, behind: 0 })
    $backendUpdateStatus.set({ supported: true, behind: 0 })
  })

  afterEach((): void => {
    cleanup()
  })

  it('shows shared version details without client or backend update controls', (): void => {
    const { rerender } = render(<AboutSettings />)

    expect(screen.getByRole('heading', { name: en.updates.appName })).toBeTruthy()
    expect(screen.getByText(en.updates.versionDetailsInstallId)).toBeTruthy()
    expect(screen.queryByText(en.updates.latestBody)).toBeNull()
    expect(screen.queryByText(en.updates.latestBodyBackend)).toBeNull()
    expect(screen.queryByRole('button', { name: en.updates.checkNow })).toBeNull()
    expect(refreshDesktopVersion).toHaveBeenCalledTimes(1)
    expect(checkUpdates).not.toHaveBeenCalled()
    expect(checkBackendUpdates).not.toHaveBeenCalled()

    $connection.set(connection('remote'))
    rerender(<AboutSettings />)

    expect(screen.queryByText(en.updates.latestBodyBackend)).toBeNull()
    expect(screen.queryByRole('link', { name: en.updates.releaseNotes })).toBeNull()
    expect(checkBackendUpdates).not.toHaveBeenCalled()

    $connection.set({ ...connection('remote'), baseUrl: 'http://other-gateway:9119' })
    rerender(<AboutSettings />)

    // About refreshes the desktop's own version once per mount, not per gateway.
    expect(refreshDesktopVersion).toHaveBeenCalledTimes(1)
    expect(checkBackendUpdates).not.toHaveBeenCalled()
  })

  it('keeps a Hermes Cloud remote gateway on version details only', (): void => {
    $connection.set({ ...connection('remote'), baseUrl: 'https://lab.agents.nousresearch.com', remoteKind: 'cloud' })
    render(<AboutSettings />)

    expect(screen.getByText(en.updates.versionDetailsInstallId)).toBeTruthy()
    expect(screen.queryByText(en.updates.latestBody)).toBeNull()
    expect(screen.queryByText(en.updates.latestBodyBackend)).toBeNull()
    expect(screen.queryByRole('button', { name: en.updates.updateNow })).toBeNull()
    expect(checkUpdates).not.toHaveBeenCalled()
    expect(checkBackendUpdates).not.toHaveBeenCalled()
  })

  it('shows the fixed package channel with no selector', (): void => {
    $desktopVersion.set({ ...$desktopVersion.get()!, channel: 'canary' })
    render(<AboutSettings />)
    expect(screen.getByText(`${en.updates.version('1.2.3')} · ${en.updates.channels.canary}`)).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('shows a source checkout channel as read-only version details', (): void => {
    const about = en.settings.about.channel
    $updateStatus.set({
      supported: true,
      behind: 0,
      mechanism: 'posix-handoff',
      channelSelectable: true,
      branch: 'main'
    })
    render(<AboutSettings />)

    expect(screen.getByText(about.detailsLabel)).toBeTruthy()
    expect(screen.getByText(`${about.main} (main)`)).toBeTruthy()
    expect(screen.queryByRole('button', { name: about.main })).toBeNull()
    expect(screen.queryByRole('button', { name: about.stable })).toBeNull()
    expect(screen.queryByText(about.title)).toBeNull()
    expect(setUpdateChannel).not.toHaveBeenCalled()
  })

  it('keeps commit-build and backend update status out of About', (): void => {
    const message = "This build doesn't get updates. Ask the developer who gave it to you for a new build."
    $connection.set(connection('remote'))
    $desktopVersion.set({ ...$desktopVersion.get()!, source: 'commit-build' })
    $updateStatus.set({ supported: false, mechanism: 'external', reason: 'commit-build', message })
    $backendUpdateStatus.set({ supported: true, behind: 3 })
    render(<AboutSettings />)

    expect(screen.getByText(en.updates.versionDetailsInstallId)).toBeTruthy()
    expect(screen.queryByText(message)).toBeNull()
    expect(screen.queryByRole('button', { name: en.updates.checkNow })).toBeNull()
    expect(screen.queryByRole('button', { name: en.updates.updateNow })).toBeNull()
    expect(startActiveUpdate).not.toHaveBeenCalled()
    expect(checkBackendUpdates).not.toHaveBeenCalled()
  })

  it('does not expose fresh-check controls for either update target', (): void => {
    $connection.set(connection('remote'))
    render(<AboutSettings />)

    expect(screen.queryAllByRole('button', { name: en.updates.checkNow })).toHaveLength(0)
    expect(checkUpdates).not.toHaveBeenCalled()
    expect(checkBackendUpdates).not.toHaveBeenCalled()
    expect(startActiveUpdate).not.toHaveBeenCalled()
    expect(refreshDesktopVersion).toHaveBeenCalledTimes(1)
  })
})
