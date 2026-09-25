/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
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

  // The icon-only badge used to have no accessible name and a hover-only
  // tooltip on a span, so a screen reader heard nothing and a phone could not
  // open the explanation.
  it("names the compact trigger with the signature state", () => {
    render(<PluginSignatureBadge state="unverified" compact />)
    expect(
      screen.getByRole("button", { name: 'ariaLabel:{"state":"unverified"}' })
    ).toBeInTheDocument()
  })

  it("opens the explanation on tap", async () => {
    const user = userEvent.setup()
    render(<PluginSignatureBadge state="failed" signer="Acme" compact />)
    await user.click(screen.getByRole("button"))
    expect(await screen.findByText("failedTooltip")).toBeInTheDocument()
    expect(screen.getByText("Acme")).toBeInTheDocument()
  })
})
