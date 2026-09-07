/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"

import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

import { BotRowButton } from "./bot-row"

function row(over: Partial<BotConsoleRow> = {}): BotConsoleRow {
  return {
    id: "boti_1",
    definitionId: "acme:review",
    source: "plugin",
    name: "Review",
    executor: "handler",
    status: "enabled",
    scope: { kind: "account" },
    orphaned: false,
    problems: [],
    triggers: [{ id: "push", kind: "event", armed: true }],
    armedTriggers: 1,
    unboundSlots: [],
    requiredSlots: [],
    credentials: [],
    deadLetters: 0,
    updatedAt: 10,
    ...over,
  }
}

describe("BotRowButton", () => {
  it("names the Bot, its executor and how many triggers are armed", () => {
    render(<BotRowButton row={row()} selected={false} onSelect={jest.fn()} />)
    expect(screen.getByText("Review")).toBeInTheDocument()
    expect(screen.getByText("Plugin handler")).toBeInTheDocument()
    expect(screen.getByText("1/1")).toBeInTheDocument()
  })

  it("shows the armed fraction even when it is zero", () => {
    // Installed and inert reads exactly like healthy without this number.
    render(
      <BotRowButton
        row={row({ armedTriggers: 0, triggers: [{ id: "push", kind: "event", armed: false }] })}
        selected={false}
        onSelect={jest.fn()}
      />
    )
    expect(screen.getByText("0/1")).toBeInTheDocument()
  })

  it("marks a row that needs attention", () => {
    render(
      <BotRowButton row={row({ status: "needs_setup" })} selected={false} onSelect={jest.fn()} />
    )
    expect(screen.getByLabelText("Needs attention")).toBeInTheDocument()
  })

  it("does not mark a healthy row", () => {
    render(<BotRowButton row={row()} selected={false} onSelect={jest.fn()} />)
    expect(screen.queryByLabelText("Needs attention")).not.toBeInTheDocument()
  })

  it("counts dead letters on the row, not only in the header", () => {
    render(<BotRowButton row={row({ deadLetters: 3 })} selected={false} onSelect={jest.fn()} />)
    expect(screen.getByText("3 dead letters")).toBeInTheDocument()
  })

  it("falls back to the definition id when nothing resolved", () => {
    render(
      <BotRowButton
        row={row({
          orphaned: true,
          name: "acme:review",
          executor: undefined,
          triggers: [],
          armedTriggers: 0,
        })}
        selected={false}
        onSelect={jest.fn()}
      />
    )
    expect(screen.getByTestId("bot-orphan-badge")).toBeInTheDocument()
    expect(screen.getAllByText("acme:review").length).toBeGreaterThan(0)
  })

  it("hands the installation id up on click", () => {
    const onSelect = jest.fn()
    render(<BotRowButton row={row()} selected={false} onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId("bot-row-boti_1"))
    expect(onSelect).toHaveBeenCalledWith("boti_1")
  })

  it("marks the selected row for assistive technology, not only visually", () => {
    render(<BotRowButton row={row()} selected onSelect={jest.fn()} />)
    expect(screen.getByTestId("bot-row-boti_1")).toHaveAttribute("aria-current", "true")
  })
})
