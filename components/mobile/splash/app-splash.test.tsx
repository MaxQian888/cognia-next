import { act, render, screen } from "@testing-library/react"

import { __resetBootProgressForTesting } from "@/lib/boot/boot-progress"
import {
  __resetMobileBootForTesting,
  beginMobileBootStage,
  endMobileBootStage,
  getMobileBootSnapshot,
  markMobileBootIntroPlayed,
  markMobileBootSettled,
} from "@/lib/boot/mobile-boot-stages"

import { AppSplash, FADE_MS, MAX_HOLD_MS, MIN_HOLD_MS } from "./app-splash"
import { __resetMobileBootScreenForTesting, MOBILE_SPLASH_BACKDROP } from "./mobile-boot-screen"

// `usePlatform` drives the mobile gate; flip it per test. (Jest allows factory
// references to variables prefixed with `mock`.)
let mockPlatform: "mobile" | "web" | "tauri" = "mobile"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => mockPlatform,
}))

jest.mock("@/lib/capacitor/status-bar", () => ({
  syncWithTheme: jest.fn(async () => ({ kind: "ok" })),
}))
jest.mock("@/lib/capacitor/navigation-bar", () => ({
  syncWithTheme: jest.fn(async () => ({ kind: "ok" })),
}))
jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => ({ loading: false, status: { connected: true, connectionType: "wifi" } }),
}))

import { syncWithTheme as syncNavBar } from "@/lib/capacitor/navigation-bar"
import { syncWithTheme as syncStatusBar } from "@/lib/capacitor/status-bar"

const syncStatusBarMock = syncStatusBar as jest.Mock
const syncNavBarMock = syncNavBar as jest.Mock

describe("AppSplash", () => {
  beforeEach(() => {
    mockPlatform = "mobile"
    __resetBootProgressForTesting()
    __resetMobileBootForTesting()
    __resetMobileBootScreenForTesting()
    syncStatusBarMock.mockClear()
    syncNavBarMock.mockClear()
    jest.useFakeTimers()
  })

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers()
    })
    jest.useRealTimers()
  })

  it("renders the branded boot screen as a status overlay on the mobile shell", () => {
    render(<AppSplash />)

    const splash = screen.getByTestId("app-splash")
    expect(splash).toHaveAttribute("data-state", "running")
    expect(splash).toHaveAttribute("data-layout", "boot")
    expect(screen.getByRole("status", { name: "Starting cognia" })).toBe(splash)
    expect(splash.querySelector(".mboot__logo")).not.toBeNull()
    expect(screen.getByRole("list", { name: "Startup steps" })).toBeInTheDocument()
    // It announces itself to the boot store so the theme sync stands aside.
    expect(getMobileBootSnapshot().overlayVisible).toBe(true)
  })

  it("renders nothing off the mobile shell (web / Tauri / SSR)", () => {
    mockPlatform = "web"
    const { container } = render(<AppSplash />)
    expect(container).toBeEmptyDOMElement()
    expect(getMobileBootSnapshot().overlayVisible).toBe(false)
  })

  it("leaves as soon as the boot settles once the floor has passed, then unmounts", () => {
    markMobileBootIntroPlayed()
    render(<AppSplash />)

    // Settled early: still held until MIN_HOLD_MS so a fast boot isn't a flash.
    act(() => {
      markMobileBootSettled()
      jest.advanceTimersByTime(MIN_HOLD_MS - 1)
    })
    expect(screen.getByTestId("app-splash")).toHaveAttribute("data-state", "settled")
    expect(getMobileBootSnapshot().overlayVisible).toBe(true)

    act(() => {
      jest.advanceTimersByTime(1)
    })
    const leaving = screen.getByTestId("app-splash")
    expect(leaving).toHaveAttribute("data-state", "leaving")
    expect(leaving).toHaveClass("mboot--leaving")
    // The flag drops the moment the fade starts, not when it ends.
    expect(getMobileBootSnapshot().overlayVisible).toBe(false)

    act(() => {
      jest.advanceTimersByTime(FADE_MS)
    })
    expect(screen.queryByTestId("app-splash")).not.toBeInTheDocument()
  })

  it("waits for the boot to settle after the floor, and reacts the moment it does", () => {
    render(<AppSplash />)
    act(() => {
      jest.advanceTimersByTime(MIN_HOLD_MS + 500)
    })
    expect(screen.getByTestId("app-splash")).toHaveAttribute("data-state", "running")

    act(() => {
      markMobileBootSettled()
    })
    expect(screen.getByTestId("app-splash")).toHaveAttribute("data-state", "leaving")
  })

  it("never waits past the ceiling, even when no stage ever reports back", () => {
    render(<AppSplash />)
    act(() => {
      jest.advanceTimersByTime(MAX_HOLD_MS - 1)
    })
    expect(screen.getByTestId("app-splash")).toHaveAttribute("data-state", "running")
    act(() => {
      jest.advanceTimersByTime(1)
    })
    expect(screen.getByTestId("app-splash")).toHaveAttribute("data-state", "leaving")
    act(() => {
      jest.advanceTimersByTime(FADE_MS)
    })
    expect(screen.queryByTestId("app-splash")).not.toBeInTheDocument()
  })

  it("paints the status and navigation bars to its canvas once the native bridge is registered", () => {
    render(<AppSplash />)
    // Before the bridge: the plugin proxies don't exist yet, so nothing is pushed.
    expect(syncStatusBarMock).not.toHaveBeenCalled()

    act(() => {
      beginMobileBootStage("bridge")
      endMobileBootStage("bridge", { detail: "registered" })
    })
    expect(syncStatusBarMock).toHaveBeenCalledWith("dark", MOBILE_SPLASH_BACKDROP)
    expect(syncNavBarMock).toHaveBeenCalledWith("dark", MOBILE_SPLASH_BACKDROP)
    expect(syncStatusBarMock).toHaveBeenCalledTimes(1)

    // A bridge that never registers leaves the chrome alone.
    syncStatusBarMock.mockClear()
    act(() => {
      markMobileBootSettled()
      jest.advanceTimersByTime(MIN_HOLD_MS)
    })
    expect(syncStatusBarMock).not.toHaveBeenCalled()
  })

  it("does not touch the chrome when the bridge reports unavailable", () => {
    render(<AppSplash />)
    act(() => {
      beginMobileBootStage("bridge")
      endMobileBootStage("bridge", { status: "failed", detail: "unavailable" })
    })
    expect(syncStatusBarMock).not.toHaveBeenCalled()
  })
})
