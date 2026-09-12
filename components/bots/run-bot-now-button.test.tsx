/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { BotWriteReadiness } from "@/hooks/bots/use-bot-control-writes"
import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

const runNow = jest.fn(
  async (_installationId: string, _triggerId?: string, _input?: unknown) => undefined
)
let readiness: BotWriteReadiness = {
  route: "local",
  availability: { state: "available", reason: "local-host" },
  can: true,
}
let pending = new Set<string>()

jest.mock("@/hooks/bots/use-bot-control-writes", () => ({
  useBotWriteReadiness: () => readiness,
  useBotControlActions: () => ({
    pending,
    runNow: (...args: [string, string?, unknown?]) => runNow(...args),
    setTriggerArmed: jest.fn(),
    replayDelivery: jest.fn(),
  }),
}))

import { RunBotNowButton } from "./run-bot-now-button"

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
    triggers: [{ id: "run", kind: "manual", armed: true }],
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
  runNow.mockClear()
  pending = new Set()
  readiness = {
    route: "local",
    availability: { state: "available", reason: "local-host" },
    can: true,
  }
})

describe("RunBotNowButton", () => {
  it("uses the shared schema form for explicit historical item selection", async () => {
    render(
      <RunBotNowButton
        row={row({
          triggers: [
            { id: "run", kind: "manual", armed: true },
            {
              id: "backfill",
              kind: "manual",
              armed: true,
              label: "Backfill",
              inputSchema: {
                type: "object",
                properties: { numbers: { type: "string", title: "Item numbers" } },
                required: ["numbers"],
              },
            },
          ],
        })}
      />
    )
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "backfill" } })
    fireEvent.change(screen.getByLabelText(/Item numbers/), { target: { value: "12,34" } })
    fireEvent.click(screen.getByRole("button", { name: "Run now" }))
    await waitFor(() =>
      expect(runNow).toHaveBeenCalledWith("boti_1", "backfill", { numbers: "12,34" })
    )
  })
  it("starts the run under the definition's own manual trigger", async () => {
    render(<RunBotNowButton row={row()} />)
    fireEvent.click(screen.getByTestId("bot-run-now"))
    await waitFor(() => expect(runNow).toHaveBeenCalledWith("boti_1", "run"))
  })

  it("refuses a Bot with no manual trigger, and says which refusal it is", () => {
    // Starting its schedule instead would run work under a payload that
    // trigger never expects.
    render(
      <RunBotNowButton row={row({ triggers: [{ id: "n", kind: "schedule", armed: true }] })} />
    )
    expect(screen.getByTestId("bot-run-now")).toBeDisabled()
    expect(screen.getByTestId("bot-run-now-blocked")).toHaveTextContent(
      "declares no manual trigger"
    )
  })

  it("refuses an orphan with its own reason", () => {
    render(<RunBotNowButton row={row({ orphaned: true })} />)
    expect(screen.getByTestId("bot-run-now-blocked")).toHaveTextContent(
      "There is no definition left to run."
    )
  })

  it("shows the write plane's reason when this shell cannot run anything", () => {
    readiness = {
      route: "unavailable",
      availability: { state: "unsupported", reason: "requires-companion" },
      can: false,
    }
    render(<RunBotNowButton row={row()} />)
    expect(screen.getByTestId("bot-run-now")).toBeDisabled()
    expect(screen.getByTestId("bot-run-now-blocked")).toHaveTextContent(
      "This browser cannot run Bots"
    )
  })

  it("states the reason as text, not a tooltip", () => {
    // A tooltip on a disabled control is unreachable with a finger, so the one
    // sentence explaining the dead button would only reach a mouse hover.
    readiness = {
      route: "unavailable",
      availability: { state: "unsupported", reason: "requires-companion" },
      can: false,
    }
    render(<RunBotNowButton row={row()} />)
    expect(screen.getByTestId("bot-run-now-blocked").tagName).toBe("P")
  })

  it("disables itself while its own run is in flight, not every Bot's", () => {
    pending = new Set(["run:boti_2"])
    const { rerender } = render(<RunBotNowButton row={row()} />)
    expect(screen.getByTestId("bot-run-now")).not.toBeDisabled()

    pending = new Set(["run:boti_1"])
    rerender(<RunBotNowButton row={row()} />)
    expect(screen.getByTestId("bot-run-now")).toBeDisabled()
  })
})
