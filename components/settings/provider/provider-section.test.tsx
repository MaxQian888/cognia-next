/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { Activity } from "lucide-react"
import { ProviderSection, ProviderSectionStack } from "./provider-section"

describe("ProviderSection", () => {
  it("renders a flat section — heading, description and content, no card frame", () => {
    const { container } = render(
      <ProviderSection
        icon={Activity}
        title="Summary"
        description="How this provider is behaving"
        data-testid="summary-section"
      >
        <p>body</p>
      </ProviderSection>
    )
    expect(screen.getByText("Summary")).toBeInTheDocument()
    expect(screen.getByText("How this provider is behaving")).toBeInTheDocument()
    expect(screen.getByText("body")).toBeInTheDocument()
    // The Card idiom this replaces put a bordered, shadowed box around every
    // block; a flat section is a hairline under the content and nothing else.
    expect(container.querySelector('[data-slot="card"]')).toBeNull()
    expect(screen.getByTestId("summary-section")).toHaveClass("border-b")
  })

  it("renders the icon when one is supplied and omits it otherwise", () => {
    const { container, rerender } = render(<ProviderSection icon={Activity} title="With icon" />)
    expect(container.querySelector("svg")).toBeInTheDocument()
    rerender(<ProviderSection title="No icon" />)
    expect(container.querySelector("svg")).toBeNull()
  })

  it("renders the badge and action slots", () => {
    render(
      <ProviderSection
        title="Endpoints"
        badge={<span>3</span>}
        actions={<button type="button">Refresh</button>}
      />
    )
    expect(screen.getByText("3")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument()
  })

  it("omits the content wrapper when there are no children", () => {
    render(<ProviderSection title="Bare" data-testid="bare" />)
    expect(screen.getByTestId("bare").querySelector(".mt-3")).toBeNull()
  })

  it("drops the hairline when hideSeparator is set", () => {
    render(<ProviderSection title="Last" hideSeparator data-testid="last" />)
    expect(screen.getByTestId("last")).not.toHaveClass("border-b")
  })

  describe("collapsible", () => {
    it("shows content by default and hides it after toggling", () => {
      render(
        <ProviderSection collapsible title="History" data-testid="history">
          <p>rows</p>
        </ProviderSection>
      )
      expect(screen.getByText("rows")).toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: /History/ }))
      expect(screen.queryByText("rows")).not.toBeInTheDocument()
    })

    it("starts closed when defaultOpen is false", () => {
      render(
        <ProviderSection collapsible defaultOpen={false} title="History">
          <p>rows</p>
        </ProviderSection>
      )
      expect(screen.queryByText("rows")).not.toBeInTheDocument()
    })

    it("keeps the action slot outside the trigger so its click is not swallowed", () => {
      const onAction = jest.fn()
      render(
        <ProviderSection
          collapsible
          title="History"
          actions={
            <button type="button" onClick={onAction}>
              Clear
            </button>
          }
        >
          <p>rows</p>
        </ProviderSection>
      )
      const action = screen.getByRole("button", { name: "Clear" })
      expect(action.closest('[data-slot="collapsible-trigger"]')).toBeNull()
      fireEvent.click(action)
      expect(onAction).toHaveBeenCalledTimes(1)
      // Toggling did not happen as a side effect of the action click.
      expect(screen.getByText("rows")).toBeInTheDocument()
    })
  })
})

describe("ProviderSectionStack", () => {
  it("stacks its sections in a single column", () => {
    const { container } = render(
      <ProviderSectionStack>
        <ProviderSection title="One" />
        <ProviderSection title="Two" />
      </ProviderSectionStack>
    )
    expect(container.firstElementChild).toHaveClass("flex-col")
    expect(screen.getByText("One")).toBeInTheDocument()
    expect(screen.getByText("Two")).toBeInTheDocument()
  })

  it("merges an extra className", () => {
    const { container } = render(
      <ProviderSectionStack className="px-4">
        <ProviderSection title="One" />
      </ProviderSectionStack>
    )
    expect(container.firstElementChild).toHaveClass("px-4")
  })
})
