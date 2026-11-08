import { useStore } from '@nanostores/react'
import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PRIMARY_SESSION_VIEW } from '@/app/chat/session-view'
import { useSessionTileDelegate } from '@/app/contrib/hooks/use-session-tile-delegate'
import { $activeGatewayProfile } from '@/store/profile'
import {
  $activeSessionId,
  $currentModel,
  $currentProvider,
  $currentReasoningEffortWire,
  $messages,
  setCurrentModel,
  setCurrentModelSource,
  setCurrentProvider,
  setCurrentReasoningEffortWire
} from '@/store/session'
import { $sessionStates, $sessionTiles, setSessionTileDelegate } from '@/store/session-states'

import { deferred } from '../../../test/deferred'

import { useModelControls } from './use-model-controls'
import { useSessionStateCache } from './use-session-state-cache'

const confirmMock = vi.fn()
const notifyMock = vi.fn()
const notifyErrorMock = vi.fn()

vi.mock('@/store/confirm', () => ({
  confirm: (...args: Parameters<typeof confirmMock>) => confirmMock(...args)
}))

vi.mock('@/store/notifications', () => ({
  dismissNotification: vi.fn(),
  notify: (...args: Parameters<typeof notifyMock>) => notifyMock(...args),
  notifyError: (...args: Parameters<typeof notifyErrorMock>) => notifyErrorMock(...args)
}))

type RequestGateway = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
type Deferred = ReturnType<typeof deferred<unknown>>

function renderProductionControls(requestGateway: RequestGateway) {
  const queryClient = new QueryClient()

  const view = renderHook(() => {
    const activeSessionId = useStore($activeSessionId)
    const busyRef = useRef(false)

    const cache = useSessionStateCache({
      activeSessionId,
      busyRef,
      selectedStoredSessionId: null,
      setAwaitingResponse: () => undefined,
      setBusy: () => undefined,
      setMessages: messages => $messages.set(messages)
    })

    useSessionTileDelegate({
      archiveSession: vi.fn(async () => undefined),
      branchLoadedSession: vi.fn(async () => false) as never,
      branchStoredSession: vi.fn(async () => undefined),
      executeSlashCommand: vi.fn(async () => undefined) as never,
      removeSession: vi.fn(async () => undefined),
      requestGateway,
      runtimeIdByStoredSessionIdRef: cache.runtimeIdByStoredSessionIdRef,
      sessionStateByRuntimeIdRef: cache.sessionStateByRuntimeIdRef,
      updateSessionState: cache.updateSessionState
    })

    return { cache, controls: useModelControls({ queryClient, requestGateway }) }
  })

  return { queryClient, view }
}

function seedRuntime(cache: ReturnType<typeof useSessionStateCache>, sessionId: string) {
  act(() => {
    cache.updateSessionState(sessionId, state => ({
      ...state,
      busy: false,
      model: 'live-model',
      provider: 'live-provider',
      reasoningEffortWire: 'high'
    }))
  })
}

function resetStores() {
  window.localStorage.clear()
  $activeGatewayProfile.set('default')
  $activeSessionId.set(null)
  $messages.set([])
  $sessionStates.set({})
  $sessionTiles.set([])
  setCurrentModel('')
  setCurrentProvider('')
  setCurrentModelSource('')
  setCurrentReasoningEffortWire('')
}

async function settle(pending: Deferred, result: unknown, pick: Promise<boolean>) {
  await act(async () => {
    pending.resolve(result)
    await expect(pick).resolves.toBe(true)
  })
}

