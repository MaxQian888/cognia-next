/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { BotWriteReadiness } from "@/hooks/bots/use-bot-control-writes"
import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

const setBotTriggerArmed = jest.fn(
  async (_input: { installationId: string; triggerId: string; armed: boolean }) => undefined
)
let readiness: BotWriteReadiness = {
  route: "local",
  availability: { state: "available", reason: "local-host" },
  can: true,
}

jest.mock("@/hooks/bots/use-bot-control-writes", () => ({
  // The real hook, minus its subscriptions. What this suite pins is that the
  // section routes through the facade at all, which a component writing Dexie
  // directly would pass without.
  useBotWriteReadiness: () => readiness,
  useBotControlActions: () => ({
    pending: new Set<string>(),
    setTriggerArmed: (installationId: string, triggerId: string, armed: boolean) =>
      setBotTriggerArmed({ installationId, triggerId, armed }),
    runNow: jest.fn(),
    replayDelivery: jest.fn(),
  }),
}))

import { BotTriggersSection } from "./triggers-section"

beforeEach(() => {
  setBotTriggerArmed.mockClear()
  readiness = {
    route: "local",
    availability: { state: "available", reason: "local-host" },
    can: true,
  }
})

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
    config: {},
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
    expect(screen.getByTestId("bot-trigger-switch-nightly")).not.toBeChecked()
  })

  it("marks an armed trigger, with the state on the switch and not only in colour", () => {
    render(<BotTriggersSection row={row()} />)
    expect(screen.getByTestId("bot-trigger-push")).toHaveAttribute("data-armed", "true")
    expect(screen.getByTestId("bot-trigger-switch-push")).toBeChecked()
  })

  it("writes an absolute value through the facade, never a toggle", async () => {
    render(<BotTriggersSection row={row()} />)
    fireEvent.click(screen.getByTestId("bot-trigger-switch-nightly"))
    await waitFor(() =>
      expect(setBotTriggerArmed).toHaveBeenCalledWith({
        installationId: "boti_1",
        triggerId: "nightly",
        armed: true,
      })
    )
  })

  it("disables the switch and says why when this shell cannot arm anything", () => {
    // Hiding it collapses "no such trigger", "not from here" and "already
    // armed" into one answer.
    readiness = {
      route: "unavailable",
      availability: { state: "unsupported", reason: "requires-companion" },
      can: false,
    }
    render(<BotTriggersSection row={row()} />)
    expect(screen.getByTestId("bot-trigger-switch-push")).toBeDisabled()
    expect(screen.getByTestId("bot-arm-blocked")).toHaveTextContent("This browser cannot run Bots")
  })

  it("refuses to arm an orphan, whose trigger no longer exists to reconcile", () => {
    render(<BotTriggersSection row={row({ orphaned: true })} />)
    expect(screen.getByTestId("bot-arm-blocked")).toHaveTextContent(
      "Triggers cannot be armed while the definition is missing."
    )
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
