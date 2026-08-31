/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const mockProfile = jest.fn(() => "browser")
jest.mock("@/hooks/plugins/use-plugin-runtime-profile", () => ({
  usePluginRuntimeProfile: () => mockProfile(),
}))

import { render, screen } from "@testing-library/react"
import type { PluginManifest } from "@/types/plugin"

import { PluginCompatibilityBadge } from "./plugin-compatibility-badge"

const manifest = (over: Partial<PluginManifest> = {}): PluginManifest =>
  ({
    id: "p1",
    name: "Plugin",
    version: "1.0.0",
    description: "",
    type: "frontend",
    capabilities: [],
    ...over,
  }) as PluginManifest

beforeEach(() => {
  mockProfile.mockReturnValue("browser")
})

describe("PluginCompatibilityBadge", () => {
  // The manager already refuses to auto-enable a plugin with an
  // error-severity runtime diagnostic. Until now nothing said so on screen.
  it("flags a plugin that declares no compatibility for this runtime", () => {
    render(<PluginCompatibilityBadge manifest={manifest()} />)
    const badge = screen.getByTestId("plugin-compatibility-badge")
    expect(badge).toHaveAttribute("data-severity", "error")
    expect(badge).toHaveTextContent("blockedLabel")
  })

  it("flags a declared-degraded plugin as limited rather than blocked", () => {
    render(
      <PluginCompatibilityBadge
        manifest={manifest({
          runtimeCompatibility: { browser: { availability: "degraded", reason: "no fs" } },
        })}
      />
    )
    const badge = screen.getByTestId("plugin-compatibility-badge")
    expect(badge).toHaveAttribute("data-severity", "warning")
    expect(badge).toHaveTextContent("degradedLabel")
  })

  it("renders nothing when the runtime is declared supported", () => {
    render(
      <PluginCompatibilityBadge
        manifest={manifest({ runtimeCompatibility: { browser: { availability: "supported" } } })}
      />
    )
    expect(screen.queryByTestId("plugin-compatibility-badge")).toBeNull()
  })

  // The collector short-circuits on `tauri`, so the desktop render must be
  // untouched no matter what a manifest declares.
  it("renders nothing on the desktop runtime", () => {
    mockProfile.mockReturnValue("tauri")
    render(
      <PluginCompatibilityBadge
        manifest={manifest({ runtimeCompatibility: { browser: { availability: "blocked" } } })}
      />
    )
    expect(screen.queryByTestId("plugin-compatibility-badge")).toBeNull()
  })

  it("renders nothing without a manifest", () => {
    render(<PluginCompatibilityBadge manifest={undefined} />)
    expect(screen.queryByTestId("plugin-compatibility-badge")).toBeNull()
  })

  // A blocked plugin outranks a degraded one when a manifest yields both.
  it("prefers the blocking diagnostic over a warning", () => {
    mockProfile.mockReturnValue("mobile")
    render(
      <PluginCompatibilityBadge
        manifest={manifest({ runtimeCompatibility: { mobile: { availability: "blocked" } } })}
      />
    )
    expect(screen.getByTestId("plugin-compatibility-badge")).toHaveAttribute(
      "data-severity",
      "error"
    )
  })
})
