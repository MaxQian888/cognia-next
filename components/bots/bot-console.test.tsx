/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"

import type { BotConsoleRow, BotConsoleSummary } from "@/lib/bot/console/bot-rows"

let rows: BotConsoleRow[] = []
let summary: BotConsoleSummary = { total: 0, armed: 0, needsAttention: 0, deadLetters: 0 }
let loading = false

jest.mock("@/hooks/bots/use-bot-installations", () => ({
  useBotInstallations: () => ({ rows, summary, loading }),
  // Also read by `use-bot-catalog`, which the install sheet pulls in.
  enabledPluginKey: () => "",
}))
jest.mock("./bot-runtime-notice", () => ({
  BotRuntimeNotice: () => <div data-testid="bot-runtime-notice-stub" />,
}))
// The sheet has its own suite. Stubbed here so the console's tests are about
// the console, and so a Dexie read does not have to be stood up for each one.
jest.mock("./install-bot-sheet", () => ({
  InstallBotSheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="install-bot-sheet-stub" /> : null,
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
    config: {},
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

describe("the install entry point", () => {
  it("opens the sheet from the header", () => {
    render(<BotConsole onSelect={jest.fn()} />)
    expect(screen.queryByTestId("install-bot-sheet-stub")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("bots-install-open"))
    expect(screen.getByTestId("install-bot-sheet-stub")).toBeInTheDocument()
  })

  it("opens from `?install=1`, latched during render rather than in an effect", () => {
    render(<BotConsole onSelect={jest.fn()} installParam="1" />)
    expect(screen.getByTestId("install-bot-sheet-stub")).toBeInTheDocument()
  })

  it("stays shut when the param is absent", () => {
    render(<BotConsole onSelect={jest.fn()} installParam={null} />)
    expect(screen.queryByTestId("install-bot-sheet-stub")).not.toBeInTheDocument()
  })

  it("does not slam a hand-opened sheet shut when the param clears", () => {
    // Only a NEW param opens it. Clearing one must not close what the user
    // opened from the header.
    const { rerender } = render(<BotConsole onSelect={jest.fn()} installParam="1" />)
    rerender(<BotConsole onSelect={jest.fn()} installParam={null} />)
    expect(screen.getByTestId("install-bot-sheet-stub")).toBeInTheDocument()
  })
})
