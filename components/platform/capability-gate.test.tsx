/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { CapabilityGate } from "./capability-gate"
import type { HostProfile } from "@/lib/platform/capabilities"

let profileMock: HostProfile = "desktop"
jest.mock("@/hooks/use-host-profile", () => ({
  useHostProfile: () => profileMock,
  useCapability: (cap: string) => {
    const byProfile: Record<HostProfile, string[]> = {
      desktop: ["webview", "ocr", "shell", "sidecar", "uia-automation"],
      "mobile-companion": ["webview", "sidecar", "shell"],
      "cloud-companion": ["webview", "sidecar", "shell"],
      "web-standalone": ["webview"],
      headless: ["shell", "sidecar", "always-on", "connector-runtime", "mcp-runtime", "headless"],
    }
    return byProfile[profileMock].includes(cap)
  },
}))

beforeEach(() => {
  profileMock = "desktop"
})

describe("<CapabilityGate />", () => {
  it("renders children when the capability is available", () => {
    render(
      <CapabilityGate capability="ocr">
        <div data-testid="gated" />
      </CapabilityGate>
    )
    expect(screen.getByTestId("gated")).toBeInTheDocument()
  })

  it("renders the fallback when the capability is missing", () => {
    profileMock = "cloud-companion"
    render(
      <CapabilityGate capability="ocr" fallback={<div data-testid="fallback" />}>
        <div data-testid="gated" />
      </CapabilityGate>
    )
    expect(screen.queryByTestId("gated")).not.toBeInTheDocument()
    expect(screen.getByTestId("fallback")).toBeInTheDocument()
  })

  it("renders nothing on a failed gate without a fallback", () => {
    profileMock = "web-standalone"
    const { container } = render(
      <CapabilityGate capability="sidecar">
        <div data-testid="gated" />
      </CapabilityGate>
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("gates by host profile", () => {
    profileMock = "cloud-companion"
    render(
      <CapabilityGate profiles={["desktop"]}>
        <div data-testid="desktop-only" />
      </CapabilityGate>
    )
    expect(screen.queryByTestId("desktop-only")).not.toBeInTheDocument()
  })

  it("requires BOTH capability and profile when both are given", () => {
    profileMock = "cloud-companion"
    render(
      <CapabilityGate capability="sidecar" profiles={["desktop", "cloud-companion"]}>
        <div data-testid="both" />
      </CapabilityGate>
    )
    expect(screen.getByTestId("both")).toBeInTheDocument()
  })

  it("with no props renders children everywhere", () => {
    profileMock = "web-standalone"
    render(
      <CapabilityGate>
        <div data-testid="open" />
      </CapabilityGate>
    )
    expect(screen.getByTestId("open")).toBeInTheDocument()
  })
})
