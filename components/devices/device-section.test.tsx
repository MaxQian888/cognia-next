import { render, screen } from "@testing-library/react"
import { BoxIcon } from "lucide-react"

import { DeviceSection } from "./device-section"

describe("DeviceSection", () => {
  it("labels the card and exposes an anchor for the section", () => {
    render(
      <DeviceSection id="identity" title="Identity">
        <p>body</p>
      </DeviceSection>
    )
    const section = screen.getByTestId("device-section-identity")
    expect(section).toHaveAttribute("id", "device-section-identity")
    expect(screen.getByRole("heading", { name: "Identity" })).toBeInTheDocument()
    expect(screen.getByText("body")).toBeInTheDocument()
  })

  it("renders the optional meta and description only when given", () => {
    const { rerender } = render(
      <DeviceSection id="caps" title="Capabilities">
        <p>body</p>
      </DeviceSection>
    )
    expect(screen.queryByText("4/20")).not.toBeInTheDocument()

    rerender(
      <DeviceSection id="caps" title="Capabilities" meta="4/20" description="what it reports">
        <p>body</p>
      </DeviceSection>
    )
    expect(screen.getByText("4/20")).toBeInTheDocument()
    expect(screen.getByText("what it reports")).toBeInTheDocument()
  })

  /**
   * The icon is decoration beside a heading that already names the section,
   * so it must not be announced — a screen reader reading "box, Sandbox" is
   * strictly worse than "Sandbox".
   */
  it("hides the decorative icon from assistive tech", () => {
    const { container } = render(
      <DeviceSection id="sandbox" title="Sandbox" icon={BoxIcon}>
        <p>body</p>
      </DeviceSection>
    )
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true")
  })

  /**
   * `wide` is a layout hint the grid interprets, not a span number the caller
   * picks — callers choosing their own `col-span-*` is how a grid ends up
   * with one card that never lines up with the rest.
   */
  it("opts a wide card out of the column split", () => {
    render(
      <DeviceSection id="caps" title="Capabilities" wide>
        <p>body</p>
      </DeviceSection>
    )
    expect(screen.getByTestId("device-section-caps").className).toContain(
      "@3xl/device-pane:col-span-2"
    )
  })

  it("leaves a normal card in a single column", () => {
    render(
      <DeviceSection id="identity" title="Identity">
        <p>body</p>
      </DeviceSection>
    )
    expect(screen.getByTestId("device-section-identity").className).not.toContain("col-span")
  })
})
