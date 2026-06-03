// React hook tests for the CCSwitch data-fetching wrappers. Mocks the
// underlying client so the hook behaviour can be observed without IPC.

jest.mock("./client", () => ({
  ccswitchStatus: jest.fn(),
  ccswitchListProviders: jest.fn(),
  ccswitchListMcpServers: jest.fn(),
  ccswitchListPrompts: jest.fn(),
  ccswitchListSkills: jest.fn(),
  ccswitchWatchStart: jest.fn(),
  ccswitchWatchStop: jest.fn(),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
}))

jest.mock("@/lib/tauri/events", () => ({
  onTauriEvent: jest.fn(),
}))

import { renderHook, act, waitFor } from "@testing-library/react"

import {
  ccswitchListMcpServers,
  ccswitchListPrompts,
  ccswitchListProviders,
  ccswitchListSkills,
  ccswitchStatus,
  ccswitchWatchStart,
  ccswitchWatchStop,
} from "./client"
import { isTauri } from "@/lib/tauri"
import { onTauriEvent } from "@/lib/tauri/events"

import {
  useCcswitchMcpServers,
  useCcswitchPrompts,
  useCcswitchProviders,
  useCcswitchSkills,
  useCcswitchStatus,
} from "./hooks"

const mStatus = ccswitchStatus as jest.Mock
const mProviders = ccswitchListProviders as jest.Mock
const mMcp = ccswitchListMcpServers as jest.Mock
const mPrompts = ccswitchListPrompts as jest.Mock
const mSkills = ccswitchListSkills as jest.Mock
const mWatchStart = ccswitchWatchStart as jest.Mock
const mWatchStop = ccswitchWatchStop as jest.Mock
const mIsTauri = isTauri as jest.Mock
const mOnEvent = onTauriEvent as jest.Mock

beforeEach(() => {
  jest.resetAllMocks()
  mIsTauri.mockReturnValue(false)
  mWatchStart.mockResolvedValue(true)
  mWatchStop.mockResolvedValue(undefined)
  mOnEvent.mockResolvedValue(() => {})
})

describe("useCcswitchStatus", () => {
  it("fetches on mount and exposes the result", async () => {
    mStatus.mockResolvedValue({
      dbPath: "/x",
      exists: true,
      counts: { providers: 2, mcpServers: 0, prompts: 0, skills: 0 },
    })
    const { result } = renderHook(() => useCcswitchStatus(true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data?.exists).toBe(true)
    expect(mStatus).toHaveBeenCalledTimes(1)
  })

  it("does not fetch when disabled", async () => {
    renderHook(() => useCcswitchStatus(false))
    // Give the effect a chance to (not) run.
    await new Promise((r) => setTimeout(r, 10))
    expect(mStatus).not.toHaveBeenCalled()
  })

  it("captures errors as a string", async () => {
    mStatus.mockRejectedValue(new Error("boom"))
    const { result } = renderHook(() => useCcswitchStatus(true))
    await waitFor(() => expect(result.current.error).toBe("boom"))
    expect(result.current.data).toBeUndefined()
  })

  it("refresh() triggers another fetch", async () => {
    mStatus.mockResolvedValue({
      dbPath: "/x",
      exists: false,
      counts: { providers: 0, mcpServers: 0, prompts: 0, skills: 0 },
    })
    const { result } = renderHook(() => useCcswitchStatus(true))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      await result.current.refresh()
    })
    expect(mStatus).toHaveBeenCalledTimes(2)
  })

  it("refreshOnFocus re-fetches when the window regains focus", async () => {
    mStatus.mockResolvedValue({
      dbPath: "/x",
      exists: true,
      counts: { providers: 1, mcpServers: 0, prompts: 0, skills: 0 },
    })
    renderHook(() => useCcswitchStatus(true, true))
    await waitFor(() => expect(mStatus).toHaveBeenCalledTimes(1))
    await act(async () => {
      window.dispatchEvent(new FocusEvent("focus"))
    })
    await waitFor(() => expect(mStatus).toHaveBeenCalledTimes(2))
  })

  it("refreshOnFocus does NOT re-fetch when watchDb is off", async () => {
    mStatus.mockResolvedValue({
      dbPath: "/x",
      exists: true,
      counts: { providers: 1, mcpServers: 0, prompts: 0, skills: 0 },
    })
    renderHook(() => useCcswitchStatus(true, false))
    await waitFor(() => expect(mStatus).toHaveBeenCalledTimes(1))
    await act(async () => {
      window.dispatchEvent(new FocusEvent("focus"))
    })
    // Give any focus listeners a tick to (not) run.
    await new Promise((r) => setTimeout(r, 10))
    expect(mStatus).toHaveBeenCalledTimes(1)
  })
})

