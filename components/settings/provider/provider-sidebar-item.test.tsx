/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { ProviderSidebarItem } from "./provider-sidebar-item"

jest.mock("next-intl", () => ({
  // Mirrors the real `providers.sidebar` namespace keys the component reads.
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      statusConnected: "Connected",
      statusWarning: "Warning",
      statusUnconfigured: "Unconfigured",
      statusError: "Error",
      reasonConnected: "Connection verified",
      reasonWarning: "Configured but not verified — open to test the connection",
      reasonUnconfigured: "Add an API key to start using this provider",
      reasonError: "Last connection test failed — open to review the error",
    }
    return map[key] ?? key
  },
}))

describe("ProviderSidebarItem", () => {
  const defaultProps = {
    providerId: "openai",
    name: "OpenAI",
    icon: "🤖",
    subtitle: "GPT-4o · Connected",
    status: "connected" as const,
    isSelected: false,
    onClick: jest.fn(),
  }

  it("renders provider name and subtitle", () => {
    render(<ProviderSidebarItem {...defaultProps} />)
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
    expect(screen.getByText("GPT-4o · Connected")).toBeInTheDocument()
  })

  it("shows green status dot when connected", () => {
    const { container } = render(<ProviderSidebarItem {...defaultProps} />)
    const dot = container.querySelector('[data-status="connected"]')
    expect(dot).toBeInTheDocument()
  })

  it("shows red status dot when not configured", () => {
    const { container } = render(
      <ProviderSidebarItem {...defaultProps} status="not-configured" subtitle="Not configured" />
    )
    const dot = container.querySelector('[data-status="not-configured"]')
    expect(dot).toBeInTheDocument()
  })

  it("applies selected styling when isSelected is true", () => {
    const { container } = render(<ProviderSidebarItem {...defaultProps} isSelected />)
    expect(container.firstChild).toHaveClass("bg-primary")
  })

  it("calls onClick when clicked", () => {
    render(<ProviderSidebarItem {...defaultProps} />)
    fireEvent.click(screen.getByText("OpenAI"))
    expect(defaultProps.onClick).toHaveBeenCalledWith("openai")
  })

  it("surfaces the status reason as a tooltip on the status badge", () => {
    const { container } = render(<ProviderSidebarItem {...defaultProps} status="warning" />)
    const badge = container.querySelector('[data-status="warning"]')
    expect(badge).toHaveAttribute(
      "title",
      "Configured but not verified — open to test the connection"
    )
    expect(badge).toHaveAttribute(
      "aria-label",
      "Warning — Configured but not verified — open to test the connection"
    )
  })

  it("explains a not-configured provider via the badge tooltip", () => {
    const { container } = render(<ProviderSidebarItem {...defaultProps} status="not-configured" />)
    const badge = container.querySelector('[data-status="not-configured"]')
    expect(badge).toHaveAttribute("title", "Add an API key to start using this provider")
  })
})
