import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setApiRequestConnection, setApiRequestProfile } from '@/api/client'
import type { DesktopUpdateStatus, DesktopVersionInfo } from '@/global'
import { en } from '@/i18n/en'

const storage = new Map<string, string>()

vi.mock('@/lib/storage', () => ({
  persistBoolean: (key: string, value: boolean) => {
    storage.set(key, String(value))
  },
  persistString: (key: string, value: null | string) => {
    if (value === null) {
      storage.delete(key)
    } else {
      storage.set(key, value)
    }
  },
  // store/session persists its exact owner hints through the JSON helpers.
  readJson: (key: string) => {
    const value = storage.get(key)

    try {
      return value === undefined ? null : JSON.parse(value)
    } catch {
      return null
    }
  },
  writeJson: (key: string, value: unknown) => {
    if (value === null) {
      storage.delete(key)
    } else {
      storage.set(key, JSON.stringify(value))
    }
  },
  storedBoolean: (key: string, fallback: boolean) => {
    const value = storage.get(key)

    return value === undefined ? fallback : value === 'true'
  },
  storedString: (key: string) => storage.get(key) ?? null
}))

const notifySpy = vi.fn()
const dismissSpy = vi.fn()

vi.mock('@/store/notifications', () => ({
  notify: (...args: unknown[]) => notifySpy(...args),
  dismissNotification: (...args: unknown[]) => dismissSpy(...args)
}))

// updates.ts reads the connections registry (multi-target gating + the
// everything-flow fan-out). Mock the store shallowly: the real module drags in
// the profile/gateway-switch graph, which is far heavier than these tests need.
const { atom: registryAtom } = await import('nanostores')
const $mockConnectionsRegistry = registryAtom<unknown>(null)

vi.mock('@/store/connections', () => ({
  $connectionsRegistry: $mockConnectionsRegistry,
  refreshConnectionsRegistry: () => Promise.resolve($mockConnectionsRegistry.get())
}))

const checkHermesUpdateSpy = vi.fn()
const updateHermesSpy = vi.fn()
const getActionStatusSpy = vi.fn()

vi.mock('@/hermes', () => ({
  checkHermesUpdate: (...args: unknown[]) => checkHermesUpdateSpy(...args),
  updateHermes: (...args: unknown[]) => updateHermesSpy(...args),
  getActionStatus: (...args: unknown[]) => getActionStatusSpy(...args)
}))

// A successful backend apply must nudge the gateway reconnect handler — the
// update restarted the gateway process, and over tunnels the old socket dies
// without a close event (users force-quit to recover). Mock the tiny registry
// module so the assertion is direct.
const reconnectGatewaySpy = vi.fn().mockResolvedValue(undefined)

vi.mock('@/store/gateway-reconnect', () => ({
  reconnectGateway: (...args: unknown[]) => reconnectGatewaySpy(...args)
}))

const {
  refreshDesktopVersion,
  $desktopVersion,
  maybeNotifyUpdateAvailable,
  checkBackendUpdates,
  checkUpdates,
  $backendUpdateStatus,
  $backendUpdateChecking,
  mapBackendCheck,
  applyBackendUpdate,
  $backendUpdateApply,
  REQUIRED_BACKEND_CONTRACT,
  reportBackendContract,
  applyUpdates,
  applyEverythingUpdate,
  hasMultipleUpdateTargets,
  openUpdatesWindow,
  startActiveUpdate,
  $updateApply,
  $updateChecking,
  $updateEverything,
  $updateOverlayOpen,
  $updateOverlayTarget,
  requestActiveUpdate,
  resetUpdateApplyState,
  startUpdatePoller,
  stopUpdatePoller,
  $updateStatus,
  BACKGROUND_UPDATE_CHECK_MS
} = await import('./updates')

const { CANONICAL_GATEWAY_PROTOCOL } = await import('@/api/canonical-protocol')
const { setConnection } = await import('./session')

const registryOf = (ids: string[]) => ({
  version: 2,
  primary: ids[0] ?? 'local',
  secureTokenStorage: true,
  connections: ids.map(id => ({ id, kind: id === 'local' ? 'local' : 'remote', label: id }))
})

const status = (over: Partial<DesktopUpdateStatus> = {}): DesktopUpdateStatus => ({
  supported: true,
  behind: 3,
  targetSha: 'sha-a',
  fetchedAt: 0,
  ...over
})

const lastToast = () => notifySpy.mock.calls.at(-1)?.[0] as { action: { onClick: () => void }; onDismiss: () => void }

const setRemote = (on: boolean) =>
  setConnection({
    baseUrl: 'http://box:9119',
    isFullscreen: false,
    mode: on ? 'remote' : 'local',
    nativeOverlayWidth: 0,
    token: 't',
    wsUrl: 'ws://box:9119',
    logs: [],
    windowButtonPosition: null
  })

describe('gateway version refresh', () => {
  afterEach(() => {
    setApiRequestConnection(null)
    setApiRequestProfile(null)
    $desktopVersion.set(null)
  })

  it('requests the active gateway and does not publish a previous connection reply', async () => {
    setRemote(true)
    setApiRequestConnection('remote-box')
    setApiRequestProfile('work')

    const version: DesktopVersionInfo = {
      appVersion: '4.5.6',
      electronVersion: '40',
      nodeVersion: '26',
      platform: 'win32',
      hermesRoot: ''
    }

    const getVersion = vi.fn().mockResolvedValue(version)
    const previous = window.hermesDesktop
    window.hermesDesktop = { ...previous, getVersion }

    try {
      expect(await refreshDesktopVersion()).toEqual(version)
      expect(getVersion).toHaveBeenCalledWith({ connectionId: 'remote-box', profile: 'work' })
      expect($desktopVersion.get()?.appVersion).toBe('4.5.6')
      let finish!: (value: DesktopVersionInfo) => void
      getVersion.mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finish = resolve
          })
      )
      const pending = refreshDesktopVersion()
      setRemote(false)
      $desktopVersion.set(null)
      finish(version)
      expect(await pending).toBeNull()
      expect($desktopVersion.get()).toBeNull()
    } finally {
      window.hermesDesktop = previous
    }
  })
})

