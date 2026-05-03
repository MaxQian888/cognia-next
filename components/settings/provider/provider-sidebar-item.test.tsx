/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { ProviderSidebarItem } from "./provider-sidebar-item"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    if (key === "detailPanel.notConfigured") return "Not configured"
    return key
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
})
