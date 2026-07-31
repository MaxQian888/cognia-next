import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./accordion"

/**
 * No stylesheet is loaded under jsdom, so `animationName` computes to "none"
 * and Radix's `Presence` skips the exit wait entirely — collapsed content is
 * gone on the same tick. That is the end state of the real exit animation, so
 * these assertions hold in the browser too; only the intermediate frames are
 * missing, and those are the stylesheet's business rather than this file's.
 */
const setup = () => userEvent.setup()

/**
 * A plain `Omit` collapses Radix's `single | multiple` discriminated union into
 * one shapeless object, taking `collapsible` (single-only) with it. Distribute
 * over the union so the fixture accepts exactly what `Accordion` does.
 */
type AccordionFixtureProps =
  React.ComponentProps<typeof Accordion> extends infer T
    ? T extends unknown
      ? Omit<T, "children">
      : never
    : never

function TwoItems(props: AccordionFixtureProps) {
  return (
    <Accordion {...props}>
      <AccordionItem value="alpha">
        <AccordionTrigger>Alpha</AccordionTrigger>
        <AccordionContent>Alpha body</AccordionContent>
      </AccordionItem>
      <AccordionItem value="beta">
        <AccordionTrigger>Beta</AccordionTrigger>
        <AccordionContent>Beta body</AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}

describe("Accordion", () => {
  it("keeps every body out of the DOM while collapsed", () => {
    render(<TwoItems type="single" collapsible />)

    expect(screen.getByRole("button", { name: "Alpha" })).toBeInTheDocument()
    expect(screen.queryByText("Alpha body")).not.toBeInTheDocument()
    expect(screen.queryByText("Beta body")).not.toBeInTheDocument()
  })

  it("reveals a body when its trigger is activated", async () => {
    const user = setup()
    render(<TwoItems type="single" collapsible />)

    await user.click(screen.getByRole("button", { name: "Alpha" }))
    expect(screen.getByText("Alpha body")).toBeInTheDocument()
    expect(screen.queryByText("Beta body")).not.toBeInTheDocument()
  })

  it("collapses again on a second activation", async () => {
    const user = setup()
    render(<TwoItems type="single" collapsible />)

    const trigger = screen.getByRole("button", { name: "Alpha" })
    await user.click(trigger)
    expect(screen.getByText("Alpha body")).toBeInTheDocument()
    await user.click(trigger)
    expect(screen.queryByText("Alpha body")).not.toBeInTheDocument()
  })

  it("swaps the open item under type=single", async () => {
    const user = setup()
    render(<TwoItems type="single" collapsible />)

    await user.click(screen.getByRole("button", { name: "Alpha" }))
    await user.click(screen.getByRole("button", { name: "Beta" }))
    expect(screen.queryByText("Alpha body")).not.toBeInTheDocument()
    expect(screen.getByText("Beta body")).toBeInTheDocument()
  })

  it("keeps several items open under type=multiple", async () => {
    const user = setup()
    render(<TwoItems type="multiple" />)

    await user.click(screen.getByRole("button", { name: "Alpha" }))
    await user.click(screen.getByRole("button", { name: "Beta" }))
    expect(screen.getByText("Alpha body")).toBeInTheDocument()
    expect(screen.getByText("Beta body")).toBeInTheDocument()
  })

  it("renders an initially-open item expanded", () => {
    render(<TwoItems type="single" collapsible defaultValue="beta" />)

    expect(screen.getByText("Beta body")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Beta" })).toHaveAttribute("aria-expanded", "true")
  })

  it("obeys a controlled value instead of its own clicks", async () => {
    const user = setup()
    const onValueChange = jest.fn()
    render(<TwoItems type="single" value="alpha" onValueChange={onValueChange} />)

    await user.click(screen.getByRole("button", { name: "Beta" }))
    expect(onValueChange).toHaveBeenCalledWith("beta")
    // Controlled: Radix asks, the caller decides — nothing opened on its own.
    expect(screen.getByText("Alpha body")).toBeInTheDocument()
    expect(screen.queryByText("Beta body")).not.toBeInTheDocument()
  })

  it("mirrors open state onto the trigger for assistive tech", async () => {
    const user = setup()
    render(<TwoItems type="single" collapsible />)

    const trigger = screen.getByRole("button", { name: "Alpha" })
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(trigger).toHaveAttribute("data-state", "closed")
    await user.click(trigger)
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(trigger).toHaveAttribute("data-state", "open")
  })

  it("labels each content region with its own trigger", async () => {
    const user = setup()
    render(<TwoItems type="single" collapsible />)

    const trigger = screen.getByRole("button", { name: "Alpha" })
    await user.click(trigger)
    const region = screen.getByRole("region", { name: "Alpha" })
    expect(region).toHaveAttribute("aria-labelledby", trigger.id)
    expect(region).toHaveAttribute("data-slot", "accordion-content")
    expect(region).toHaveAttribute("data-state", "open")
  })

  /**
   * The reason this stays a faithful fork rather than taking presence over with
   * `forceMount`: a collapsed item leaves the accessibility tree completely.
   * No empty labelled landmark for a screen reader to walk into, and nothing
   * inside it reachable by Tab.
   */
  it("removes the region entirely while collapsed", async () => {
    const user = setup()
    render(<TwoItems type="single" collapsible defaultValue="alpha" />)

    expect(screen.getByRole("region", { name: "Alpha" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Alpha" }))
    expect(screen.queryByRole("region", { name: "Alpha" })).not.toBeInTheDocument()
    expect(screen.queryAllByRole("region")).toHaveLength(0)
  })

  it("wraps the trigger in a heading so the list is navigable by structure", () => {
    render(<TwoItems type="single" collapsible />)

    expect(screen.getAllByRole("heading")).toHaveLength(2)
    expect(screen.getByRole("button", { name: "Alpha" }).parentElement?.tagName).toBe("H3")
  })

  it("moves focus between triggers with the arrow keys", async () => {
    const user = setup()
    render(<TwoItems type="single" collapsible />)

    const alpha = screen.getByRole("button", { name: "Alpha" })
    alpha.focus()
    await user.keyboard("{ArrowDown}")
    expect(screen.getByRole("button", { name: "Beta" })).toHaveFocus()
  })

  it("applies a caller's class to the body rather than to the region", async () => {
    const user = setup()
    render(
      <Accordion type="single" collapsible>
        <AccordionItem value="alpha">
          <AccordionTrigger>Alpha</AccordionTrigger>
          <AccordionContent className="pb-8">Alpha body</AccordionContent>
        </AccordionItem>
      </Accordion>
    )

    await user.click(screen.getByRole("button", { name: "Alpha" }))
    const body = screen.getByText("Alpha body")
    expect(body.className).toContain("pb-8")
    // cn() resolved pb-4 against pb-8 instead of emitting both.
    expect(body.className).not.toContain("pb-4")
    expect(screen.getByRole("region", { name: "Alpha" }).className).not.toContain("pb-8")
  })

  /**
   * Pinned so the dependency is visible rather than incidental: these two
   * classes are `tw-animate-css` keyframes from the app's stylesheet, and they
   * are load-bearing — Radix's `Presence` unmounts exiting content the moment
   * `animationName` computes to "none", so dropping them does not merely make
   * the accordion snap, it removes the exit animation's chance to run at all.
   */
  it("declares the host's accordion keyframes on the animated element", () => {
    render(<TwoItems type="single" collapsible defaultValue="alpha" />)

    const region = screen.getByRole("region", { name: "Alpha" })
    expect(region.className).toContain("data-[state=open]:animate-accordion-down")
    expect(region.className).toContain("data-[state=closed]:animate-accordion-up")
    // The clip the height keyframes interpolate under.
    expect(region.className).toContain("overflow-hidden")
  })

  it("forwards a disabled item so its body cannot be opened", async () => {
    const user = setup()
    render(
      <Accordion type="single" collapsible>
        <AccordionItem value="alpha" disabled>
          <AccordionTrigger>Alpha</AccordionTrigger>
          <AccordionContent>Alpha body</AccordionContent>
        </AccordionItem>
      </Accordion>
    )

    const trigger = screen.getByRole("button", { name: "Alpha" })
    expect(trigger).toBeDisabled()
    await user.click(trigger)
    expect(screen.queryByText("Alpha body")).not.toBeInTheDocument()
  })

  it("stamps a data-slot on every part", () => {
    const { container } = render(<TwoItems type="single" collapsible defaultValue="alpha" />)

    for (const slot of ["accordion", "accordion-item", "accordion-trigger", "accordion-content"]) {
      expect(container.querySelector(`[data-slot='${slot}']`)).not.toBeNull()
    }
  })
})