describe('maybeNotifyUpdateAvailable', () => {
  beforeEach(() => {
    storage.clear()
    notifySpy.mockClear()
    vi.useRealTimers()
  })

  it('shows when an update is available and not snoozed', () => {
    maybeNotifyUpdateAvailable(status())
    expect(notifySpy).toHaveBeenCalledTimes(1)
  })

  it('stays quiet for new commits once the toast was closed', () => {
    maybeNotifyUpdateAvailable(status())
    lastToast().onDismiss() // user closes it → cooldown starts
    notifySpy.mockClear()

    // A different commit lands while still within the cooldown window.
    maybeNotifyUpdateAvailable(status({ targetSha: 'sha-b', behind: 9 }))
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('re-shows once the cooldown elapses', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    maybeNotifyUpdateAvailable(status())
    lastToast().onDismiss()
    notifySpy.mockClear()

    vi.setSystemTime(25 * 60 * 60 * 1000) // > 24h cooldown
    maybeNotifyUpdateAvailable(status({ targetSha: 'sha-b' }))
    expect(notifySpy).toHaveBeenCalledTimes(1)
  })

  it('notifies for a Store update without a commit and never for an unknown check', () => {
    maybeNotifyUpdateAvailable(
      status({ mechanism: 'microsoft-store', targetSha: undefined, behind: null, updateAvailable: true })
    )
    expect(notifySpy).toHaveBeenCalledTimes(1)
    notifySpy.mockClear()
    maybeNotifyUpdateAvailable(
      status({
        mechanism: 'microsoft-store',
        targetSha: undefined,
        behind: null,
        updateAvailable: false,
        error: 'Store unavailable'
      })
    )
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('does nothing when already up to date', () => {
    maybeNotifyUpdateAvailable(status({ behind: 0 }))
    expect(notifySpy).not.toHaveBeenCalled()
  })

  // FAIL-BEFORE (#C19): a shallow installer clone reports behind:null + updateAvailable
  // (exact count unknowable without a merge-base). The guard treated null as 0
  // and silently swallowed the notification entirely.
  it('still notifies when the exact behind count is unknown', () => {
    maybeNotifyUpdateAvailable(status({ behind: null, updateAvailable: true }))
    expect(notifySpy).toHaveBeenCalledTimes(1)
  })

  // FAIL-BEFORE (C19): an App Installer check legitimately carries no
  // targetSha — the OS reports availability against the .appinstaller feed,
  // so there is no commit identity to name. Requiring targetSha made the
  // mechanism-specific App Installer toast unreachable forever.
  it('notifies for an App Installer check even though it has no targetSha', () => {
    maybeNotifyUpdateAvailable(
      status({
        behind: null,
        currentVersion: '0.19.0',
        mechanism: 'app-installer',
        targetSha: undefined,
        updateAvailable: true
      })
    )

    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect(notifySpy.mock.calls[0]?.[0]).toMatchObject({ message: en.notifications.updateReadyMessageAppInstaller })
  })

  // A native macOS (electron-updater) check has no commit to name either: its
  // target identity is the release tag. Requiring targetSha silenced every
  // background notification for non-channel macOS builds.
  it('notifies for a native macOS check that names its target by release tag', () => {
    maybeNotifyUpdateAvailable(
      status({
        behind: null,
        currentVersion: '0.19.0',
        latestTag: 'v0.20.0',
        mechanism: 'electron-updater',
        targetSha: undefined,
        updateAvailable: true
      })
    )

    expect(notifySpy).toHaveBeenCalledTimes(1)
  })

  // Eligibility stays mechanism-specific: a git-style check must still prove
  // there is a target commit before the toast fires — never a made-up SHA.
  it('stays quiet for a git-style check that names no target commit', () => {
    maybeNotifyUpdateAvailable(status({ targetSha: undefined }))
    expect(notifySpy).not.toHaveBeenCalled()
  })
})

describe('reportBackendContract', () => {
  beforeEach(() => {
    storage.clear()
    notifySpy.mockClear()
    dismissSpy.mockClear()
    vi.useRealTimers()
  })

  it('dismisses the toast when the backend meets the contract', () => {
    reportBackendContract(REQUIRED_BACKEND_CONTRACT)
    expect(dismissSpy).toHaveBeenCalledWith('backend-contract-skew')
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('accepts only the matching canonical gateway protocol without claiming the legacy contract', () => {
    reportBackendContract(undefined, CANONICAL_GATEWAY_PROTOCOL)
    expect(dismissSpy).toHaveBeenCalledWith('backend-contract-skew')
    expect(notifySpy).not.toHaveBeenCalled()

    reportBackendContract(undefined, 'hermes-gateway-v0')
    expect(notifySpy).toHaveBeenCalledTimes(1)

    reportBackendContract(Number.MAX_SAFE_INTEGER, 'hermes-gateway-v0')
    expect(notifySpy).toHaveBeenCalledTimes(2)
  })

  it('warns when the backend is behind (or reports no contract)', () => {
    reportBackendContract(undefined)
    expect(notifySpy).toHaveBeenCalledTimes(1)
    reportBackendContract(1)
    expect(notifySpy).toHaveBeenCalledTimes(2)
  })

  it('stays quiet on later session opens once the user closed it', () => {
    reportBackendContract(1)
    lastToast().onDismiss() // user closes it → cooldown starts
    notifySpy.mockClear()

    // Opening another pre-existing session re-runs the check within cooldown.
    reportBackendContract(1)
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('reminds again after the cooldown elapses', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    reportBackendContract(1)
    lastToast().onDismiss()
    notifySpy.mockClear()

    vi.setSystemTime(25 * 60 * 60 * 1000) // > 24h cooldown
    reportBackendContract(1)
    expect(notifySpy).toHaveBeenCalledTimes(1)
  })

  it('clears the snooze once the backend catches up, so a regression warns again', () => {
    reportBackendContract(1)
    lastToast().onDismiss() // user closes it → cooldown starts
    notifySpy.mockClear()

    reportBackendContract(REQUIRED_BACKEND_CONTRACT) // backend updated → satisfied, snooze cleared
    reportBackendContract(5) // a later regression must warn immediately
    expect(notifySpy).toHaveBeenCalledTimes(1)
  })

  it('warns when the GUI is older than the backend (contract ahead of this build)', () => {
    reportBackendContract(REQUIRED_BACKEND_CONTRACT + 1)
    // The backend-older toast must not fire — this is the reverse direction.
    expect(dismissSpy).toHaveBeenCalledWith('backend-contract-skew')
    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect(notifySpy.mock.calls[0]?.[0]).toMatchObject({ id: 'gui-contract-skew', kind: 'warning' })
  })

  it('gui-skew warning snoozes on close and reminds after the cooldown', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    reportBackendContract(REQUIRED_BACKEND_CONTRACT + 1)
    lastToast().onDismiss() // user closes it → cooldown starts
    notifySpy.mockClear()

    reportBackendContract(REQUIRED_BACKEND_CONTRACT + 1) // another session open within the cooldown
    expect(notifySpy).not.toHaveBeenCalled()

    vi.setSystemTime(25 * 60 * 60 * 1000) // > 24h cooldown
    reportBackendContract(REQUIRED_BACKEND_CONTRACT + 1)
    expect(notifySpy).toHaveBeenCalledTimes(1)
  })

  it('clears the gui-skew toast + snooze once versions align, so a later skew warns again', () => {
    reportBackendContract(REQUIRED_BACKEND_CONTRACT + 1)
    lastToast().onDismiss()
    notifySpy.mockClear()

    reportBackendContract(REQUIRED_BACKEND_CONTRACT) // GUI updated (or backend rolled back) → aligned
    expect(dismissSpy).toHaveBeenCalledWith('gui-contract-skew')

    reportBackendContract(REQUIRED_BACKEND_CONTRACT + 1) // a later skew must warn immediately
    expect(notifySpy).toHaveBeenCalledTimes(1)
  })
})

describe('checkBackendUpdates and backend status mapping', () => {
  beforeEach(() => {
    storage.clear()
    notifySpy.mockClear()
    checkHermesUpdateSpy.mockReset()
    $backendUpdateStatus.set(null)
    $backendUpdateChecking.set(false)
    vi.useRealTimers()
  })

  it('maps the backend response without probing Hermes or replacing cached state on official checks', async (): Promise<void> => {
    const mapped = mapBackendCheck({
      install_method: 'git',
      current_version: '0.16.0',
      behind: 2,
      update_available: true,
      can_apply: true,
      update_command: 'hermes update',
      message: null,
      commits: [{ sha: 'abc1234', summary: 'feat: x', author: 'a', at: 1 }]
    })

    expect(mapped.behind).toBe(2)
    expect(mapped.updateAvailable).toBe(true)
    expect(mapped.commits?.[0]?.sha).toBe('abc1234')
    expect(mapped.supported).toBe(true)

    setRemote(true)
    const cached = status({ behind: 7, commits: mapped.commits })
    $backendUpdateStatus.set(cached)
    const result = await checkBackendUpdates()
    const forcedResult = await checkBackendUpdates({ force: true })

    expect(checkHermesUpdateSpy).not.toHaveBeenCalled()
    expect(result).toBe(cached)
    expect(forcedResult).toBe(cached)
    expect($backendUpdateStatus.get()).toBe(cached)
    expect($backendUpdateChecking.get()).toBe(false)
  })

  it('preserves backend update_available when the backend cannot count commits', () => {
    const result = mapBackendCheck({
      install_method: 'nixos',
      current_version: '0.16.0',
      behind: -1,
      update_available: true,
      can_apply: false,
      update_command: '',
      message: 'Update available.'
    })

    // behind: -1 is the producer's "update available, count unknown" sentinel;
    // DesktopUpdateStatus carries it as null, never a literal number.
    expect(result.behind).toBeNull()
    expect(result.updateAvailable).toBe(true)
    expect(result.targetSha).toBe('backend:0.16.0')
  })

  it('honours can_apply=false (docker/nix): not supported, carries message', () => {
    const result = mapBackendCheck({
      install_method: 'docker',
      current_version: '0.16.0',
      behind: null,
      update_available: false,
      can_apply: false,
      update_command: 'docker pull ...',
      message: 'Docker images are immutable.'
    })

    expect(result.supported).toBe(false)
    expect(result.message).toBe('Docker images are immutable.')
  })

  it('is inert in local mode and does not fabricate backend state', async () => {
    setRemote(false)
    await checkBackendUpdates()
    await checkBackendUpdates({ force: true })

    expect(checkHermesUpdateSpy).not.toHaveBeenCalled()
    expect($backendUpdateStatus.get()).toBeNull()
    expect($backendUpdateChecking.get()).toBe(false)
  })
})

// The ⌘K "Update Hermes" row. It used to call applyBackendUpdate() flat, which
// in local mode aimed at the backend checkout instead of the client and, with
// no overlay open, showed nothing at all.
describe('requestActiveUpdate', () => {
  const applyClientMock = vi.fn()
  const checkClientMock = vi.fn()

  beforeEach(() => {
    storage.clear()
    notifySpy.mockClear()
    dismissSpy.mockClear()
    applyClientMock.mockReset().mockResolvedValue({ ok: true, handedOff: true })
    checkClientMock.mockReset().mockResolvedValue(status({ behind: 0 }))
    updateHermesSpy.mockReset().mockResolvedValue({ ok: true, name: 'update' })
    checkHermesUpdateSpy.mockReset().mockResolvedValue({
      install_method: 'git',
      current_version: '0.4.2',
      behind: 0,
      update_available: false,
      can_apply: true,
      update_command: null,
      message: null
    })
    getActionStatusSpy.mockReset().mockResolvedValue({ lines: [], running: false, exit_code: 0 })
    resetUpdateApplyState()
    $updateStatus.set(null)
    $backendUpdateStatus.set(null)
    $updateOverlayOpen.set(false)
    ;(globalThis as unknown as { window: unknown }).window = {
      hermesDesktop: { updates: { apply: applyClientMock, check: checkClientMock } }
    }
    vi.useRealTimers()
  })

  afterEach(async () => {
    // Drain any backend apply this suite kicked off: applyBackendUpdate() now
    // memoizes the in-flight run, so a dangling promise here would be handed
    // to the next suite's tests instead of a fresh run.
    await vi.waitFor(() => expect($backendUpdateApply.get().applying).toBe(false), { timeout: 5000 })
    // Remote-mode rows now route through the everything-flow; drain its tail
    // (fan-out + client check) so it can't bleed into the next test.
    await vi.waitFor(() => expect($updateEverything.get().running).toBe(false), { timeout: 5000 })
    setRemote(false)
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('does not apply a cached CLIENT update in local mode or contact either updater', () => {
    setRemote(false)
    const cached = status({ behind: 3 })
    $updateStatus.set(cached)

    requestActiveUpdate()

    expect(applyClientMock).not.toHaveBeenCalled()
    expect(checkClientMock).not.toHaveBeenCalled()
    expect(updateHermesSpy).not.toHaveBeenCalled()
    expect($updateStatus.get()).toBe(cached)
    expect($updateOverlayOpen.get()).toBe(false)
  })

  it('does not apply a cached BACKEND update in remote mode or contact either updater', () => {
    setRemote(true)
    const cached = status({ behind: 3 })
    $backendUpdateStatus.set(cached)

    requestActiveUpdate()

    expect(updateHermesSpy).not.toHaveBeenCalled()
    expect(applyClientMock).not.toHaveBeenCalled()
    expect(checkClientMock).not.toHaveBeenCalled()
    expect($backendUpdateStatus.get()).toBe(cached)
    expect($updateOverlayOpen.get()).toBe(false)
    expect($updateEverything.get().running).toBe(false)
  })

  it('does not open the overlay or dispatch when updateAvailable replaces a behind count', () => {
    setRemote(false)
    $updateStatus.set(status({ behind: 0, updateAvailable: true }))

    requestActiveUpdate()

    expect($updateOverlayOpen.get()).toBe(false)
    expect(applyClientMock).not.toHaveBeenCalled()
    expect(updateHermesSpy).not.toHaveBeenCalled()
  })

  it('opens the overlay without a bridge check when already current', () => {
    setRemote(false)
    const cached = status({ behind: 0, updateAvailable: false })
    $updateStatus.set(cached)

    requestActiveUpdate()

    expect($updateOverlayOpen.get()).toBe(true)
    expect(applyClientMock).not.toHaveBeenCalled()
    expect(checkClientMock).not.toHaveBeenCalled()
    expect(updateHermesSpy).not.toHaveBeenCalled()
    expect($updateStatus.get()).toBe(cached)
  })

  it('does not apply a remote update whose exact commit count is unknown', () => {
    setRemote(true)
    const cached = status({ behind: 0, updateAvailable: true })
    $backendUpdateStatus.set(cached)

    requestActiveUpdate()

    expect(updateHermesSpy).not.toHaveBeenCalled()
    expect(checkHermesUpdateSpy).not.toHaveBeenCalled()
    expect($backendUpdateStatus.get()).toBe(cached)
    expect($updateOverlayOpen.get()).toBe(false)
  })

  it('shows the refusal message, not a fake command, when the backend has no command to run', async () => {
    setRemote(true)
    updateHermesSpy.mockResolvedValue({
      ok: false,
      name: 'hermes-update',
      error: 'dashboard_update_managed_externally',
      message: 'Hermes updates are managed outside this dashboard in containerized environments.',
      update_command: ''
    })

    const result = await applyBackendUpdate()

    expect(result.manual).toBe(true)
    expect(result.command).toBeUndefined()
    expect($backendUpdateApply.get().stage).toBe('manual')
    expect($backendUpdateApply.get().command).toBeNull()
    expect($backendUpdateApply.get().message).toContain('managed outside this dashboard')
  })

  it('falls back to `hermes update` only when an older backend omits update_command', async () => {
    setRemote(true)
    updateHermesSpy.mockResolvedValue({ ok: false, name: 'hermes-update', message: 'Run it yourself.' })

    await applyBackendUpdate()

    expect($backendUpdateApply.get().command).toBe('hermes update')
  })
})

// Surface-bound update entry points. A surface that displays ONE target's
// status must act on that target: the overlay has no target switcher, so
// inheriting the connection-mode default silently pointed the user at the
// other machine. This is what left a Mac desktop on a months-old build while
// its remote Linux backend updated fine, with no error anywhere (#70266).
describe('explicit update targets', () => {
  const applyClientMock = vi.fn()
  const checkClientMock = vi.fn()

  beforeEach(() => {
    storage.clear()
    notifySpy.mockClear()
    dismissSpy.mockClear()
    applyClientMock.mockReset().mockResolvedValue({ ok: true, handedOff: true })
    checkClientMock.mockReset().mockResolvedValue(status({ behind: 4, updateAvailable: true }))
    updateHermesSpy.mockReset().mockResolvedValue({ ok: true, name: 'update' })
    checkHermesUpdateSpy.mockReset().mockResolvedValue({
      install_method: 'git',
      current_version: '0.4.2',
      behind: 0,
      update_available: false,
      can_apply: true,
      update_command: null,
      message: null
    })
    getActionStatusSpy.mockReset().mockResolvedValue({ lines: [], running: false, exit_code: 0 })
    resetUpdateApplyState()
    $updateStatus.set(null)
    $backendUpdateStatus.set(null)
    $updateOverlayOpen.set(false)
    $updateOverlayTarget.set('backend')
    $mockConnectionsRegistry.set(null)
    setRemote(true)
    ;(globalThis as unknown as { window: unknown }).window = {
      hermesDesktop: { updates: { apply: applyClientMock, check: checkClientMock } }
    }
    vi.useRealTimers()
  })

  afterEach(async () => {
    await vi.waitFor(() => expect($updateEverything.get().running).toBe(false), { timeout: 5000 })
    await vi.waitFor(() => expect($backendUpdateApply.get().applying).toBe(false), { timeout: 5000 })
    setRemote(false)
    delete (globalThis as unknown as { window?: unknown }).window
  })

  // The macOS "Check for Updates…" app-menu item — the OS-standard affordance
  // for updating THIS app — routes here via `hermes:open-updates`.
  it('opens the client overlay on an explicit client target without checking the bridge', () => {
    openUpdatesWindow('client')

    expect($updateOverlayTarget.get()).toBe('client')
    expect($updateOverlayOpen.get()).toBe(true)
    expect(checkClientMock).not.toHaveBeenCalled()
    expect(checkHermesUpdateSpy).not.toHaveBeenCalled()
  })

  it('defaults to the connected machine without probing either update channel', () => {
    openUpdatesWindow()

    expect($updateOverlayTarget.get()).toBe('backend')
    expect($updateOverlayOpen.get()).toBe(true)
    expect(checkHermesUpdateSpy).not.toHaveBeenCalled()
    expect(checkClientMock).not.toHaveBeenCalled()
  })

  it('keeps an explicit client start inert without changing target or applying', () => {
    startActiveUpdate('client')

    expect($updateOverlayTarget.get()).toBe('backend')
    expect($updateOverlayOpen.get()).toBe(false)
    expect(applyClientMock).not.toHaveBeenCalled()
    expect(checkClientMock).not.toHaveBeenCalled()
    expect(updateHermesSpy).not.toHaveBeenCalled()
    expect($updateEverything.get().running).toBe(false)
  })

  it('keeps the generic target-less start inert instead of entering the everything-flow', () => {
    const cached = status({ behind: 3 })
    $backendUpdateStatus.set(cached)

    startActiveUpdate()

    expect(updateHermesSpy).not.toHaveBeenCalled()
    expect(applyClientMock).not.toHaveBeenCalled()
    expect($backendUpdateStatus.get()).toBe(cached)
    expect($updateEverything.get().running).toBe(false)
    expect($updateOverlayOpen.get()).toBe(false)
  })

  // A toast raised by the CLIENT check must open the client overlay: the user
  // was told the app is behind, so landing them on the backend's (current)
  // status reads as the update having vanished.
  it('opens the overlay for the target whose status raised the toast', () => {
    maybeNotifyUpdateAvailable(status(), 'client')
    lastToast().action.onClick()
    expect($updateOverlayTarget.get()).toBe('client')

    storage.clear() // clear the snooze the click just set
    maybeNotifyUpdateAvailable(status({ targetSha: 'sha-b' }), 'backend')
    lastToast().action.onClick()
    expect($updateOverlayTarget.get()).toBe('backend')
  })
})

// The everything-flow: on multi-target installs (remote mode / multi-connection
// registry) "update" must mean every machine — active backend, other registered
// sources via the Electron fan-out, and the client LAST. Before this flow,
// every remote-mode affordance updated only the backend, so users "updated"
// forever while the desktop app itself stayed weeks stale (the Aug 2026
// mac-app-on-v0.20.0 report).
describe('applyEverythingUpdate', () => {
  const applyClientMock = vi.fn()
  const checkClientMock = vi.fn()
  const updateAllMock = vi.fn()

  beforeEach(() => {
    storage.clear()
    notifySpy.mockClear()
    dismissSpy.mockClear()
    applyClientMock.mockReset().mockResolvedValue({ ok: true, handedOff: true })
    checkClientMock.mockReset().mockResolvedValue(status({ behind: 0, updateAvailable: false }))
    updateAllMock.mockReset().mockResolvedValue({ ok: true, results: [] })
    updateHermesSpy.mockReset().mockResolvedValue({ ok: true, name: 'update' })
    checkHermesUpdateSpy.mockReset().mockResolvedValue({
      install_method: 'git',
      current_version: '0.4.2',
      behind: 0,
      update_available: false,
      can_apply: true,
      update_command: null,
      message: null
    })
    getActionStatusSpy.mockReset().mockResolvedValue({ lines: [], running: false, exit_code: 0 })
    resetUpdateApplyState()
    $updateStatus.set(null)
    $backendUpdateStatus.set(null)
    $updateOverlayOpen.set(false)
    $mockConnectionsRegistry.set(null)
    ;(globalThis as unknown as { window: unknown }).window = {
      hermesDesktop: {
        updates: { apply: applyClientMock, check: checkClientMock },
        connections: { updateAll: updateAllMock }
      }
    }
    vi.useRealTimers()
  })

  afterEach(async () => {
    await vi.waitFor(() => expect($updateEverything.get().running).toBe(false), { timeout: 5000 })
    await vi.waitFor(() => expect($backendUpdateApply.get().applying).toBe(false), { timeout: 5000 })
    setRemote(false)
    $mockConnectionsRegistry.set(null)
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('gates on multiple targets: remote mode OR a multi-connection registry', () => {
    setRemote(false)
    $mockConnectionsRegistry.set(null)
    expect(hasMultipleUpdateTargets()).toBe(false)

    setRemote(true)
    expect(hasMultipleUpdateTargets()).toBe(true)

    setRemote(false)
    $mockConnectionsRegistry.set(registryOf(['local', 'vps']))
    expect(hasMultipleUpdateTargets()).toBe(true)
  })

  it('remote mode: updates the backend, then uses a cached behind client status without a bridge re-check', async () => {
    setRemote(true)
    $backendUpdateStatus.set(status({ behind: 3 }))
    $updateStatus.set(status({ behind: 7, updateAvailable: true }))
    checkClientMock.mockResolvedValue(status({ behind: 0, updateAvailable: false }))

    await applyEverythingUpdate()

    expect(updateHermesSpy).toHaveBeenCalledTimes(1)
    expect(checkClientMock).not.toHaveBeenCalled()
    expect(applyClientMock).toHaveBeenCalledTimes(1)
  })

  it('remote mode: skips the client apply when the client is already current', async () => {
    setRemote(true)
    $backendUpdateStatus.set(status({ behind: 3 }))
    checkClientMock.mockResolvedValue(status({ behind: 0, updateAvailable: false }))

    await applyEverythingUpdate()

    expect(updateHermesSpy).toHaveBeenCalledTimes(1)
    expect(checkClientMock).not.toHaveBeenCalled()
    expect(applyClientMock).not.toHaveBeenCalled()
  })

  it('fans out to other registered connections, excluding local and the active backend', async () => {
    setRemote(true)
    $mockConnectionsRegistry.set(registryOf(['local', 'vps', 'homelab']))
    $backendUpdateStatus.set(status({ behind: 1 }))

    await applyEverythingUpdate()

    expect(updateAllMock).toHaveBeenCalledTimes(1)
    const options = updateAllMock.mock.calls[0]?.[0] as { excludeIds: string[] }
    expect(options.excludeIds).toContain('local')
  })

  it('local mode with a multi-connection registry: fans out and updates the client, no active-backend leg', async () => {
    setRemote(false)
    $mockConnectionsRegistry.set(registryOf(['local', 'vps']))
    checkClientMock.mockResolvedValue(status({ behind: 2, updateAvailable: true }))
    $updateStatus.set(status({ behind: 2, updateAvailable: true }))

    await applyEverythingUpdate()

    expect(updateHermesSpy).not.toHaveBeenCalled()
    expect(updateAllMock).toHaveBeenCalledTimes(1)
    expect(checkClientMock).not.toHaveBeenCalled()
    expect(applyClientMock).toHaveBeenCalledTimes(1)
  })

  it('a failed backend leg does not strand the fan-out or a cached behind client', async () => {
    setRemote(true)
    $mockConnectionsRegistry.set(registryOf(['local', 'vps']))
    $updateStatus.set(status({ behind: 4, updateAvailable: true }))
    updateHermesSpy.mockRejectedValue(new Error('backend gone'))
    checkClientMock.mockResolvedValue(status({ behind: 0, updateAvailable: false }))

    await applyEverythingUpdate()

    expect(updateAllMock).toHaveBeenCalledTimes(1)
    expect(checkClientMock).not.toHaveBeenCalled()
    expect(applyClientMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces per-row fan-out outcomes as notifications', async () => {
    setRemote(false)
    $mockConnectionsRegistry.set(registryOf(['local', 'vps', 'dead-box']))
    updateAllMock.mockResolvedValue({
      ok: true,
      results: [
        { connectionId: 'vps', label: 'vps', kind: 'remote', ok: true, detail: 'update started' },
        { connectionId: 'dead-box', label: 'dead-box', kind: 'remote', ok: false, error: 'ECONNREFUSED' }
      ]
    })

    await applyEverythingUpdate()

    const titles = notifySpy.mock.calls.map(call => (call[0] as { title?: string }).title)
    expect(titles).toContain('vps')
    expect(titles).toContain('dead-box')
  })

  it('memoizes the in-flight run so a double click cannot double-dispatch', async () => {
    setRemote(false)
    $mockConnectionsRegistry.set(registryOf(['local', 'vps']))

    const first = applyEverythingUpdate()
    const second = applyEverythingUpdate()

    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(updateAllMock).toHaveBeenCalledTimes(1)
  })

  it('uses the cached client status rather than performing a live re-check', async () => {
    setRemote(true)
    $backendUpdateStatus.set(status({ behind: 3 }))
    $updateStatus.set(status({ behind: 7, updateAvailable: true }))
    checkClientMock.mockResolvedValue(status({ behind: 0, updateAvailable: false }))

    await applyEverythingUpdate()

    expect(checkClientMock).not.toHaveBeenCalled()
    expect(applyClientMock).toHaveBeenCalledTimes(1)
  })

  it('does not turn an unavailable client bridge into a fresh error status', async () => {
    setRemote(true)
    $backendUpdateStatus.set(status({ behind: 3 }))
    const cached = status({ behind: 7, updateAvailable: true })
    $updateStatus.set(cached)
    checkClientMock.mockRejectedValue(new Error('bridge gone'))

    await applyEverythingUpdate()

    expect(checkClientMock).not.toHaveBeenCalled()
    expect($updateStatus.get()).toBe(cached)
    expect(applyClientMock).toHaveBeenCalledTimes(1)
  })

  it('requestActiveUpdate does not enter the everything-flow when either cached target is behind', async () => {
    setRemote(true)
    $backendUpdateStatus.set(status({ behind: 0, updateAvailable: false }))
    $updateStatus.set(status({ behind: 5, updateAvailable: true }))

    requestActiveUpdate()
    await Promise.resolve()

    expect(applyClientMock).not.toHaveBeenCalled()
    expect(checkClientMock).not.toHaveBeenCalled()
    expect(updateHermesSpy).not.toHaveBeenCalled()
    expect(updateAllMock).not.toHaveBeenCalled()
    expect($updateEverything.get().running).toBe(false)
    expect($updateOverlayOpen.get()).toBe(false)
  })
})

// Post-backend-update client nudge: a successful backend apply re-checks the
// CLIENT and warns when it is still behind, with a one-click client update.
describe('client nudge after a backend update', () => {
  const applyClientMock = vi.fn()
  const checkClientMock = vi.fn()

  beforeEach(() => {
    storage.clear()
    notifySpy.mockClear()
    dismissSpy.mockClear()
    applyClientMock.mockReset().mockResolvedValue({ ok: true, handedOff: true })
    checkClientMock.mockReset()
    updateHermesSpy.mockReset().mockResolvedValue({ ok: true, name: 'update' })
    checkHermesUpdateSpy.mockReset().mockResolvedValue({
      install_method: 'git',
      current_version: '0.4.2',
      behind: 0,
      update_available: false,
      can_apply: true,
      update_command: null,
      message: null
    })
    getActionStatusSpy.mockReset().mockResolvedValue({ lines: [], running: false, exit_code: 0 })
    resetUpdateApplyState()
    $updateStatus.set(null)
    $backendUpdateStatus.set(null)
    $mockConnectionsRegistry.set(null)
    setRemote(true)
    ;(globalThis as unknown as { window: unknown }).window = {
      hermesDesktop: { updates: { apply: applyClientMock, check: checkClientMock } }
    }
    vi.useRealTimers()
  })

  afterEach(async () => {
    await vi.waitFor(() => expect($backendUpdateApply.get().applying).toBe(false), { timeout: 5000 })
    setRemote(false)
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('warns from the cached client status after the backend caught up, without a bridge check', async () => {
    $updateStatus.set(status({ behind: 6, updateAvailable: true }))
    checkClientMock.mockResolvedValue(status({ behind: 0, updateAvailable: false }))

    await applyBackendUpdate()

    await vi.waitFor(() => {
      const ids = notifySpy.mock.calls.map(call => (call[0] as { id?: string }).id)
      expect(ids).toContain('client-update-after-backend')
    })
    expect(checkClientMock).not.toHaveBeenCalled()
  })

  it('stays silent when the client is already current', async () => {
    checkClientMock.mockResolvedValue(status({ behind: 0, updateAvailable: false }))

    await applyBackendUpdate()

    // Give the fire-and-forget nudge a beat to (not) fire.
    await new Promise(resolve => setTimeout(resolve, 50))
    const ids = notifySpy.mock.calls.map(call => (call[0] as { id?: string }).id)
    expect(ids).not.toContain('client-update-after-backend')
  })

  it('nudges a gateway reconnect after the backend caught up (tunnel socket may be dead)', async () => {
    checkClientMock.mockResolvedValue(status({ behind: 0, updateAvailable: false }))
    reconnectGatewaySpy.mockClear()

    await applyBackendUpdate()

    expect(reconnectGatewaySpy).toHaveBeenCalledTimes(1)
  })

  it('does not nudge a reconnect when the backend apply failed', async () => {
    reconnectGatewaySpy.mockClear()
    getActionStatusSpy.mockReset().mockResolvedValue({ lines: [], running: false, exit_code: 1 })

    await applyBackendUpdate()

    expect(reconnectGatewaySpy).not.toHaveBeenCalled()
  })
})

describe('applyUpdates terminal state', () => {
  const applyMock = vi.fn()

  beforeEach(() => {
    storage.clear()
    notifySpy.mockClear()
    dismissSpy.mockClear()
    applyMock.mockReset()
    resetUpdateApplyState()
    $updateOverlayOpen.set(true)
    ;(globalThis as unknown as { window: unknown }).window = {
      hermesDesktop: { updates: { apply: applyMock } }
    }
    vi.useRealTimers()
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('holds the restart view when a relauncher hands off (no close, no toast)', async () => {
    applyMock.mockResolvedValue({ ok: true, handedOff: true })

    const result = await applyUpdates()

    expect(result.handedOff).toBe(true)
    // The detached relauncher will quit + reopen us; keep "applying" until then.
    expect($updateApply.get().applying).toBe(true)
    expect($updateOverlayOpen.get()).toBe(true)
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('does not claim an installation when the Store reports no remaining update', async () => {
    applyMock.mockResolvedValue({ ok: true, updateAvailable: false })
    await applyUpdates()
    expect($updateApply.get().applying).toBe(false)
    expect($updateOverlayOpen.get()).toBe(false)
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('closes the overlay + toasts when updated but not relaunched in place', async () => {
    // The Linux AppImage / dev-run path: backend + GUI updated, no in-place
    // relaunch. Must not strand the overlay on a closeless spinner.
    applyMock.mockResolvedValue({ ok: true, backendUpdated: true })

    await applyUpdates()

    expect($updateOverlayOpen.get()).toBe(false)
    expect($updateApply.get().applying).toBe(false)
    expect($updateApply.get().stage).toBe('idle')
    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect(notifySpy.mock.calls[0]?.[0]).toMatchObject({ kind: 'success' })
  })

  it('lands on a closeable error state when the apply resolves not-ok', async () => {
    applyMock.mockResolvedValue({ ok: false, error: 'rebuild-failed', message: 'rebuild failed' })

    await applyUpdates()

    expect($updateApply.get().applying).toBe(false)
    expect($updateApply.get().stage).toBe('error')
    expect($updateApply.get().error).toBe('rebuild-failed')
  })

  it('keeps the manual command state for CLI installs with no staged updater', async () => {
    applyMock.mockResolvedValue({ ok: true, manual: true, command: 'hermes update' })

    await applyUpdates()

    expect($updateApply.get().stage).toBe('manual')
    expect($updateApply.get().command).toBe('hermes update')
    expect($updateOverlayOpen.get()).toBe(true)
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('lands on the guiSkew terminal state for a GUI/backend skew (AppImage/.deb/.rpm), without claiming a GUI update', async () => {
    // Linux: backend updated, but the running desktop package was NOT replaced.
    // Must NOT toast "loads next launch" — that's the dishonest message #45205
    // guards against. Lands on a closeable guiSkew view instead.
    applyMock.mockResolvedValue({
      ok: true,
      backendUpdated: true,
      guiUpdated: false,
      guiSkew: true,
      message: 'Backend updated, but the desktop app package was not changed.'
    })

    const result = await applyUpdates()

    expect(result.guiUpdated).toBe(false)
    expect($updateApply.get().stage).toBe('guiSkew')
    expect($updateApply.get().applying).toBe(false)
    expect($updateApply.get().message).toMatch(/desktop app package was not changed/)
    // Overlay stays open on a closeable terminal view; no "all set" toast.
    expect($updateOverlayOpen.get()).toBe(true)
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it('lands on a closeable manual-restart state when the rebuilt sandbox blocks auto-relaunch', async () => {
    // Under release/*-unpacked but chrome-sandbox isn't launchable: don't quit
    // into a dead app — keep a working window on a closeable manual state.
    applyMock.mockResolvedValue({
      ok: true,
      backendUpdated: true,
      guiUpdated: false,
      manualRestart: true,
      sandboxBlocked: true,
      message: 'Backend updated. Quit and reopen Hermes to finish.'
    })

    const result = await applyUpdates()

    expect(result.manualRestart).toBe(true)
    expect($updateApply.get().stage).toBe('manual')
    expect($updateApply.get().command).toBeNull()
    expect($updateApply.get().message).toMatch(/Quit and reopen/)
    expect($updateOverlayOpen.get()).toBe(true)
    expect(notifySpy).not.toHaveBeenCalled()
  })
})

describe('applyBackendUpdate recovery', () => {
  beforeEach(() => {
    storage.clear()
    checkHermesUpdateSpy.mockReset()
    updateHermesSpy.mockReset()
    getActionStatusSpy.mockReset()
    $backendUpdateStatus.set(null)
    $backendUpdateApply.set({
      applying: false,
      stage: 'idle',
      message: '',
      percent: null,
      error: null,
      command: null,
      log: []
    })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for the backend to return after the restart drops the connection, then clears the overlay', async () => {
    const actionId = 'd'.repeat(32)
    updateHermesSpy.mockResolvedValue({ action_id: actionId, ok: true, name: 'update', pid: 1 })
    getActionStatusSpy.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce({
      exit_code: null,
      lines: [`=== hermes-update completed ${actionId} ===`],
      name: 'update',
      pid: null,
      running: false
    })

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(5000)
    const result = await promise

    expect(result.ok).toBe(true)
    expect($backendUpdateApply.get().stage).toBe('idle')
    expect($backendUpdateApply.get().applying).toBe(false)
  })

  it('surfaces backend update action log lines while the action is running', async () => {
    const actionId = 'e'.repeat(32)
    updateHermesSpy.mockResolvedValue({ action_id: actionId, ok: true, name: 'update', pid: 1 })
    getActionStatusSpy
      .mockResolvedValueOnce({
        exit_code: null,
        lines: ['Pulling updates...', 'Installing dependencies...'],
        name: 'update',
        pid: 1,
        running: true
      })
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({
        exit_code: null,
        lines: [`=== hermes-update completed ${actionId} ===`],
        name: 'update',
        pid: null,
        running: false
      })

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(1500)

    expect($backendUpdateApply.get().message).toBe('Installing dependencies...')
    expect($backendUpdateApply.get().log.map(entry => entry.message)).toEqual([
      'Pulling updates...',
      'Installing dependencies...'
    ])

    await vi.advanceTimersByTimeAsync(5000)
    await promise
  })

  it('keeps waiting past the old 45-second cutoff while the update action is running', async () => {
    const actionId = 'f'.repeat(32)
    updateHermesSpy.mockResolvedValue({ action_id: actionId, ok: true, name: 'hermes-update', pid: 1 })

    for (let attempt = 0; attempt < 31; attempt += 1) {
      getActionStatusSpy.mockResolvedValueOnce({
        exit_code: null,
        lines: ['=== hermes-update started now ===', `step ${attempt}`],
        name: 'hermes-update',
        pid: 1,
        running: true
      })
    }

    getActionStatusSpy.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce({
      exit_code: null,
      lines: [`=== hermes-update completed ${actionId} ===`],
      name: 'hermes-update',
      pid: null,
      running: false
    })

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(46500)

    expect($backendUpdateApply.get().applying).toBe(true)
    expect($backendUpdateApply.get().stage).toBe('pull')

    await vi.advanceTimersByTimeAsync(5000)
    await expect(promise).resolves.toMatchObject({ ok: true })
  })

  it('treats a successful no-op as complete without waiting for a restart', async () => {
    updateHermesSpy.mockResolvedValue({ ok: true, name: 'hermes-update', pid: 1 })
    getActionStatusSpy.mockResolvedValue({
      exit_code: 0,
      lines: ['stale output from another run', '=== hermes-update started now ===', '✓ Already up to date!'],
      name: 'hermes-update',
      pid: 1,
      running: false
    })

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(1500)
    const result = await promise

    expect(result.ok).toBe(true)
    expect($backendUpdateApply.get().stage).toBe('idle')
  })

  it('treats a successful dependency repair as complete without waiting for a restart', async () => {
    updateHermesSpy.mockResolvedValue({ ok: true, name: 'hermes-update', pid: 1 })
    getActionStatusSpy.mockResolvedValue({
      exit_code: 0,
      lines: ['=== hermes-update started now ===', '✓ Dependencies repaired!', '✓ Update complete!'],
      name: 'hermes-update',
      pid: 1,
      running: false
    })

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(1500)
    await expect(promise).resolves.toMatchObject({ ok: true })
    expect($backendUpdateApply.get().stage).toBe('idle')
  })

  it('trusts the current action exit code without parsing its output', async () => {
    updateHermesSpy.mockResolvedValue({ ok: true, name: 'hermes-update', pid: 1 })
    getActionStatusSpy.mockResolvedValue({
      exit_code: 0,
      lines: ['✓ Already up to date!'],
      name: 'hermes-update',
      pid: 1,
      running: false
    })
    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(1500)
    await expect(promise).resolves.toMatchObject({ ok: true })
    expect(checkHermesUpdateSpy).not.toHaveBeenCalled()
  })

  it('waits for current-action completion proof after the backend restarts', async () => {
    const actionId = 'a'.repeat(32)
    updateHermesSpy.mockResolvedValue({ action_id: actionId, ok: true, name: 'hermes-update', pid: 1 })
    getActionStatusSpy
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({
        exit_code: null,
        lines: ['Update complete!', `=== hermes-update completed ${'c'.repeat(32)} ===`],
        name: 'hermes-update',
        pid: null,
        running: false
      })
      .mockResolvedValueOnce({
        exit_code: null,
        lines: ['Update complete!', `=== hermes-update completed ${actionId} ===`],
        name: 'hermes-update',
        pid: null,
        running: false
      })

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(5000)
    await expect(promise).resolves.toMatchObject({ ok: true })
    expect(checkHermesUpdateSpy).not.toHaveBeenCalled()
  })

  it('accepts its terminal receipt when a verbose update pushes the start marker out of the log tail', async () => {
    const actionId = 'b'.repeat(32)
    updateHermesSpy.mockResolvedValue({ action_id: actionId, ok: true, name: 'hermes-update', pid: 1 })
    getActionStatusSpy.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce({
      exit_code: null,
      lines: ['final build output', 'Update complete!', `=== hermes-update completed ${actionId} ===`],
      name: 'hermes-update',
      pid: null,
      running: false
    })

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(5000)

    await expect(promise).resolves.toMatchObject({ ok: true })
    expect(getActionStatusSpy).toHaveBeenCalledWith('hermes-update', 2000)
  })

  it('proves a pre-action-ID backend reached its requested commit after restart', async () => {
    $backendUpdateStatus.set({
      behind: 2,
      commits: [{ at: 1, author: 'Nous', sha: 'requested-target', summary: 'target' }],
      fetchedAt: 1,
      supported: true,
      targetSha: 'backend:0.18.2',
      updateAvailable: true
    })
    updateHermesSpy.mockResolvedValue({ ok: true, name: 'hermes-update', pid: 1 })
    getActionStatusSpy.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValue({
      exit_code: null,
      lines: ['verbose output', 'Update complete!'],
      name: 'hermes-update',
      pid: null,
      running: false
    })
    checkHermesUpdateSpy
      .mockResolvedValueOnce({
        behind: null,
        can_apply: true,
        commits: [],
        current_version: '0.18.2',
        install_method: 'git',
        message: 'offline',
        update_available: false,
        update_command: 'hermes update'
      })
      .mockResolvedValueOnce({
        behind: 1,
        can_apply: true,
        commits: [{ at: 2, author: 'Nous', sha: 'newer-commit', summary: 'newer' }],
        current_version: '0.18.2',
        install_method: 'git',
        message: null,
        update_available: true,
        update_command: 'hermes update'
      })

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(5000)

    await expect(promise).resolves.toMatchObject({ ok: true })
    expect(checkHermesUpdateSpy).toHaveBeenCalledTimes(2)
  })

  it('proves a fast pre-action-ID packaged update by its changed version', async () => {
    $backendUpdateStatus.set({
      behind: 1,
      commits: [],
      fetchedAt: 1,
      supported: true,
      targetSha: 'backend:0.18.2',
      updateAvailable: true
    })
    updateHermesSpy.mockResolvedValue({ ok: true, name: 'hermes-update', pid: 1 })
    getActionStatusSpy.mockResolvedValue({
      exit_code: null,
      lines: ['verbose output without a retained start marker'],
      name: 'hermes-update',
      pid: null,
      running: false
    })
    checkHermesUpdateSpy.mockResolvedValue({
      behind: -1,
      can_apply: true,
      commits: [],
      current_version: '0.18.3',
      install_method: 'pip',
      message: null,
      update_available: true,
      update_command: 'hermes update'
    })

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(1500)

    await expect(promise).resolves.toMatchObject({ ok: true })
    expect(checkHermesUpdateSpy).toHaveBeenCalledWith(true)
  })

  it('resumes action polling after a transient status failure', async () => {
    updateHermesSpy.mockResolvedValue({ ok: true, name: 'hermes-update', pid: 1 })
    getActionStatusSpy
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({
        exit_code: null,
        lines: ['=== hermes-update started now ===', 'still running'],
        name: 'hermes-update',
        pid: 1,
        running: true
      })
      .mockResolvedValueOnce({
        exit_code: 0,
        lines: ['=== hermes-update started now ===', 'Update complete!'],
        name: 'hermes-update',
        pid: 1,
        running: false
      })

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(5000)
    await expect(promise).resolves.toMatchObject({ ok: true })
    expect(getActionStatusSpy).toHaveBeenCalledTimes(3)
  })

  it('restores the fixed action deadline after reconnecting', async () => {
    updateHermesSpy.mockResolvedValue({ action_id: 'a'.repeat(32), ok: true, name: 'hermes-update', pid: 1 })

    const running = {
      exit_code: null,
      lines: ['still running'],
      name: 'hermes-update',
      pid: 1,
      running: true
    }

    for (let attempt = 0; attempt < 119; attempt += 1) {
      getActionStatusSpy.mockResolvedValueOnce(running)
    }

    getActionStatusSpy.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue(running)

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000 + 1500)

    await expect(promise).resolves.toMatchObject({ error: 'apply-failed', ok: false })
    expect($backendUpdateApply.get().stage).toBe('error')
  })

  it('shares one in-flight update between concurrent apply requests', async () => {
    updateHermesSpy.mockResolvedValue({ ok: true, name: 'hermes-update', pid: 1 })
    getActionStatusSpy.mockResolvedValue({
      exit_code: 0,
      lines: ['=== hermes-update started now ===', '✓ Already up to date!'],
      name: 'hermes-update',
      pid: 1,
      running: false
    })

    const first = applyBackendUpdate()
    const second = applyBackendUpdate()

    expect(second).toBe(first)
    await vi.advanceTimersByTimeAsync(1500)
    await Promise.all([first, second])
    expect(updateHermesSpy).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the update action never reaches a terminal state', async () => {
    updateHermesSpy.mockResolvedValue({ ok: true, name: 'hermes-update', pid: 1 })
    getActionStatusSpy.mockResolvedValue({
      exit_code: null,
      lines: ['=== hermes-update started now ===', 'still running'],
      name: 'hermes-update',
      pid: 1,
      running: true
    })

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000 + 1500)
    await expect(promise).resolves.toMatchObject({ ok: false, error: 'apply-failed' })
    expect($backendUpdateApply.get().stage).toBe('error')
  })

  it('fails immediately when the update action exits nonzero', async () => {
    updateHermesSpy.mockResolvedValue({ ok: true, name: 'hermes-update', pid: 1 })
    getActionStatusSpy.mockResolvedValue({
      exit_code: 1,
      lines: ['=== hermes-update started now ===', 'update failed'],
      name: 'hermes-update',
      pid: 1,
      running: false
    })

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(1500)
    await expect(promise).resolves.toMatchObject({ ok: false, error: 'apply-failed' })
    expect(checkHermesUpdateSpy).not.toHaveBeenCalled()
    expect($backendUpdateApply.get().stage).toBe('error')
  })

  it('surfaces an error when the backend never comes back after the restart', async () => {
    updateHermesSpy.mockResolvedValue({ ok: true, name: 'update', pid: 1 })
    getActionStatusSpy.mockRejectedValue(new Error('ECONNREFUSED'))
    checkHermesUpdateSpy.mockRejectedValue(new Error('ECONNREFUSED'))

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(250000)
    const result = await promise

    expect(result.ok).toBe(false)
    expect($backendUpdateApply.get().stage).toBe('error')
  }, 10000)

  it('reports a committed update with owed follow-ups as success plus an owed-step warning', async () => {
    updateHermesSpy.mockResolvedValue({ action_id: 'e'.repeat(32), ok: true, name: 'hermes-update', pid: 1 })
    getActionStatusSpy.mockResolvedValue({
      exit_code: 0,
      lines: ['Update complete!'],
      name: 'hermes-update',
      pid: null,
      running: false,
      receipt: {
        action_id: 'e'.repeat(32),
        outcome: 'success',
        followups: [{ step: 'dependencies', reason: 'sync failed' }],
        user_action: null
      }
    })
    notifySpy.mockClear()

    const promise = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(1500)
    const result = await promise

    expect(result).toMatchObject({ ok: true })
    expect(result.message).toContain('dependencies (sync failed)')
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'warning', message: expect.stringContaining('dependencies (sync failed)') })
    )
  })

  it("names a partial update's owed user action verbatim, only from this action's own receipt", async () => {
    const instruction = 'Your local changes are parked in stash@{0}; run `git stash pop` in ~/.hermes/hermes-agent.'

    const status = (actionId: string) => ({
      exit_code: 1,
      lines: ['update parked local changes'],
      name: 'hermes-update',
      pid: null,
      running: false,
      receipt: {
        action_id: actionId,
        outcome: 'partial',
        followups: [],
        user_action: { step: 'local_changes', reason: instruction }
      }
    })

    updateHermesSpy.mockResolvedValue({ action_id: 'c'.repeat(32), ok: true, name: 'hermes-update', pid: 1 })
    getActionStatusSpy.mockResolvedValue(status('c'.repeat(32)))
    const own = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(1500)
    const result = await own

    // exit 1 stays a failed apply, but the committed run's debt is named, never as "re-run hermes update".
    expect(result).toMatchObject({ ok: false, error: 'apply-failed' })
    expect(result.message).toContain(`local_changes: ${instruction}`)
    expect(result.message).not.toMatch(/Re-run `hermes update`/)
    expect($backendUpdateApply.get()).toMatchObject({ stage: 'error', message: result.message })

    // The status route attaches the latest receipt when this action has none: another run's debt is not ours.
    getActionStatusSpy.mockResolvedValue(status('d'.repeat(32)))
    const foreign = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(1500)

    expect((await foreign).message).not.toContain('local_changes')
  })

  it("never lets another action's receipt certify this update", async () => {
    const receipt = (actionId: string) => ({
      exit_code: null,
      lines: [],
      name: 'hermes-update',
      pid: null,
      running: false,
      receipt: {
        action_id: actionId,
        outcome: 'success',
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        followups: [],
        user_action: null
      }
    })

    updateHermesSpy.mockResolvedValue({ action_id: 'b'.repeat(32), ok: true, name: 'hermes-update', pid: 1 })
    getActionStatusSpy.mockResolvedValue(receipt('a'.repeat(32)))
    const foreign = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000 + 1500)
    await expect(foreign).resolves.toMatchObject({ ok: false })

    getActionStatusSpy.mockResolvedValue(receipt('b'.repeat(32)))
    const own = applyBackendUpdate()
    await vi.advanceTimersByTimeAsync(1500)
    await expect(own).resolves.toMatchObject({ ok: true })
  })
})

describe('startUpdatePoller', () => {
  const checkMock = vi.fn()
  const onProgressMock = vi.fn()
  const listeners: Record<string, Function> = {}

  beforeEach(() => {
    storage.clear()
    checkMock.mockReset()
    checkHermesUpdateSpy.mockReset()
    onProgressMock.mockReset()
    Object.keys(listeners).forEach(k => delete listeners[k])
    checkMock.mockResolvedValue({
      supported: true,
      behind: 5,
      targetSha: 'sha-abc',
      fetchedAt: 0
    })
    $updateStatus.set(null)
    $backendUpdateStatus.set(null)
    $updateChecking.set(false)
    $backendUpdateChecking.set(false)
    ;(globalThis as unknown as { window: unknown }).window = {
      hermesDesktop: { updates: { check: checkMock, onProgress: onProgressMock } },
      addEventListener: vi.fn((event: string, handler: Function) => {
        listeners[event] = handler
      }),
      removeEventListener: vi.fn()
    }
    vi.useFakeTimers()
    stopUpdatePoller()
  })

  afterEach(() => {
    stopUpdatePoller()
    delete (globalThis as unknown as { window?: unknown }).window
    vi.useRealTimers()
  })

  it('subscribes to progress on startup without probing updates or fabricating status', async () => {
    const cached = status({ behind: 5 })
    $updateStatus.set(cached)

    startUpdatePoller()
    await vi.advanceTimersByTimeAsync(0)

    expect(onProgressMock).toHaveBeenCalledTimes(1)
    expect(checkMock).not.toHaveBeenCalled()
    expect(checkHermesUpdateSpy).not.toHaveBeenCalled()
    expect($updateStatus.get()).toBe(cached)
    expect($updateChecking.get()).toBe(false)
  })

  it('keeps the daily timer but never forces a bridge check past the caches', async () => {
    vi.setSystemTime(0)
    startUpdatePoller()
    await vi.advanceTimersByTimeAsync(0)
    expect(storage.get('hermes.updates.last-passive-check')).toBe('0')
    expect(checkMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(BACKGROUND_UPDATE_CHECK_MS - 1)
    expect(storage.get('hermes.updates.last-passive-check')).toBe('0')

    await vi.advanceTimersByTimeAsync(1)
    expect(storage.get('hermes.updates.last-passive-check')).toBe(String(BACKGROUND_UPDATE_CHECK_MS))
    expect(checkMock).not.toHaveBeenCalled()
    expect(checkHermesUpdateSpy).not.toHaveBeenCalled()
  })

  it('keeps an explicit manual check inert and returns the cached object', async (): Promise<void> => {
    const cached = status({ behind: 5 })
    $updateStatus.set(cached)

    await expect(checkUpdates({ force: true })).resolves.toBe(cached)
    expect(checkMock).not.toHaveBeenCalled()
    expect($updateStatus.get()).toBe(cached)
    expect($updateChecking.get()).toBe(false)
  })

  it('window focus records the daily cadence without probing either updater', async () => {
    vi.setSystemTime(0)
    startUpdatePoller()
    await vi.advanceTimersByTimeAsync(0)

    listeners['focus']?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(storage.get('hermes.updates.last-passive-check')).toBe('0')

    vi.setSystemTime(BACKGROUND_UPDATE_CHECK_MS)
    listeners['focus']?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(storage.get('hermes.updates.last-passive-check')).toBe(String(BACKGROUND_UPDATE_CHECK_MS))
    expect(checkMock).not.toHaveBeenCalled()
    expect(checkHermesUpdateSpy).not.toHaveBeenCalled()
  })

  it('does not probe or synthesize backend status when switching directly between remote targets', async () => {
    const cached = status({ behind: 1 })
    $backendUpdateStatus.set(cached)
    setConnection({
      baseUrl: 'http://profile-a:9119',
      isFullscreen: false,
      mode: 'remote',
      nativeOverlayWidth: 0,
      token: 't',
      wsUrl: 'ws://profile-a:9119',
      logs: [],
      windowButtonPosition: null
    })

    startUpdatePoller()
    await vi.advanceTimersByTimeAsync(0)

    setConnection({
      baseUrl: 'http://profile-b:9119',
      isFullscreen: false,
      mode: 'remote',
      nativeOverlayWidth: 0,
      token: 't',
      wsUrl: 'ws://profile-b:9119',
      logs: [],
      windowButtonPosition: null
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(checkHermesUpdateSpy).not.toHaveBeenCalled()
    expect($backendUpdateStatus.get()).toBe(cached)
    expect($backendUpdateChecking.get()).toBe(false)
  })

  it('does not probe when switching profiles on the same remote backend', async () => {
    const pooled = (profile: string) => ({
      baseUrl: 'http://shared-box:9119',
      isFullscreen: false,
      mode: 'remote' as const,
      nativeOverlayWidth: 0,
      profile,
      token: 't',
      wsUrl: 'ws://shared-box:9119',
      logs: [],
      windowButtonPosition: null
    })

    setConnection(pooled('alpha'))
    startUpdatePoller()
    await vi.advanceTimersByTimeAsync(0)

    setConnection(pooled('beta'))
    await vi.advanceTimersByTimeAsync(0)

    expect(checkHermesUpdateSpy).not.toHaveBeenCalled()
    expect($backendUpdateStatus.get()).toBeNull()
    expect($backendUpdateChecking.get()).toBe(false)
  })

  it('does not create an in-flight backend check or apply a late result after switching targets', async () => {
    const cached = status({ behind: 1 })
    $backendUpdateStatus.set(cached)
    setConnection({
      baseUrl: 'http://profile-a:9119',
      isFullscreen: false,
      mode: 'remote',
      nativeOverlayWidth: 0,
      token: 't',
      wsUrl: 'ws://profile-a:9119',
      logs: [],
      windowButtonPosition: null
    })

    startUpdatePoller()
    await checkBackendUpdates()

    setConnection({
      baseUrl: 'http://profile-b:9119',
      isFullscreen: false,
      mode: 'remote',
      nativeOverlayWidth: 0,
      token: 't',
      wsUrl: 'ws://profile-b:9119',
      logs: [],
      windowButtonPosition: null
    })
    await checkBackendUpdates({ force: true })
    await vi.advanceTimersByTimeAsync(0)

    expect(checkHermesUpdateSpy).not.toHaveBeenCalled()
    expect($backendUpdateStatus.get()).toBe(cached)
    expect($backendUpdateChecking.get()).toBe(false)
  })
})

describe('discontinued retirement notice', () => {
  const applyMock = vi.fn()
  const checkMock = vi.fn()

  const discontinuedStatus = (): DesktopUpdateStatus => ({
    supported: true,
    fetchedAt: 0,
    retirement: { state: 'discontinued', destination: 'stable', version: '1.2.3' }
  })

  beforeEach(() => {
    storage.clear()
    notifySpy.mockClear()
    dismissSpy.mockClear()
    applyMock.mockClear()
    checkMock.mockReset()
    resetUpdateApplyState()
    $updateStatus.set(null)
    $updateOverlayOpen.set(false)
    checkMock.mockImplementation(async () => discontinuedStatus())
    ;(globalThis as unknown as { window: unknown }).window = {
      hermesDesktop: { updates: { apply: applyMock, check: checkMock } }
    }
    vi.useRealTimers()
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('checkUpdates stays inert for a cached retirement while direct apply remains blocked', async () => {
    const cached = discontinuedStatus()
    $updateStatus.set(cached)

    await expect(checkUpdates({ force: true })).resolves.toBe(cached)

    expect(checkMock).not.toHaveBeenCalled()
    expect(notifySpy).not.toHaveBeenCalled()
    expect($updateStatus.get()).toBe(cached)

    const result = await applyUpdates()
    expect(result).toMatchObject({ ok: false, error: 'retirement-blocked' })
    expect(applyMock).not.toHaveBeenCalled()
  })

  it('re-checks stay silent and preserve state across cached retirement revisions', async () => {
    const first = discontinuedStatus()
    $updateStatus.set(first)
    await checkUpdates({ force: true })
    await checkUpdates({ force: true })

    expect(checkMock).not.toHaveBeenCalled()
    expect(notifySpy).not.toHaveBeenCalled()
    expect($updateStatus.get()).toBe(first)

    const revised: DesktopUpdateStatus = {
      ...first,
      retirement: { state: 'discontinued', destination: 'stable', version: '1.3.0' }
    }
    $updateStatus.set(revised)
    await expect(checkUpdates({ force: true })).resolves.toBe(revised)
    expect(checkMock).not.toHaveBeenCalled()
    expect(notifySpy).not.toHaveBeenCalled()
    expect($updateStatus.get()).toBe(revised)
  })

  it('cached status without a discontinued retirement is returned without a notice or bridge call', async () => {
    const cached: DesktopUpdateStatus = { supported: true, fetchedAt: 0 }
    $updateStatus.set(cached)

    await expect(checkUpdates({ force: true })).resolves.toBe(cached)

    expect(checkMock).not.toHaveBeenCalled()
    expect(notifySpy).not.toHaveBeenCalled()
    expect($updateStatus.get()).toBe(cached)
  })
})
