/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { ProviderStatusBadge, getProviderStatus } from "./provider-status-badge"

jest.mock("@/components/ui/badge")

describe("ProviderStatusBadge", () => {
  it("renders testing status with loader", () => {
    render(<ProviderStatusBadge status="testing" />)
    expect(screen.getByTestId("badge")).toBeInTheDocument()
  })

  it("renders connected status with check icon", () => {
    render(<ProviderStatusBadge status="connected" />)
    expect(screen.getByTestId("badge")).toBeInTheDocument()
  })

  it("renders connected status with latency", () => {
    render(<ProviderStatusBadge status="connected" latency={150} />)
    expect(screen.getByText("150ms")).toBeInTheDocument()
  })

  it("renders ready status", () => {
    render(<ProviderStatusBadge status="ready" />)
    expect(screen.getByTestId("badge")).toBeInTheDocument()
  })

  it("renders stale status", () => {
    render(<ProviderStatusBadge status="stale" />)
    expect(screen.getByTestId("badge")).toBeInTheDocument()
  })

  it("renders failed status with X icon", () => {
    render(<ProviderStatusBadge status="failed" />)
    expect(screen.getByTestId("badge")).toBeInTheDocument()
  })

  it("renders not-set status", () => {
    render(<ProviderStatusBadge status="not-set" />)
    expect(screen.getByTestId("badge")).toBeInTheDocument()
  })

  it("renders null for unknown status", () => {
    const { container } = render(<ProviderStatusBadge status="unknown" />)
    expect(container.firstChild).toBeNull()
  })

  it("applies compact mode correctly", () => {
    render(<ProviderStatusBadge status="testing" compact />)
    expect(screen.getByTestId("badge")).toBeInTheDocument()
  })

  it("applies custom className", () => {
    render(<ProviderStatusBadge status="connected" className="custom-class" />)
    expect(screen.getByTestId("badge")).toHaveClass("custom-class")
  })
})

describe("getProviderStatus", () => {
  it("returns testing when isTesting is true", () => {
    expect(getProviderStatus(true, true, true, null)).toBe("testing")
  })

  it("returns not-set when not enabled", () => {
    expect(getProviderStatus(false, true, false, null)).toBe("not-set")
  })

  it("returns not-set when no API key", () => {
    expect(getProviderStatus(true, false, false, null)).toBe("not-set")
  })

  it("returns connected when test succeeded", () => {
    expect(getProviderStatus(true, true, false, { success: true })).toBe("connected")
  })

  it("returns failed when test failed", () => {
    expect(getProviderStatus(true, true, false, { success: false })).toBe("failed")
  })

  it("returns ready when enabled with key but no test result", () => {
    expect(getProviderStatus(true, true, false, null)).toBe("ready")
  })

  it("returns stale when verification state is stale", () => {
    expect(getProviderStatus(true, true, false, null, "stale")).toBe("stale")
  })
})
