/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import { SparklesIcon } from "lucide-react"

import { GuideCallout } from "./guide-callout"

describe("GuideCallout", () => {
  it("is a labelled region by default, with title, description and actions", () => {
    render(
      <GuideCallout
        icon={SparklesIcon}
        title="Get started"
        description="Add a key"
        actions={<button>Go</button>}
        testId="callout"
      />
    )
    const region = screen.getByRole("region", { name: "Get started" })
    expect(region).toHaveAttribute("data-variant", "card")
    expect(screen.getByText("Add a key")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Go" })).toBeInTheDocument()
  })

  it("is a live status row in the bar variant", () => {
    render(<GuideCallout variant="bar" icon={SparklesIcon} title="Almost done" testId="bar" />)
    const bar = screen.getByRole("status")
    expect(bar).toHaveAttribute("data-testid", "bar")
    expect(bar).toHaveAttribute("data-variant", "bar")
  })

  it("names the close button, which is an icon alone, and wires it", () => {
    const onDismiss = jest.fn()
    render(
      <GuideCallout
        icon={SparklesIcon}
        title="Get started"
        dismiss={{ onDismiss, label: "Dismiss", testId: "close" }}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("close")).toBeInTheDocument()
  })

  it("has no close button when it cannot be dismissed", () => {
    render(<GuideCallout icon={SparklesIcon} title="Status" />)
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("carries tone on the surface, never on the text", () => {
    render(<GuideCallout tone="attention" icon={SparklesIcon} title="Did not finish" />)
    const region = screen.getByRole("region")
    expect(region).toHaveAttribute("data-tone", "attention")
    expect(screen.getByText("Did not finish")).toHaveClass("text-foreground")
    expect(screen.getByText("Did not finish").className).not.toContain("text-brand")
  })

  it("arrives with the shared callout entrance in both variants", () => {
    const { unmount } = render(<GuideCallout icon={SparklesIcon} title="A" />)
    expect(screen.getByRole("region")).toHaveClass("animate-in", "fade-in")
    unmount()
    render(<GuideCallout variant="bar" icon={SparklesIcon} title="B" />)
    expect(screen.getByRole("status")).toHaveClass("animate-in", "fade-in")
  })

  it("renders extra material under the description in the card", () => {
    render(
      <GuideCallout icon={SparklesIcon} title="A">
        <p data-testid="extra" />
      </GuideCallout>
    )
    expect(screen.getByRole("region")).toContainElement(screen.getByTestId("extra"))
  })
})