describe('useModelControls confirmed primary session paint (#150119)', () => {
  beforeEach(() => {
    confirmMock.mockReset()
    notifyMock.mockReset()
    notifyErrorMock.mockReset()
    resetStores()
  })

  afterEach(() => {
    cleanup()
    setSessionTileDelegate(null as never)
    vi.restoreAllMocks()
    resetStores()
  })

  it('repaints the visible primary pill after an idle switch is confirmed', async () => {
    const runtime = 'runtime-idle-confirmed'
    const pending = deferred<unknown>()
    $activeSessionId.set(runtime)
    const { view } = renderProductionControls(vi.fn(() => pending.promise) as RequestGateway)
    seedRuntime(view.result.current.cache, runtime)

    let pick!: Promise<boolean>
    act(() => {
      pick = view.result.current.controls.selectModel({ model: 'new-model', provider: 'new-provider' })
    })

    // Confirmation-only paint avoids adding a new primary-runtime rollback path.
    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe('live-model')
    expect(PRIMARY_SESSION_VIEW.$provider.get()).toBe('live-provider')

    await settle(pending, {}, pick)

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe('new-model')
    expect(PRIMARY_SESSION_VIEW.$provider.get()).toBe('new-provider')
    expect($sessionStates.get()[runtime]).toMatchObject({
      model: 'new-model',
      provider: 'new-provider',
      reasoningEffortWire: ''
    })
  })

  it('leaves the primary runtime unchanged when the switch is rejected', async () => {
    const runtime = 'runtime-rejected'
    const pending = deferred<unknown>()
    $activeSessionId.set(runtime)
    const { view } = renderProductionControls(vi.fn(() => pending.promise) as RequestGateway)
    seedRuntime(view.result.current.cache, runtime)

    let pick!: Promise<boolean>
    act(() => {
      pick = view.result.current.controls.selectModel({ model: 'bad-model', provider: 'bad-provider' })
    })
    await act(async () => {
      pending.reject(new Error('model unavailable'))
      await expect(pick).resolves.toBe(false)
    })

    expect(PRIMARY_SESSION_VIEW.$model.get()).toBe('live-model')
    expect(PRIMARY_SESSION_VIEW.$provider.get()).toBe('live-provider')
    expect($sessionStates.get()[runtime]).toMatchObject({ reasoningEffortWire: 'high' })
  })

  it('paints the owning runtime after the user opens another chat', async () => {
    const runtimeA = 'runtime-owner-a'
    const runtimeB = 'runtime-owner-b'
    const pending = deferred<unknown>()
    $activeSessionId.set(runtimeA)
    const { view } = renderProductionControls(vi.fn(() => pending.promise) as RequestGateway)
    seedRuntime(view.result.current.cache, runtimeA)

    let pick!: Promise<boolean>
    act(() => {
      pick = view.result.current.controls.selectModel({ model: 'new-a', provider: 'provider-new-a' })
    })
    act(() => $activeSessionId.set(runtimeB))
    seedRuntime(view.result.current.cache, runtimeB)
    await settle(pending, {}, pick)

    expect($sessionStates.get()[runtimeA]).toMatchObject({ model: 'new-a', provider: 'provider-new-a' })
    expect($sessionStates.get()[runtimeB]).toMatchObject({ model: 'live-model', provider: 'live-provider' })
    expect($currentModel.get()).toBe('live-model')
    expect($currentProvider.get()).toBe('live-provider')
    expect($currentReasoningEffortWire.get()).toBe('high')
  })

  it('does not paint a deferred switch before the gateway applies it', async () => {
    const runtime = 'runtime-deferred'
    const pending = deferred<unknown>()
    $activeSessionId.set(runtime)
    const { view } = renderProductionControls(vi.fn(() => pending.promise) as RequestGateway)
    seedRuntime(view.result.current.cache, runtime)

    let pick!: Promise<boolean>
    act(() => {
      pick = view.result.current.controls.selectModel({ model: 'next-model', provider: 'next-provider' })
    })
    await settle(pending, { deferred: true }, pick)

    expect($sessionStates.get()[runtime]).toMatchObject({ model: 'live-model', provider: 'live-provider' })
    expect(notifyMock).toHaveBeenCalledTimes(1)
  })

  it('does not let an older confirmation overwrite a newer pending pick', async () => {
    const runtime = 'runtime-overlapping'
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const requestGateway = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    $activeSessionId.set(runtime)
    const { view } = renderProductionControls(requestGateway as RequestGateway)
    seedRuntime(view.result.current.cache, runtime)

    let firstPick!: Promise<boolean>
    let secondPick!: Promise<boolean>
    act(() => {
      firstPick = view.result.current.controls.selectModel({ model: 'first-model', provider: 'first-provider' })
      secondPick = view.result.current.controls.selectModel({ model: 'second-model', provider: 'second-provider' })
    })

    await settle(first, {}, firstPick)
    expect($sessionStates.get()[runtime]).toMatchObject({ model: 'live-model', provider: 'live-provider' })

    await settle(second, {}, secondPick)
    expect($sessionStates.get()[runtime]).toMatchObject({ model: 'second-model', provider: 'second-provider' })
  })

  it('leaves a newer failure / older success overlap to authoritative session.info', async () => {
    const runtime = 'runtime-overlap-newer-fails-first'
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const requestGateway = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    $activeSessionId.set(runtime)
    const { view } = renderProductionControls(requestGateway as RequestGateway)
    seedRuntime(view.result.current.cache, runtime)

    let firstPick!: Promise<boolean>
    let secondPick!: Promise<boolean>
    act(() => {
      firstPick = view.result.current.controls.selectModel({ model: 'first-model', provider: 'first-provider' })
      secondPick = view.result.current.controls.selectModel({ model: 'second-model', provider: 'second-provider' })
    })

    await act(async () => {
      second.reject(new Error('second unavailable'))
      await expect(secondPick).resolves.toBe(false)
    })
    await settle(first, {}, firstPick)

    // This patch intentionally handles an isolated confirmed pick only. It
    // does not guess the backend's final state for overlapping switches.
    expect($sessionStates.get()[runtime]).toMatchObject({ model: 'live-model', provider: 'live-provider' })
  })

  it('leaves an older success / newer failure overlap to authoritative session.info', async () => {
    const runtime = 'runtime-overlap-newer-fails-last'
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const requestGateway = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    $activeSessionId.set(runtime)
    const { view } = renderProductionControls(requestGateway as RequestGateway)
    seedRuntime(view.result.current.cache, runtime)

    let firstPick!: Promise<boolean>
    let secondPick!: Promise<boolean>
    act(() => {
      firstPick = view.result.current.controls.selectModel({ model: 'first-model', provider: 'first-provider' })
      secondPick = view.result.current.controls.selectModel({ model: 'second-model', provider: 'second-provider' })
    })

    await settle(first, {}, firstPick)
    expect($sessionStates.get()[runtime]).toMatchObject({ model: 'live-model', provider: 'live-provider' })

    await act(async () => {
      second.reject(new Error('second unavailable'))
      await expect(secondPick).resolves.toBe(false)
    })
    expect($sessionStates.get()[runtime]).toMatchObject({ model: 'live-model', provider: 'live-provider' })
  })

  it('paints a guarded switch only after the confirmed retry succeeds', async () => {
    const runtime = 'runtime-guarded'
    const confirmed = deferred<unknown>()

    const requestGateway = vi
      .fn()
      .mockResolvedValueOnce({ confirm_message: 'Expensive model', confirm_required: true })
      .mockReturnValueOnce(confirmed.promise)

    confirmMock.mockResolvedValue(true)
    $activeSessionId.set(runtime)
    const { view } = renderProductionControls(requestGateway as RequestGateway)
    seedRuntime(view.result.current.cache, runtime)

    await act(async () => {
      await expect(
        view.result.current.controls.selectModel({ model: 'guarded-model', provider: 'guarded-provider' })
      ).resolves.toBe(false)
    })
    expect($sessionStates.get()[runtime]).toMatchObject({ model: 'live-model', provider: 'live-provider' })
    await waitFor(() => expect(requestGateway).toHaveBeenCalledTimes(2))

    await act(async () => {
      confirmed.resolve({})
      await confirmed.promise
    })
    await waitFor(() => expect($sessionStates.get()[runtime]?.model).toBe('guarded-model'))
    expect(requestGateway).toHaveBeenLastCalledWith('config.set', {
      confirm_expensive_model: true,
      key: 'model',
      session_id: runtime,
      value: 'guarded-model --provider guarded-provider'
    })
  })
})
