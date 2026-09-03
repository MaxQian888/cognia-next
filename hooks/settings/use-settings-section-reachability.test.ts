/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import { SETTINGS_NAV } from "@/components/settings/settings-nav-config"
import { notifyRemoteHostPairingChanged } from "@/lib/platform/remote-host-pairing"
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

  it("a browser paired through Settings > Remote hosts reaches host-backed sections", () => {
    // The bug this pins: the pairing lives in the remote-host registry, and
    // `activeHostId` is not persisted, so after a reload the client had a host
    // and no active transport. Reading only the credential book called that
    // web-standalone, and Settings told a paired user that the host they are
    // connected to does not provide any of this.
    window.localStorage.setItem(
      "cognia-remote-hosts",
      JSON.stringify({
        version: 3,
        state: {
          hosts: [
            {
              id: "host-1",
              label: "Brain",
              config: {
                baseUrl: "https://brain.example:27890",
                deviceId: "device-1",
                deviceKeyThumbprint: "thumb-1",
                serverVersion: "1.0.0",
              },
            },
          ],
        },
      })
    )
    const { result } = renderHook(() => useSettingsSectionReachability())
    expect(result.current.context.profile).toBe("cloud-companion")
    expect(result.current.isReachable("terminal")).toBe(true)
    expect(result.current.isReachable("tools")).toBe(true)
    expect(result.current.isReachable("source-control")).toBe(true)
    expect(result.current.isReachable("connections")).toBe(true)
    expect(result.current.isReachable("subscription")).toBe(true)
    expect(result.current.isReachable("webhooks")).toBe(true)
    // Still refused, and honestly so: these administer the local desktop shell.
    expect(result.current.isReachable("desktop")).toBe(false)
    expect(result.current.isReachable("automation")).toBe(false)
    // And the refusals are told apart, so the shell can stop promising a
    // paired user that pairing a host would open a desktop-pinned section.
    expect(result.current.blockReason("desktop")).toBe("profile")
    expect(result.current.blockReason("automation")).toBe("capability")
    expect(result.current.blockReason("terminal")).toBeNull()
  })

  it("widens while mounted when a pairing lands, without a reload", () => {
    // The other half of the same bug: detection was also only ever run once.
    // A user who pairs from Settings stays on that page, so if the answer only
    // widens on reload they see the refusal copy right after succeeding.
    const { result } = renderHook(() => useSettingsSectionReachability())
    expect(result.current.context.profile).toBe("web-standalone")
    expect(result.current.isReachable("terminal")).toBe(false)
    act(() => {
      window.localStorage.setItem(
        "cognia-remote-hosts",
        JSON.stringify({
          version: 3,
          state: {
            hosts: [
              {
                id: "host-1",
                label: "Brain",
                config: {
                  baseUrl: "https://brain.example:27890",
                  deviceId: "device-1",
                  deviceKeyThumbprint: "thumb-1",
                },
              },
            ],
          },
        })
      )
      notifyRemoteHostPairingChanged()
    })
    expect(result.current.context.profile).toBe("cloud-companion")
    expect(result.current.isReachable("terminal")).toBe(true)
  })

  it("has no block reason for a section id the nav does not carry", () => {
    // `general` / `api-key` / `profile` were merged away; the shell redirects
    // them before dispatch, so an id it never renders must not claim a pin.
    const { result } = renderHook(() => useSettingsSectionReachability())
    expect(result.current.blockReason("general")).toBeNull()
    expect(result.current.isReachable("general")).toBe(false)
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
