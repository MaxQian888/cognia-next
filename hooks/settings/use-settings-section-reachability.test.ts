/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { SETTINGS_NAV } from "@/components/settings/settings-nav-config"
import type { Transport } from "@/lib/tauri/transport-types"
import { __resetRoutingForTests, setActiveRemoteTransport } from "@/lib/tauri/transport-routing"

import { useSettingsSectionReachability } from "./use-settings-section-reachability"

let platformMock: "tauri" | "mobile" | "web" = "web"
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => platformMock,
}))

beforeEach(() => {
  __resetRoutingForTests()
  platformMock = "web"
  delete process.env.NEXT_PUBLIC_COGNIA_SERVER_URL
  window.localStorage.clear()
})

afterEach(() => {
  __resetRoutingForTests()
})

describe("useSettingsSectionReachability", () => {
  it("on the desktop every nav item is reachable, in nav order", () => {
    platformMock = "tauri"
    const { result } = renderHook(() => useSettingsSectionReachability())
    expect(result.current.context.profile).toBe("desktop")
    expect(result.current.navItems.map((item) => item.id)).toEqual(SETTINGS_NAV.map((i) => i.id))
    expect(result.current.sections.size).toBe(SETTINGS_NAV.length)
    expect(result.current.isReachable("desktop")).toBe(true)
    expect(result.current.isReachable("automation")).toBe(true)
  })

  it("web-standalone hides host-backed sections but keeps webview-only ones", () => {
    const { result } = renderHook(() => useSettingsSectionReachability())
    expect(result.current.context.profile).toBe("web-standalone")
    expect(result.current.isReachable("terminal")).toBe(false)
    expect(result.current.isReachable("subscription")).toBe(false)
    expect(result.current.isReachable("desktop")).toBe(false)
    expect(result.current.isReachable("ai-connections")).toBe(true)
    expect(result.current.isReachable("appearance")).toBe(true)
    expect(result.current.navItems.length).toBeLessThan(SETTINGS_NAV.length)
  })

  it("a cloud companion reaches what its paired brain executes but not local-shell surfaces", () => {
    process.env.NEXT_PUBLIC_COGNIA_SERVER_URL = "https://cloud.example.com"
    const { result } = renderHook(() => useSettingsSectionReachability())
    expect(result.current.context.profile).toBe("cloud-companion")
    expect(result.current.isReachable("terminal")).toBe(true)
    expect(result.current.isReachable("source-control")).toBe(true)
    expect(result.current.isReachable("connections")).toBe(true)
    expect(result.current.isReachable("automation")).toBe(false)
    expect(result.current.isReachable("desktop")).toBe(false)
    expect(result.current.isReachable("companion")).toBe(false)
  })

  it("recomputes when the desktop starts driving a remote host, and is memoised otherwise", () => {
    platformMock = "tauri"
    const { result, rerender } = renderHook(() => useSettingsSectionReachability())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)

    const remote: Transport = { call: jest.fn(), subscribe: jest.fn(() => () => undefined) }
    act(() => setActiveRemoteTransport(remote))
    expect(result.current).not.toBe(first)
    // Still the desktop profile — local capabilities keep every section reachable.
    expect(result.current.sections.size).toBe(SETTINGS_NAV.length)
  })
})
