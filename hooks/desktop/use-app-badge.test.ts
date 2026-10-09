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
const setOverlayIcon = jest.fn(async (_icon?: unknown) => {})
const getCurrentWindow = jest.fn(() => ({
  setBadgeCount: (c?: number) => setBadgeCount(c),
  setOverlayIcon: (icon?: unknown) => setOverlayIcon(icon),
}))
jest.mock(
  "@tauri-apps/api/window",
  () => ({
    getCurrentWindow: () => getCurrentWindow(),
  }),
  { virtual: true }
)

// `Image.new` crosses into Rust for a resource handle; the fake records what
// it was built from and whether it was released.
interface FakeImage {
  rgba: Uint8Array
  width: number
  height: number
  close: jest.Mock
}
const imageNew = jest.fn(
  async (rgba: Uint8Array, width: number, height: number): Promise<FakeImage> => ({
    rgba,
    width,
    height,
    close: jest.fn(async () => {}),
  })
)
jest.mock(
  "@tauri-apps/api/image",
  () => ({
    Image: {
      new: (rgba: Uint8Array, width: number, height: number) => imageNew(rgba, width, height),
    },
  }),
  { virtual: true }
)

jest.mock("@/lib/platform/os", () => ({ detectDesktopOsFamily: jest.fn(() => "macos") }))

// The pixels themselves are pinned in `lib/shell/taskbar-badge.test.ts`
// (jsdom has no 2D canvas); here the renderer only reports what it was asked.
const renderTaskbarBadge = jest.fn((count: number, options: { size: number }) => ({
  rgba: new Uint8Array(options.size * options.size * 4).fill(count),
  width: options.size,
  height: options.size,
}))
jest.mock("@/lib/shell/taskbar-badge", () => ({
  badgeIconSize: (ratio: number) => Math.round(16 * ratio),
  readBadgeColors: () => ({ background: "#dc2626", foreground: "#ffffff" }),
  renderTaskbarBadge: (count: number, options: { size: number }) =>
    renderTaskbarBadge(count, options),
}))

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
import { detectDesktopOsFamily } from "@/lib/platform/os"

const isTauriMock = isTauri as jest.Mock
const isMainMock = isMainAppWindow as jest.Mock
const osMock = detectDesktopOsFamily as jest.Mock

beforeEach(() => {
  __resetNavBadgesForTests()
  visibleUnread = { dm: 0, teams: new Map(), total: 0 }
  isTauriMock.mockReturnValue(true)
  isMainMock.mockReturnValue(true)
  setBadgeCount.mockReset().mockResolvedValue(undefined)
  setOverlayIcon.mockReset().mockResolvedValue(undefined)
  getCurrentWindow.mockClear()
  imageNew.mockClear()
  renderTaskbarBadge.mockClear()
  osMock.mockReturnValue("macos")
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

  it("resolves the window once and clears on unmount without importing again", async () => {
    // The unmount clear also runs when Fast Refresh disposes this module,
    // where a fresh dynamic import fails; it must reuse the first writer.
    const { rerender, unmount } = renderHook(({ count }) => useAppBadge(count), {
      initialProps: { count: 2 },
    })
    await waitFor(() => expect(setBadgeCount).toHaveBeenLastCalledWith(2))
    rerender({ count: 4 })
    await waitFor(() => expect(setBadgeCount).toHaveBeenLastCalledWith(4))
    unmount()
    await waitFor(() => expect(setBadgeCount).toHaveBeenLastCalledWith(undefined))
    expect(getCurrentWindow).toHaveBeenCalledTimes(1)
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

describe("useAppBadge on Windows", () => {
  beforeEach(() => {
    osMock.mockReturnValue("windows")
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 })
  })

  it("draws the count as the taskbar overlay icon and releases the image", async () => {
    renderHook(() => useAppBadge(5))
    await waitFor(() => expect(setOverlayIcon).toHaveBeenCalledTimes(1))
    // Drawn at the small-icon size times the display scale.
    expect(renderTaskbarBadge).toHaveBeenCalledWith(5, expect.objectContaining({ size: 32 }))
    expect(imageNew).toHaveBeenCalledWith(expect.any(Uint8Array), 32, 32)
    const image = (await imageNew.mock.results[0].value) as FakeImage
    expect(setOverlayIcon).toHaveBeenCalledWith(image)
    await waitFor(() => expect(image.close).toHaveBeenCalledTimes(1))
    expect(setBadgeCount).not.toHaveBeenCalled()
  })

  it("clears the overlay at zero and on unmount", async () => {
    const { rerender, unmount } = renderHook(({ count }) => useAppBadge(count), {
      initialProps: { count: 2 },
    })
    await waitFor(() => expect(setOverlayIcon).toHaveBeenCalledTimes(1))
    rerender({ count: 0 })
    await waitFor(() => expect(setOverlayIcon).toHaveBeenLastCalledWith(undefined))
    expect(imageNew).toHaveBeenCalledTimes(1)
    rerender({ count: 3 })
    await waitFor(() => expect(setOverlayIcon).toHaveBeenCalledTimes(3))
    unmount()
    await waitFor(() => expect(setOverlayIcon).toHaveBeenCalledTimes(4))
    expect(setOverlayIcon).toHaveBeenLastCalledWith(undefined)
  })

  it("releases the image even when the overlay is refused, and stops after one warning", async () => {
    setOverlayIcon.mockRejectedValue(new Error("missing permission"))
    const { rerender } = renderHook(({ count }) => useAppBadge(count), {
      initialProps: { count: 1 },
    })
    await waitFor(() => expect(warnMock).toHaveBeenCalledTimes(1))
    const image = (await imageNew.mock.results[0].value) as FakeImage
    expect(image.close).toHaveBeenCalledTimes(1)
    rerender({ count: 2 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(setOverlayIcon).toHaveBeenCalledTimes(1)
  })

  it("gives up quietly where no canvas can draw the badge", async () => {
    renderTaskbarBadge.mockImplementationOnce(() => {
      throw new Error("no 2D canvas available in this runtime")
    })
    renderHook(() => useAppBadge(4))
    await waitFor(() => expect(warnMock).toHaveBeenCalledTimes(1))
    expect(setOverlayIcon).not.toHaveBeenCalled()
  })
})
