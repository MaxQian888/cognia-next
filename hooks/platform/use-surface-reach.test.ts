/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

import { useSurfaceReach } from "./use-surface-reach"
import type { HostProfile } from "@/lib/platform/capabilities"

let profileMock: HostProfile = "desktop"
let capabilityMock = true
jest.mock("@/hooks/use-host-profile", () => ({
  useHostProfile: () => profileMock,
  useCapability: () => capabilityMock,
}))

beforeEach(() => {
  profileMock = "desktop"
  capabilityMock = true
})

describe("useSurfaceReach", () => {
  it("passes the live profile and capability through to the resolver", () => {
    const { result } = renderHook(() => useSurfaceReach({ capability: "pro-ide" }))
    expect(result.current).toEqual({ available: true })
  })

  it("reports why a standalone browser cannot run the surface", () => {
    profileMock = "web-standalone"
    capabilityMock = false
    const { result } = renderHook(() => useSurfaceReach({ capability: "pro-ide" }))
    expect(result.current).toEqual({ available: false, block: "no-host", remedy: "/pair" })
  })

  it("lets a runtime host answer override the static baseline", () => {
    // The whole reason the override exists: the static server-backed list is
    // deliberately conservative, so a capability the paired host advertises at
    // runtime would otherwise read as missing.
    profileMock = "mobile-companion"
    capabilityMock = false
    const { result } = renderHook(() =>
      useSurfaceReach({ capability: "pro-ide", hostProvides: true })
    )
    expect(result.current.available).toBe(true)
  })

  it("does not let the override rescue a standalone browser", () => {
    // There is no host to have advertised anything.
    profileMock = "web-standalone"
    const { result } = renderHook(() =>
      useSurfaceReach({ capability: "pro-ide", hostProvides: true })
    )
    expect(result.current.block).toBe("no-host")
  })

  it("carries the desktop-shell requirement through", () => {
    profileMock = "cloud-companion"
    const { result } = renderHook(() =>
      useSurfaceReach({ capability: "pro-ide", requirement: "desktop-shell" })
    )
    expect(result.current.block).toBe("needs-desktop-shell")
  })
})
