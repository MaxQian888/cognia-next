/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

import { BotHero } from "./bot-hero"

function row(over: Partial<BotConsoleRow> = {}): BotConsoleRow {
  return {
    id: "boti_1",
    definitionId: "acme:review",
    source: "plugin",
    name: "Review",
    description: "Reviews pull requests",
    executor: "workflow",
    status: "enabled",
    scope: { kind: "account" },
    orphaned: false,
    problems: [],
    triggers: [{ id: "push", kind: "event", armed: true }],
    armedTriggers: 1,
    unboundSlots: [],
    requiredSlots: [],
    credentials: [],
    config: {},
    deadLetters: 0,
    updatedAt: 10,
    ...over,
  }
}

describe("BotHero", () => {
  it("names the Bot, its source, executor, scope and definition", () => {
    render(<BotHero row={row()} />)
    expect(screen.getByText("Review")).toBeInTheDocument()
    expect(screen.getByText("Workflow")).toBeInTheDocument()
    expect(screen.getByText("Account-wide")).toBeInTheDocument()
    expect(screen.getByText("acme:review")).toBeInTheDocument()
    expect(screen.getByText("Reviews pull requests")).toBeInTheDocument()
  })

  it("prints the armed fraction, translated here rather than inside the strip", () => {
    // `StatStrip` is shared with `/devices` and `/workspace`. Calling `t()` in
    // the cell is what bound the original implementation to one namespace.
    render(<BotHero row={row()} />)
    expect(screen.getByTestId("bot-stat-triggers")).toHaveTextContent("Triggers armed")
  })

  it("omits the strip entirely when the row can answer nothing", () => {
    render(
      <BotHero row={row({ orphaned: true, triggers: [], armedTriggers: 0, requiredSlots: [] })} />
    )
    expect(screen.queryByTestId("bot-stat-strip")).not.toBeInTheDocument()
  })

  it("shows the orphan badge instead of a status the user cannot act on", () => {
    render(<BotHero row={row({ orphaned: true, executor: undefined })} />)
    expect(screen.getByTestId("bot-orphan-badge")).toBeInTheDocument()
    expect(screen.queryByTestId("bot-status-badge")).not.toBeInTheDocument()
  })

  it("prints dead letters, which a healthy Bot's strip never mentions", () => {
    render(<BotHero row={row({ deadLetters: 2 })} />)
    expect(screen.getByTestId("bot-stat-deadLetters")).toHaveTextContent("2")

    render(<BotHero row={row()} />)
    expect(screen.queryAllByTestId("bot-stat-deadLetters")).toHaveLength(1)
  })
})
