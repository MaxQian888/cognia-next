/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

jest.mock("@/lib/plugin/core/set-plugin-enabled-for-host", () => ({
  isMirroredPluginClient: jest.fn(() => false),
}))
jest.mock("./use-plugin-runtime-profile", () => ({
  usePluginRuntimeProfile: jest.fn(() => "browser"),
}))

import { isMirroredPluginClient } from "@/lib/plugin/core/set-plugin-enabled-for-host"

import {
  evaluatePluginEnableGate,
  useEffectivePluginRuntimeProfile,
  usePluginEnableGate,
} from "./use-plugin-enable-gate"
import { usePluginRuntimeProfile } from "./use-plugin-runtime-profile"

const desktopOnly = {
  id: "desk",
  runtimeCompatibility: {
    tauri: { availability: "supported" },
    browser: { availability: "unsupported", reason: "Needs the native shell" },
  },
}
const everywhere = {
  id: "all",
  runtimeCompatibility: {
    tauri: { availability: "supported" },
    browser: { availability: "supported" },
    mobile: { availability: "supported" },
  },
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(isMirroredPluginClient as jest.Mock).mockReturnValue(false)
  ;(usePluginRuntimeProfile as jest.Mock).mockReturnValue("browser")
})

describe("evaluatePluginEnableGate", () => {
  it("blocks a plugin whose manifest refuses the profile, with the author's reason", () => {
    const gate = evaluatePluginEnableGate(desktopOnly, "browser")
    expect(gate.blocked).toBe(true)
    expect(gate.authorReason).toBe("Needs the native shell")
  })

  it("inherits the browser reason on mobile when mobile is undeclared", () => {
    expect(evaluatePluginEnableGate(desktopOnly, "mobile").authorReason).toBe(
      "Needs the native shell"
    )
  })

  it("never blocks on the desktop profile", () => {
    expect(evaluatePluginEnableGate(desktopOnly, "tauri").blocked).toBe(false)
  })

  it("allows a supported plugin and an absent manifest", () => {
    expect(evaluatePluginEnableGate(everywhere, "browser").blocked).toBe(false)
    expect(evaluatePluginEnableGate(undefined, "browser").blocked).toBe(false)
  })
})

describe("usePluginEnableGate", () => {
  it("gives a localized reason when blocked on this host", () => {
    const { result } = renderHook(() => usePluginEnableGate({ manifest: desktopOnly }))
    expect(result.current.blocked).toBe(true)
    expect(result.current.runsOnDesktop).toBe(false)
    expect(result.current.reason).toContain("browser runtime")
  })

  it("judges a mirrored client against the desktop profile and says so", () => {
    ;(isMirroredPluginClient as jest.Mock).mockReturnValue(true)
    ;(usePluginRuntimeProfile as jest.Mock).mockReturnValue("mobile")
    const { result } = renderHook(() => usePluginEnableGate({ manifest: desktopOnly }))
    expect(result.current.blocked).toBe(false)
    expect(result.current.reason).toBeNull()
    expect(result.current.runsOnDesktop).toBe(true)
    expect(result.current.profile).toBe("tauri")
  })
})

describe("useEffectivePluginRuntimeProfile", () => {
  it("is this host's profile on an authority host", () => {
    ;(usePluginRuntimeProfile as jest.Mock).mockReturnValue("mobile")
    const { result } = renderHook(() => useEffectivePluginRuntimeProfile())
    expect(result.current).toBe("mobile")
  })
})
