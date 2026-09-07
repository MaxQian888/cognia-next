/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

import { BotDetail } from "./bot-detail"

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
    deadLetters: 0,
    updatedAt: 1_700_000_000_000,
    ...over,
  }
}

describe("BotDetail", () => {
  it("explains an empty pane rather than rendering a blank one", () => {
    render(<BotDetail row={null} />)
    expect(screen.getByTestId("bot-detail-empty")).toBeInTheDocument()
  })

  it("renders the identity record and the triggers side by side", () => {
    render(<BotDetail row={row()} />)
    expect(screen.getByTestId("console-section-identity")).toBeInTheDocument()
    expect(screen.getByTestId("console-section-triggers")).toBeInTheDocument()
    expect(screen.getByTestId("bot-trigger-push")).toBeInTheDocument()
  })

  it("states each resolution problem separately, not as one unavailable line", () => {
    // The three kinds need three different actions: reinstall the plugin,
    // accept a version that moved, or fix a handler that never loaded.
    render(
      <BotDetail
        row={row({
          problems: [
            { kind: "version_drift", pinned: "1.0.0", available: "1.1.0" },
            { kind: "handler_missing", definitionId: "acme:review" },
          ],
        })}
      />
    )
    expect(screen.getByTestId("bot-problem-version_drift")).toHaveTextContent(
      "Running a different version"
    )
    expect(screen.getByTestId("bot-problem-handler_missing")).toHaveTextContent(
      "Handler did not load"
    )
  })

  it("says an orphan is inert, and offers no control that would act on nothing", () => {
    render(
      <BotDetail
        row={row({ orphaned: true, executor: undefined, triggers: [], armedTriggers: 0 })}
      />
    )
    expect(screen.getByTestId("bot-orphan-alert")).toHaveTextContent("This Bot has no definition")
  })

  it("resets the scroll when the selection changes", () => {
    // Carrying the old offset lands you in the middle of a different Bot's
    // trigger list with nothing to say that is what happened.
    const { rerender } = render(<BotDetail row={row()} />)
    const scroller = screen.getByTestId("bot-detail").querySelector("div.overflow-y-auto")
    expect(scroller).toBeTruthy()
    ;(scroller as HTMLElement).scrollTop = 400

    rerender(<BotDetail row={row({ id: "boti_2", name: "Digest" })} />)
    expect((scroller as HTMLElement).scrollTop).toBe(0)
  })
})
