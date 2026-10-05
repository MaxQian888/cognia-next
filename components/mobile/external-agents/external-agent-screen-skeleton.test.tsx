/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import { ExternalAgentScreenSkeleton } from "./external-agent-screen-skeleton"

describe("ExternalAgentScreenSkeleton", () => {
  it("announces a busy screen instead of rendering nothing", () => {
    render(<ExternalAgentScreenSkeleton />)
    const skeleton = screen.getByRole("status", { name: "Loading external agents…" })
    expect(skeleton).toHaveAttribute("aria-busy", "true")
    expect(skeleton).toHaveAttribute("data-testid", "external-agent-screen-skeleton")
  })

  it("takes the page's own test id", () => {
    render(<ExternalAgentScreenSkeleton testid="configure-skeleton" />)
    expect(screen.getByTestId("configure-skeleton")).toBeInTheDocument()
  })
})
