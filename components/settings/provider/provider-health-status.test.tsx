/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { ProviderHealthStatus } from "./provider-health-status"

const mockState: {
  providerSettings: Record<string, Record<string, unknown> | undefined>
} = { providerSettings: {} }

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: typeof mockState) => unknown) => selector(mockState),
}))

jest.mock("@/lib/utils", () => ({
  cn: (...args: Array<string | undefined | false | null>) => args.filter(Boolean).join(" "),
}))

jest.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="badge">{children}</span>
  ),
}))

describe("ProviderHealthStatus", () => {
  beforeEach(() => {
    mockState.providerSettings = {}
  })

  it("renders Unknown when the provider has no key and no baseURL", () => {
    mockState.providerSettings.openai = {}
    render(<ProviderHealthStatus providerId="openai" />)
    expect(screen.getByTestId("badge")).toHaveTextContent("Unknown")
  })

  it("renders Verified when verificationStatus is 'verified'", () => {
    mockState.providerSettings.openai = { apiKey: "k", verificationStatus: "verified" }
    render(<ProviderHealthStatus providerId="openai" />)
    expect(screen.getByTestId("badge")).toHaveTextContent("Verified")
  })

  it("renders Stale when verificationStatus is 'stale'", () => {
    mockState.providerSettings.openai = { apiKey: "k", verificationStatus: "stale" }
    render(<ProviderHealthStatus providerId="openai" />)
    expect(screen.getByTestId("badge")).toHaveTextContent("Stale")
  })

  it("renders Error when healthStatus is 'error'", () => {
    mockState.providerSettings.openai = { apiKey: "k", healthStatus: "error" }
    render(<ProviderHealthStatus providerId="openai" />)
    expect(screen.getByTestId("badge")).toHaveTextContent("Error")
  })

  it("treats a baseURL-only provider (no apiKey) as known and falls through status rules", () => {
    mockState.providerSettings.ollama = {
      baseURL: "http://localhost:11434",
      verificationStatus: "verified",
    }
    render(<ProviderHealthStatus providerId="ollama" />)
    expect(screen.getByTestId("badge")).toHaveTextContent("Verified")
  })

  it("compact mode renders the upper-cased status as the badge label", () => {
    mockState.providerSettings.openai = { apiKey: "k", verificationStatus: "verified" }
    render(<ProviderHealthStatus providerId="openai" compact />)
    expect(screen.getByTestId("badge")).toHaveTextContent("HEALTHY")
  })

  it("forwards className to the wrapper element", () => {
    mockState.providerSettings.openai = { apiKey: "k", verificationStatus: "verified" }
    const { container } = render(<ProviderHealthStatus providerId="openai" className="my-marker" />)
    expect(container.firstChild).toHaveClass("my-marker")
  })

  it("renders Unknown when the provider settings are missing entirely", () => {
    render(<ProviderHealthStatus providerId="anthropic" />)
    expect(screen.getByTestId("badge")).toHaveTextContent("Unknown")
  })
})