describe("live db watch (ccswitch://db-changed)", () => {
  beforeEach(() => {
    mStatus.mockResolvedValue({
      dbPath: "/x",
      exists: true,
      counts: { providers: 1, mcpServers: 0, prompts: 0, skills: 0 },
    })
  })

  it("starts the watcher and refreshes when a db-changed event fires", async () => {
    mIsTauri.mockReturnValue(true)
    let emit: (() => void) | undefined
    const unlisten = jest.fn()
    mOnEvent.mockImplementation((_event: string, handler: () => void) => {
      emit = handler
      return Promise.resolve(unlisten)
    })

    renderHook(() => useCcswitchStatus(true, true))
    await waitFor(() => expect(mWatchStart).toHaveBeenCalled())
    await waitFor(() => expect(mStatus).toHaveBeenCalledTimes(1))
    expect(mOnEvent).toHaveBeenCalledWith("ccswitch://db-changed", expect.any(Function))

    await act(async () => {
      emit?.()
    })
    await waitFor(() => expect(mStatus).toHaveBeenCalledTimes(2))
  })

  it("does not start the watcher when watchDb is off", async () => {
    mIsTauri.mockReturnValue(true)
    renderHook(() => useCcswitchStatus(true, false))
    await waitFor(() => expect(mStatus).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(mWatchStart).not.toHaveBeenCalled()
    expect(mOnEvent).not.toHaveBeenCalled()
  })

  it("does not start the watcher outside Tauri", async () => {
    mIsTauri.mockReturnValue(false)
    renderHook(() => useCcswitchStatus(true, true))
    await waitFor(() => expect(mStatus).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(mWatchStart).not.toHaveBeenCalled()
  })

  it("stops the watcher and unsubscribes on unmount", async () => {
    mIsTauri.mockReturnValue(true)
    const unlisten = jest.fn()
    mOnEvent.mockResolvedValue(unlisten)

    const { unmount } = renderHook(() => useCcswitchStatus(true, true))
    await waitFor(() => expect(mOnEvent).toHaveBeenCalled())
    // Let the onTauriEvent promise resolve so unlisten is captured.
    await act(async () => {
      await Promise.resolve()
    })
    unmount()
    await waitFor(() => expect(mWatchStop).toHaveBeenCalled())
    expect(unlisten).toHaveBeenCalled()
  })
})

describe("other hooks", () => {
  it("useCcswitchProviders fetches via the right client", async () => {
    mProviders.mockResolvedValue([{ id: "a", name: "A" }])
    const { result } = renderHook(() => useCcswitchProviders(true))
    await waitFor(() => expect(result.current.data?.length).toBe(1))
    expect(mProviders).toHaveBeenCalled()
  })

  it("useCcswitchMcpServers fetches via the right client", async () => {
    mMcp.mockResolvedValue([])
    renderHook(() => useCcswitchMcpServers(true))
    await waitFor(() => expect(mMcp).toHaveBeenCalled())
  })

  it("useCcswitchPrompts fetches via the right client", async () => {
    mPrompts.mockResolvedValue([])
    renderHook(() => useCcswitchPrompts(true))
    await waitFor(() => expect(mPrompts).toHaveBeenCalled())
  })

  it("useCcswitchSkills fetches via the right client", async () => {
    mSkills.mockResolvedValue([])
    renderHook(() => useCcswitchSkills(true))
    await waitFor(() => expect(mSkills).toHaveBeenCalled())
  })
})
