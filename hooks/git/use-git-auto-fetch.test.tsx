/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

import { DEFAULT_SOURCE_CONTROL_PANEL_PREFS } from "@/lib/git/panel-prefs"

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/git/commands", () => ({ gitFetch: jest.fn().mockResolvedValue(undefined) }))
jest.mock("@/lib/git/load", () => ({ refreshGitStatus: jest.fn().mockResolvedValue(undefined) }))

let prefs = { ...DEFAULT_SOURCE_CONTROL_PANEL_PREFS }
jest.mock("@/hooks/git/use-source-control-prefs", () => ({
  useSourceControlPrefs: () => ({ prefs }),
}))

import { useGitAutoFetch } from "./use-git-auto-fetch"
import { useGitStore } from "@/stores/git/git-store"
import { gitFetch } from "@/lib/git/commands"
import { isTauri } from "@/lib/tauri"

const TEN_MIN = 10 * 60 * 1000

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  ;(isTauri as jest.Mock).mockReturnValue(true)
  prefs = { ...DEFAULT_SOURCE_CONTROL_PANEL_PREFS }
  useGitStore.setState({ rootDir: "/repo" })
})

afterEach(() => {
  jest.useRealTimers()
})

describe("useGitAutoFetch", () => {
  it("does nothing when auto-fetch is off (default)", () => {
    renderHook(() => useGitAutoFetch())
    jest.advanceTimersByTime(TEN_MIN * 3)
    expect(gitFetch).not.toHaveBeenCalled()
  })

  it("fetches quietly at the configured interval when enabled", () => {
    prefs = { ...prefs, autoFetch: true, autoFetchIntervalMinutes: 10, fetchPrune: false }
    renderHook(() => useGitAutoFetch())
    jest.advanceTimersByTime(TEN_MIN)
    expect(gitFetch).toHaveBeenCalledWith("/repo", undefined, false)
    jest.advanceTimersByTime(TEN_MIN)
    expect(gitFetch).toHaveBeenCalledTimes(2)
  })

  it("passes the prune preference through", () => {
    prefs = { ...prefs, autoFetch: true, autoFetchIntervalMinutes: 10, fetchPrune: true }
    renderHook(() => useGitAutoFetch())
    jest.advanceTimersByTime(TEN_MIN)
    expect(gitFetch).toHaveBeenCalledWith("/repo", undefined, true)
  })

  it("stops fetching after unmount", () => {
    prefs = { ...prefs, autoFetch: true, autoFetchIntervalMinutes: 10 }
    const { unmount } = renderHook(() => useGitAutoFetch())
    jest.advanceTimersByTime(TEN_MIN)
    expect(gitFetch).toHaveBeenCalledTimes(1)
    unmount()
    jest.advanceTimersByTime(TEN_MIN * 3)
    expect(gitFetch).toHaveBeenCalledTimes(1)
  })

  it("is a no-op on the web (non-Tauri)", () => {
    ;(isTauri as jest.Mock).mockReturnValue(false)
    prefs = { ...prefs, autoFetch: true, autoFetchIntervalMinutes: 10 }
    renderHook(() => useGitAutoFetch())
    jest.advanceTimersByTime(TEN_MIN * 2)
    expect(gitFetch).not.toHaveBeenCalled()
  })

  it("is a no-op without a bound repo", () => {
    useGitStore.setState({ rootDir: null })
    prefs = { ...prefs, autoFetch: true, autoFetchIntervalMinutes: 10 }
    renderHook(() => useGitAutoFetch())
    jest.advanceTimersByTime(TEN_MIN * 2)
    expect(gitFetch).not.toHaveBeenCalled()
  })
})
