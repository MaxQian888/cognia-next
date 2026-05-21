/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { SubPageShell } from "./sub-page-shell"

describe("<SubPageShell />", () => {
  it("renders the title, back link, and children", () => {
    render(
      <SubPageShell title="同步状态" backAria="Back to Me" testid="shell-sync">
        <div data-testid="body">body content</div>
      </SubPageShell>
    )
    expect(screen.getByText("同步状态")).toBeInTheDocument()
    expect(screen.getByTestId("body")).toBeInTheDocument()
    const back = screen.getByTestId("mobile-sub-page-back")
    expect(back).toHaveAttribute("aria-label", "Back to Me")
  })

  it("back link defaults to /me", () => {
    render(
      <SubPageShell title="备份" backAria="Back">
        body
      </SubPageShell>
    )
    expect(screen.getByRole("link")).toHaveAttribute("href", "/me")
  })

  it("respects a custom backHref", () => {
    render(
      <SubPageShell title="离线" backAria="Back" backHref="/">
        body
      </SubPageShell>
    )
    expect(screen.getByRole("link")).toHaveAttribute("href", "/")
  })

  it("renders the headerAccessory slot when provided", () => {
    render(
      <SubPageShell
        title="Connectors"
        backAria="Back"
        headerAccessory={<div data-testid="accessory">badge</div>}
      >
        body
      </SubPageShell>
    )
    expect(screen.getByTestId("accessory")).toBeInTheDocument()
  })

  it("respects bodyClassName override", () => {
    const { container } = render(
      <SubPageShell title="X" backAria="Back" bodyClassName="px-2 py-2">
        body
      </SubPageShell>
    )
    expect(container.querySelector("section")?.className).toMatch(/px-2/)
  })
})
