/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SettingsBlock, SettingsField, SettingsStack } from "./settings-block"

describe("SettingsStack", () => {
  it("declares the container every field measures against and separates its children", () => {
    const { container } = render(
      <SettingsStack className="custom">
        <div>first</div>
        <div>second</div>
      </SettingsStack>
    )

    const stack = container.firstElementChild as HTMLElement
    expect(stack).toHaveClass("@container/settings-stack")
    expect(stack).toHaveClass("divide-y")
    expect(stack).toHaveClass("custom")
  })
})

describe("SettingsBlock", () => {
  it("renders title, description, icon, badge and action without any card chrome", () => {
    const { container } = render(
      <SettingsBlock
        icon={<svg data-testid="block-icon" />}
        title="Judge"
        description="Which model scores runs"
        badge={<span data-testid="block-badge">on</span>}
        action={<button type="button">Reset</button>}
        testid="judge-block"
      >
        <p>body</p>
      </SettingsBlock>
    )

    expect(screen.getByTestId("judge-block").tagName).toBe("SECTION")
    expect(screen.getByText("Judge")).toBeInTheDocument()
    expect(screen.getByText("Which model scores runs")).toBeInTheDocument()
    expect(screen.getByTestId("block-icon")).toBeInTheDocument()
    expect(screen.getByTestId("block-badge")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument()
    expect(screen.getByText("body")).toBeInTheDocument()
    // No bordered box around the group — that is the whole point.
    expect(container.querySelector("[data-slot='card']")).toBeNull()
  })

  it("applies the caller's class names to the section and the content wrapper", () => {
    render(
      <SettingsBlock
        title="Gate"
        className="section-class"
        contentClassName="grid-class"
        testid="gate-block"
      >
        <p>body</p>
      </SettingsBlock>
    )

    const section = screen.getByTestId("gate-block")
    expect(section).toHaveClass("section-class")
    expect(screen.getByText("body").parentElement).toHaveClass("grid-class")
  })

  it("collapses and expands from the header when collapsible", async () => {
    const user = userEvent.setup()
    render(
      <SettingsBlock title="Cost guard" collapsible defaultOpen={false} testid="cost-block">
        <p>warn threshold</p>
      </SettingsBlock>
    )

    expect(screen.getByTestId("cost-block")).toHaveAttribute("data-open", "false")
    expect(screen.queryByText("warn threshold")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /Cost guard/ }))

    expect(screen.getByTestId("cost-block")).toHaveAttribute("data-open", "true")
    expect(screen.getByText("warn threshold")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /Cost guard/ }))
    expect(screen.queryByText("warn threshold")).not.toBeInTheDocument()
  })

  it("keeps the header action outside the disclosure trigger", async () => {
    const user = userEvent.setup()
    const onAction = jest.fn()
    render(
      <SettingsBlock
        title="Sessions"
        collapsible
        action={
          <button type="button" onClick={onAction}>
            Refresh
          </button>
        }
        testid="sessions-block"
      >
        <p>list</p>
      </SettingsBlock>
    )

    await user.click(screen.getByRole("button", { name: "Refresh" }))

    expect(onAction).toHaveBeenCalledTimes(1)
    // Clicking the action must not toggle the block.
    expect(screen.getByTestId("sessions-block")).toHaveAttribute("data-open", "true")
  })
})

describe("SettingsField", () => {
  it("names its control and lays label and control side by side", () => {
    render(
      <SettingsField
        htmlFor="default-k"
        label="Default k"
        description="Used for pass^k"
        testid="k-field"
      >
        <input id="default-k" />
      </SettingsField>
    )

    expect(screen.getByLabelText("Default k")).toBe(screen.getByRole("textbox"))
    expect(screen.getByText("Used for pass^k")).toBeInTheDocument()
    expect(screen.getByTestId("k-field")).toHaveClass("@md/settings-stack:flex-row")
  })

  it("gives the control its own full-width line when stacked", () => {
    render(
      <SettingsField label="Scorers" stacked testid="scorers-field">
        <div data-testid="picker" />
      </SettingsField>
    )

    const field = screen.getByTestId("scorers-field")
    expect(field).not.toHaveClass("@md/settings-stack:flex-row")
    expect(screen.getByTestId("picker").parentElement).toHaveClass("w-full")
  })

  it("dims and blocks interaction when disabled", () => {
    render(
      <SettingsField label="Judge model" disabled testid="judge-field">
        <button type="button">Pick</button>
      </SettingsField>
    )

    expect(screen.getByTestId("judge-field")).toHaveClass("pointer-events-none")
    expect(screen.getByTestId("judge-field")).toHaveClass("opacity-50")
  })
})
