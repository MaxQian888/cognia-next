/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"

let visibleUnread = { dm: 0, teams: new Map<string, number>(), total: 0 }
jest.mock("@/hooks/shell/use-team-mute", () => ({
  useVisibleGuildUnread: () => visibleUnread,
}))

// Factories run before this file's top-level `const`s (the settings store
// asks `isTauri` while it is being imported), so the mocks live inside them.
jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual<typeof import("@/lib/tauri")>("@/lib/tauri"),
  isTauri: jest.fn(() => false),
}))
jest.mock("@/lib/pet/window-role", () => ({ isMainAppWindow: jest.fn(() => true) }))

const warnMock = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: { ui: { warn: (...a: unknown[]) => warnMock(...a) } },
}))

const setBadgeCount = jest.fn(async (_count?: number) => {})
jest.mock(
  "@tauri-apps/api/window",
  () => ({ getCurrentWindow: () => ({ setBadgeCount: (c?: number) => setBadgeCount(c) }) }),
  { virtual: true }
)

import {
  computeAppAttentionCount,
  useAppAttentionCount,
  useAppBadge,
  useAppBadgeEnabled,
} from "./use-app-badge"
import { __resetNavBadgesForTests, setNavBadgeSourceCount } from "@/lib/shell/nav-badges"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { isTauri } from "@/lib/tauri"
import { isMainAppWindow } from "@/lib/pet/window-role"

const isTauriMock = isTauri as jest.Mock
const isMainMock = isMainAppWindow as jest.Mock

beforeEach(() => {
  __resetNavBadgesForTests()
  visibleUnread = { dm: 0, teams: new Map(), total: 0 }
  isTauriMock.mockReturnValue(true)
  isMainMock.mockReturnValue(true)
  setBadgeCount.mockReset().mockResolvedValue(undefined)
  warnMock.mockReset()
  useSettingsStore.setState({ settings: {} as never })
})

describe("computeAppAttentionCount", () => {
  it("adds guild unread to every feature badge", () => {
    expect(computeAppAttentionCount(3, { inbox: 2, bots: 1 })).toBe(6)
    expect(computeAppAttentionCount(0, {})).toBe(0)
    expect(computeAppAttentionCount(-1, { inbox: -2 })).toBe(0)
  })
})

describe("useAppAttentionCount", () => {
  it("sums unread conversations and feature badges, live", () => {
    visibleUnread = { dm: 1, teams: new Map([["t", 2]]), total: 3 }
    const { result } = renderHook(() => useAppAttentionCount())
    expect(result.current).toBe(3)
    act(() => setNavBadgeSourceCount("inbox.drafts", 4))
    expect(result.current).toBe(7)
  })

  it("is zero while the user has the app badge switched off", () => {
    visibleUnread = { dm: 1, teams: new Map(), total: 1 }
    useSettingsStore.setState({
      settings: { notificationPreferences: { appBadge: false } } as never,
    })
    const { result } = renderHook(() => useAppAttentionCount())
    expect(result.current).toBe(0)
    expect(renderHook(() => useAppBadgeEnabled()).result.current).toBe(false)
  })

  it("defaults the preference on for settings saved before it existed", () => {
    useSettingsStore.setState({ settings: { notificationPreferences: { sound: false } } as never })
    expect(renderHook(() => useAppBadgeEnabled()).result.current).toBe(true)
  })
})

describe("useAppBadge", () => {
  it("pushes the count to the dock, and clears it at zero", async () => {
    const { rerender } = renderHook(({ count }) => useAppBadge(count), {
      initialProps: { count: 5 },
    })
    await waitFor(() => expect(setBadgeCount).toHaveBeenLastCalledWith(5))
    rerender({ count: 0 })
    await waitFor(() => expect(setBadgeCount).toHaveBeenLastCalledWith(undefined))
  })

  it("does not write the same count twice", async () => {
    const { rerender } = renderHook(({ count }) => useAppBadge(count), {
      initialProps: { count: 2 },
    })
    await waitFor(() => expect(setBadgeCount).toHaveBeenCalledTimes(1))
    rerender({ count: 2 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(setBadgeCount).toHaveBeenCalledTimes(1)
  })

  it("clears the badge when it unmounts", async () => {
    const { unmount } = renderHook(() => useAppBadge(3))
    await waitFor(() => expect(setBadgeCount).toHaveBeenLastCalledWith(3))
    unmount()
    await waitFor(() => expect(setBadgeCount).toHaveBeenLastCalledWith(undefined))
  })

  it("does nothing outside Tauri or outside the main window", async () => {
    isTauriMock.mockReturnValue(false)
    renderHook(() => useAppBadge(3))
    isTauriMock.mockReturnValue(true)
    isMainMock.mockReturnValue(false)
    renderHook(() => useAppBadge(3))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(setBadgeCount).not.toHaveBeenCalled()
  })

  it("stops after one warning where the platform has no count badge", async () => {
    setBadgeCount.mockRejectedValue(new Error("unsupported on windows"))
    const { rerender } = renderHook(({ count }) => useAppBadge(count), {
      initialProps: { count: 1 },
    })
    await waitFor(() => expect(warnMock).toHaveBeenCalledTimes(1))
    rerender({ count: 2 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(setBadgeCount).toHaveBeenCalledTimes(1)
    expect(warnMock).toHaveBeenCalledTimes(1)
  })
})
