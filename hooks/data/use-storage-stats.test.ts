/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

const liveQueryMock = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: <T>(fn: () => Promise<T> | T): T | undefined => {
    return liveQueryMock(fn) as T | undefined
  },
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(),
}))

import { useStorageStats } from "./use-storage-stats"

beforeEach(() => {
  liveQueryMock.mockReset()
})

describe("useStorageStats", () => {
  it("falls back to empty counts when useLiveQuery returns undefined", () => {
    liveQueryMock.mockReturnValue(undefined)
    const { result } = renderHook(() => useStorageStats())
    expect(result.current.counts).toEqual({})
    expect(result.current.totalRows).toBe(0)
  })

  it("aggregates totalRows from numeric count values", () => {
    liveQueryMock.mockReturnValue({
      sessions: 3,
      messages: 12,
      characters: 1,
      skills: 0,
      skillResources: 0,
      teams: 0,
      promptPresets: 0,
      mcpServers: 0,
      trustedWorkspaces: 0,
      sessionState: 0,
      backupHistory: 0,
    })
    const { result } = renderHook(() => useStorageStats())
    expect(result.current.totalRows).toBe(16)
  })

  it("populates usage/quota when navigator.storage.estimate is available", async () => {
    liveQueryMock.mockReturnValue({})
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      writable: true,
      value: {
        estimate: jest.fn().mockResolvedValue({ usage: 100, quota: 200 }),
      },
    })
    const { result } = renderHook(() => useStorageStats())
    await waitFor(() => {
      expect(result.current.usageBytes).toBe(100)
    })
    expect(result.current.quotaBytes).toBe(200)
  })

  it("ignores estimate failures and leaves usage undefined", async () => {
    liveQueryMock.mockReturnValue({})
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      writable: true,
      value: {
        estimate: jest.fn().mockRejectedValue(new Error("denied")),
      },
    })
    const { result } = renderHook(() => useStorageStats())
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 0))
    })
    expect(result.current.usageBytes).toBeUndefined()
  })

  it("noops when navigator.storage is missing", () => {
    liveQueryMock.mockReturnValue({})
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      writable: true,
      value: undefined,
    })
    const { result } = renderHook(() => useStorageStats())
    expect(result.current.usageBytes).toBeUndefined()
    expect(result.current.quotaBytes).toBeUndefined()
  })
})
