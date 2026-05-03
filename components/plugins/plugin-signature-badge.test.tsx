/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { PluginSignatureBadge } from "./plugin-signature-badge"

describe("PluginSignatureBadge", () => {
  it("renders verified label by default", () => {
    render(<PluginSignatureBadge state="verified" />)
    expect(screen.getByText("verified")).toBeInTheDocument()
  })

  it("renders failed label with destructive variant", () => {
    render(<PluginSignatureBadge state="failed" />)
    expect(screen.getByText("failed")).toBeInTheDocument()
  })

  it("renders unverified label", () => {
    render(<PluginSignatureBadge state="unverified" />)
    expect(screen.getByText("unverified")).toBeInTheDocument()
  })

  it("renders unknown label", () => {
    render(<PluginSignatureBadge state="unknown" />)
    expect(screen.getByText("unknown")).toBeInTheDocument()
  })

  it("compact mode hides the text label", () => {
    render(<PluginSignatureBadge state="verified" compact />)
    expect(screen.queryByText("verified")).not.toBeInTheDocument()
  })
})
