// React hook tests for the CCSwitch data-fetching wrappers. Mocks the
// underlying client so the hook behaviour can be observed without IPC.

jest.mock("./client", () => ({
  ccswitchStatus: jest.fn(),
  ccswitchListProviders: jest.fn(),
  ccswitchListMcpServers: jest.fn(),
  ccswitchListPrompts: jest.fn(),
  ccswitchListSkills: jest.fn(),
}))

import { renderHook, act, waitFor } from "@testing-library/react"

import {
  ccswitchListMcpServers,
  ccswitchListPrompts,
  ccswitchListProviders,
  ccswitchListSkills,
  ccswitchStatus,
} from "./client"

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

beforeEach(() => {
  jest.resetAllMocks()
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
