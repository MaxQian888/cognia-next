/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const applyPolicy = jest.fn()
jest.mock("@/lib/plugin/core/policy-runtime", () => ({
  applyPluginPolicyToRuntime: (...args: unknown[]) => applyPolicy(...args),
}))

const mockSetPluginSecurityPosture = jest.fn()
let mockPluginPosture: "strict" | "balanced" | undefined
let mockSettingsLoaded = true
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({
      loaded: mockSettingsLoaded,
      settings: mockPluginPosture ? { pluginSecurityPosture: mockPluginPosture } : null,
      setPluginSecurityPosture: mockSetPluginSecurityPosture,
    }),
}))

import { PluginGovernancePolicyTab } from "./plugin-governance-policy-tab"

beforeEach(() => {
  window.localStorage.clear()
  applyPolicy.mockReset()
  mockSetPluginSecurityPosture.mockReset()
  mockPluginPosture = undefined
  mockSettingsLoaded = true
})

// Switch order: [0] governance, [1] signatureRequired, [2] trustedPublishersOnly,
// [3] autoUpdate, [4] security posture (strict sandboxing).
describe("PluginGovernancePolicyTab", () => {
  it("toggling governance persists block to localStorage", () => {
    render(<PluginGovernancePolicyTab />)
    fireEvent.click(screen.getAllByRole("switch")[0])
    const stored = window.localStorage.getItem("cognia.plugins.policy")
    expect(JSON.parse(stored as string).governance).toBe("block")
  })

  it("signature-required toggle persists (default-on → false)", () => {
    render(<PluginGovernancePolicyTab />)
    fireEvent.click(screen.getAllByRole("switch")[1])
    const stored = window.localStorage.getItem("cognia.plugins.policy")
    expect(JSON.parse(stored as string).signatureRequired).toBe(false)
  })

  it("trusted-publishers-only toggle persists", () => {
    render(<PluginGovernancePolicyTab />)
    fireEvent.click(screen.getAllByRole("switch")[2])
    const stored = window.localStorage.getItem("cognia.plugins.policy")
    expect(JSON.parse(stored as string).trustedPublishersOnly).toBe(true)
  })

  it("auto-update toggle persists", () => {
    render(<PluginGovernancePolicyTab />)
    fireEvent.click(screen.getAllByRole("switch")[3])
    const stored = window.localStorage.getItem("cognia.plugins.policy")
    expect(JSON.parse(stored as string).autoUpdate).toBe(true)
  })

  it("security-posture toggle sets the strict posture via the settings store", () => {
    render(<PluginGovernancePolicyTab />)
    const sw = screen.getAllByRole("switch")[4]
    expect(sw).not.toBeChecked()
    fireEvent.click(sw)
    expect(mockSetPluginSecurityPosture).toHaveBeenCalledWith("strict")
  })

  it("reflects an already-strict posture as checked", () => {
    mockPluginPosture = "strict"
    render(<PluginGovernancePolicyTab />)
    const sw = screen.getAllByRole("switch")[4]
    expect(sw).toBeChecked()
    fireEvent.click(sw)
    expect(mockSetPluginSecurityPosture).toHaveBeenCalledWith("balanced")
  })

  it("applies the persisted snapshot to the runtime on mount", () => {
    window.localStorage.setItem(
      "cognia.plugins.policy",
      JSON.stringify({ governance: "block", signatureRequired: true, autoUpdate: true })
    )
    render(<PluginGovernancePolicyTab />)
    expect(applyPolicy).toHaveBeenCalledWith({
      governance: "block",
      signatureRequired: true,
      trustedPublishersOnly: false,
      trustedFrontendPlugins: [],
      autoUpdate: true,
    })
  })

  it("re-applies the snapshot to the runtime after each toggle", () => {
    render(<PluginGovernancePolicyTab />)
    applyPolicy.mockClear()
    fireEvent.click(screen.getAllByRole("switch")[0])
    expect(applyPolicy).toHaveBeenLastCalledWith(expect.objectContaining({ governance: "block" }))
  })

  // A strict user must not see "off" while the settings store is loading.
  it("holds the posture switch behind a loading state until settings load", () => {
    mockSettingsLoaded = false
    mockPluginPosture = "strict"
    render(<PluginGovernancePolicyTab />)
    expect(screen.getAllByRole("switch")).toHaveLength(4)
    expect(screen.getByTestId("plugin-governance-posture-loading")).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("securityPostureLoading")
  })

  // Flat rows, no card: the pane is already the surface.
  it("renders flat hairline rows rather than a card", () => {
    render(<PluginGovernancePolicyTab />)
    const root = screen.getByTestId("plugin-governance-policy")
    expect(root.querySelector("[data-slot='card']")).toBeNull()
    expect(root).toHaveClass("@container")
    expect(root.querySelector(".divide-y")).not.toBeNull()
  })
})
