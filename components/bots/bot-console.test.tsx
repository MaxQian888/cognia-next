/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"

import type { BotConsoleRow, BotConsoleSummary } from "@/lib/bot/console/bot-rows"

let rows: BotConsoleRow[] = []
let summary: BotConsoleSummary = { total: 0, armed: 0, needsAttention: 0, deadLetters: 0 }
let loading = false

jest.mock("@/hooks/bots/use-bot-installations", () => ({
  useBotInstallations: () => ({ rows, summary, loading }),
}))
jest.mock("./bot-runtime-notice", () => ({
  BotRuntimeNotice: () => <div data-testid="bot-runtime-notice-stub" />,
}))

import { BotConsole } from "./bot-console"

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

beforeEach(() => {
  rows = [row()]
  summary = { total: 1, armed: 1, needsAttention: 0, deadLetters: 0 }
  loading = false
})

describe("BotConsole", () => {
  it("summarizes how many of the installed Bots are actually armed", () => {
    summary = { total: 3, armed: 1, needsAttention: 0, deadLetters: 0 }
    render(<BotConsole onSelect={jest.fn()} />)
    expect(screen.getByText("1 of 3 armed")).toBeInTheDocument()
  })

  it("lights the attention badge only when something needs a person", () => {
    render(<BotConsole onSelect={jest.fn()} />)
    expect(screen.queryByTestId("bots-attention-count")).not.toBeInTheDocument()

    summary = { total: 1, armed: 0, needsAttention: 2, deadLetters: 1 }
    render(<BotConsole onSelect={jest.fn()} />)
    expect(screen.getByTestId("bots-attention-count")).toHaveTextContent("2 need attention")
  })

  it("opens the Bot the deep link names", () => {
    render(<BotConsole selectedId="boti_1" onSelect={jest.fn()} />)
    expect(screen.getByTestId("bot-detail")).toBeInTheDocument()
    expect(screen.getByTestId("bot-row-boti_1")).toHaveAttribute("aria-current", "true")
  })

  it("shows nothing selected for a link naming a Bot this device does not have", () => {
    // Landing on the first row instead would make a broken link look like it
    // worked, and act on a Bot the user did not ask for.
    render(<BotConsole selectedId="boti_missing" onSelect={jest.fn()} />)
    expect(screen.getByTestId("bot-detail-empty")).toBeInTheDocument()
  })

  it("hands the installation id to the route when a row is clicked", () => {
    const onSelect = jest.fn()
    render(<BotConsole onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId("bot-row-boti_1"))
    expect(onSelect).toHaveBeenCalledWith("boti_1")
  })

  it("always mounts the runtime notice, which is the surface contract's explain half", () => {
    render(<BotConsole onSelect={jest.fn()} />)
    expect(screen.getByTestId("bot-runtime-notice-stub")).toBeInTheDocument()
  })
})
