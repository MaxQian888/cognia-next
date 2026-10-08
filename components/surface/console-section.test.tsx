import { render, screen } from "@testing-library/react"
import { BoxIcon } from "lucide-react"

import { ConsoleSection } from "./console-section"

describe("ConsoleSection", () => {
  it("labels the card and exposes an anchor for the section", () => {
    render(
      <ConsoleSection id="roots" title="Roots">
        <p>body</p>
      </ConsoleSection>
    )
    const section = screen.getByTestId("console-section-roots")
    expect(section).toHaveAttribute("id", "console-section-roots")
    expect(screen.getByRole("heading", { name: "Roots" })).toBeInTheDocument()
    expect(screen.getByText("body")).toBeInTheDocument()
  })

  it("renders the optional meta and description only when given", () => {
    const { rerender } = render(
      <ConsoleSection id="caps" title="Capabilities">
        <p>body</p>
      </ConsoleSection>
    )
    expect(screen.queryByText("4/20")).not.toBeInTheDocument()

    rerender(
      <ConsoleSection id="caps" title="Capabilities" meta="4/20" description="what it reports">
        <p>body</p>
      </ConsoleSection>
    )
    expect(screen.getByText("4/20")).toBeInTheDocument()
    expect(screen.getByText("what it reports")).toBeInTheDocument()
  })

  it("hides the decorative icon from assistive tech", () => {
    const { container } = render(
      <ConsoleSection id="sandbox" title="Sandbox" icon={BoxIcon}>
        <p>body</p>
      </ConsoleSection>
    )
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true")
  })

  /**
   * The span class has to name the pane it is laid out by. An interpolated
   * `@3xl/${pane}` emits nothing at all, which is a card that silently stops
   * spanning rather than a build error.
   */
  it("spans a wide card in whichever pane owns it", () => {
    const { rerender } = render(
      <ConsoleSection id="caps" title="Capabilities" wide>
        <p>body</p>
      </ConsoleSection>
    )
    expect(screen.getByTestId("console-section-caps").className).toContain(
      "@3xl/console-pane:col-span-2"
    )

    rerender(
      <ConsoleSection id="caps" title="Capabilities" wide pane="workspace-pane">
        <p>body</p>
      </ConsoleSection>
    )
    expect(screen.getByTestId("console-section-caps").className).toContain(
      "@3xl/workspace-pane:col-span-2"
    )
  })

  it("leaves a normal card in a single column", () => {
    render(
      <ConsoleSection id="roots" title="Roots">
        <p>body</p>
      </ConsoleSection>
    )
    expect(screen.getByTestId("console-section-roots").className).not.toContain("col-span")
  })

  /**
   * `idPrefix` is what lets `DeviceSection` keep its published anchors while
   * the frame moves here. Losing it would break every `#device-section-*` link.
   */
  it("honours a caller-supplied id prefix", () => {
    render(
      <ConsoleSection id="access" title="Access" idPrefix="device-section">
        <p>body</p>
      </ConsoleSection>
    )
    expect(screen.getByTestId("device-section-access")).toHaveAttribute(
      "id",
      "device-section-access"
    )
  })

  /**
   * The card carries the surface tier rather than a hardcoded `bg-card`, which
   * is what makes it answer to style packs and the elevation setting.
   */
  it("renders on the raised surface tier", () => {
    render(
      <ConsoleSection id="roots" title="Roots">
        <p>body</p>
      </ConsoleSection>
    )
    const section = screen.getByTestId("console-section-roots")
    expect(section).toHaveAttribute("data-surface-layer", "raised")
    expect(section).toHaveAttribute("data-elevation", "1")
  })

  /**
   * The sheet variant is a chapter of one subject: no raised tier, no frame,
   * and the anchors, heading and wide span behave exactly as the card's do,
   * so a jump strip built for cards lands on chapters unchanged.
   */
  it("renders a frameless chapter for the sheet variant", () => {
    render(
      <ConsoleSection
        id="routing"
        title="Routing"
        meta="2/3"
        variant="sheet"
        pane="device-pane"
        idPrefix="device-section"
        wide
      >
        <p>body</p>
      </ConsoleSection>
    )
    const section = screen.getByTestId("device-section-routing")
    expect(section).toHaveAttribute("id", "device-section-routing")
    expect(section).toHaveAttribute("data-variant", "sheet")
    expect(section).not.toHaveAttribute("data-surface-layer")
    expect(section.className).not.toMatch(/(^|\s)border(\s|$)/)
    expect(section.className).toContain("@3xl/device-pane:col-span-2")
    expect(screen.getByRole("heading", { name: "Routing" })).toBeInTheDocument()
    expect(screen.getByText("2/3")).toBeInTheDocument()
  })

  it("defaults to the framed card variant", () => {
    render(
      <ConsoleSection id="roots" title="Roots">
        <p>body</p>
      </ConsoleSection>
    )
    expect(screen.getByTestId("console-section-roots")).toHaveAttribute("data-variant", "card")
  })
})
