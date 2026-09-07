/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

import { BotTriggersSection } from "./triggers-section"

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
    triggers: [
      { id: "push", kind: "event", armed: true, detail: "pull_request.opened" },
      { id: "nightly", kind: "schedule", armed: false, detail: "0 9 * * *" },
      { id: "watch", kind: "poll", armed: true, everyMs: 300_000 },
    ],
    armedTriggers: 2,
    unboundSlots: [],
    requiredSlots: [],
    credentials: [],
    deadLetters: 0,
    updatedAt: 10,
    ...over,
  }
}

describe("BotTriggersSection", () => {
  it("lists a disarmed trigger rather than hiding it", () => {
    // "No schedule" and "a schedule that is switched off" are different
    // answers, and dropping the row makes them look identical.
    render(<BotTriggersSection row={row()} />)
    const nightly = screen.getByTestId("bot-trigger-nightly")
    expect(nightly).toHaveAttribute("data-armed", "false")
    expect(nightly).toHaveTextContent("Off")
  })

  it("marks an armed trigger", () => {
    render(<BotTriggersSection row={row()} />)
    expect(screen.getByTestId("bot-trigger-push")).toHaveAttribute("data-armed", "true")
    expect(screen.getByTestId("bot-trigger-push")).toHaveTextContent("Armed")
  })

  it("prints the kind and its literal detail", () => {
    render(<BotTriggersSection row={row()} />)
    expect(screen.getByTestId("bot-trigger-push")).toHaveTextContent("pull_request.opened")
    expect(screen.getByTestId("bot-trigger-nightly")).toHaveTextContent("0 9 * * *")
  })

  it("formats an interval as a sentence rather than milliseconds", () => {
    render(<BotTriggersSection row={row()} />)
    expect(screen.getByTestId("bot-trigger-watch")).toHaveTextContent("Every 5m")
    expect(screen.getByTestId("bot-trigger-watch")).not.toHaveTextContent("300000")
  })

  it("prefers the author's own label when there is one", () => {
    render(
      <BotTriggersSection
        row={row({ triggers: [{ id: "push", kind: "event", armed: true, label: "On new PR" }] })}
      />
    )
    expect(screen.getByTestId("bot-trigger-push")).toHaveTextContent("On new PR")
  })

  it("says why an orphan has no triggers, apart from a Bot that declares none", () => {
    const { unmount } = render(<BotTriggersSection row={row({ triggers: [], armedTriggers: 0 })} />)
    expect(screen.getByText("No triggers")).toBeInTheDocument()
    unmount()

    render(<BotTriggersSection row={row({ triggers: [], armedTriggers: 0, orphaned: true })} />)
    expect(screen.getByText("Definition missing")).toBeInTheDocument()
  })
})
