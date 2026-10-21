/** @jest-environment jsdom */

import { selectOption } from "@/lib/testing/select-option"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { BotWriteReadiness } from "@/hooks/bots/use-bot-control-writes"
import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"
import { registerPluginI18n, unregisterPluginI18n } from "@/lib/i18n/plugin-i18n-registry"

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

jest.mock("@/components/usage/run-estimate-hint", () => ({ RunEstimateHint: jest.fn(() => null) }))

import { RunEstimateHint } from "@/components/usage/run-estimate-hint"
import { RunBotNowButton } from "./run-bot-now-button"

const hintMock = RunEstimateHint as unknown as jest.Mock

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
  hintMock.mockClear()
  runNow.mockClear()
  pending = new Set()
  readiness = {
    route: "local",
    availability: { state: "available", reason: "local-host" },
    can: true,
  }
})

afterEach(() => unregisterPluginI18n("acme"))

describe("RunBotNowButton", () => {
  it("uses the owning plugin's translated manual label and still submits its trigger id", async () => {
    registerPluginI18n({
      pluginId: "acme",
      messages: { en: { "plugin.acme.trigger.check": "Check plugin setup" } },
    })
    render(
      <RunBotNowButton
        row={row({
          triggers: [
            { id: "run", kind: "manual", armed: true, label: "Run" },
            {
              id: "check",
              kind: "manual",
              armed: true,
              labelKey: "trigger.check",
              label: "Check setup",
            },
          ],
        })}
      />
    )
    expect(screen.getByRole("option", { hidden: true, name: "Check plugin setup" })).toHaveValue(
      "check"
    )
    expect(
      screen.queryByRole("option", { hidden: true, name: "Check setup" })
    ).not.toBeInTheDocument()
    await selectOption(screen.getByRole("combobox"), "check")
    fireEvent.click(screen.getByRole("button", { name: "Run now" }))
    await waitFor(() => expect(runNow).toHaveBeenCalledWith("boti_1", "check"))
  })

  it("resolves a plugin key without a literal manual label", () => {
    registerPluginI18n({
      pluginId: "acme",
      messages: { en: { "plugin.acme.trigger.check": "Check plugin setup" } },
    })
    render(
      <RunBotNowButton
        row={row({
          triggers: [
            { id: "run", kind: "manual", armed: true, label: "Run" },
            { id: "check", kind: "manual", armed: true, labelKey: "trigger.check" },
          ],
        })}
      />
    )
    expect(screen.getByRole("option", { hidden: true, name: "Check plugin setup" })).toHaveValue(
      "check"
    )
  })

  it.each([
    { labelKey: "trigger.missing", label: "Check setup", expected: "Check setup" },
    { labelKey: undefined, label: "Check setup", expected: "Check setup" },
    { labelKey: "trigger.missing", label: undefined, expected: "Run by hand" },
    { labelKey: undefined, label: undefined, expected: "Run by hand" },
  ])(
    "falls back to $expected (key: $labelKey, literal: $label)",
    ({ labelKey, label, expected }) => {
      render(
        <RunBotNowButton
          row={row({
            triggers: [
              { id: "run", kind: "manual", armed: true, label: "Run" },
              { id: "check", kind: "manual", armed: true, labelKey, label },
            ],
          })}
        />
      )
      expect(screen.getByRole("option", { hidden: true, name: expected })).toHaveValue("check")
      expect(
        screen.queryByRole("option", { hidden: true, name: /trigger.missing/ })
      ).not.toBeInTheDocument()
    }
  )

  it("does not resolve plugin keys for a local definition with a namespaced id", () => {
    registerPluginI18n({
      pluginId: "acme",
      messages: { en: { "plugin.acme.trigger.check": "Check plugin setup" } },
    })
    render(
      <RunBotNowButton
        row={row({
          source: "local",
          triggers: [
            { id: "run", kind: "manual", armed: true, label: "Run" },
            {
              id: "check",
              kind: "manual",
              armed: true,
              labelKey: "trigger.check",
              label: "Local check",
            },
          ],
        })}
      />
    )
    expect(screen.getByRole("option", { hidden: true, name: "Local check" })).toHaveValue("check")
    expect(
      screen.queryByRole("option", { hidden: true, name: "Check plugin setup" })
    ).not.toBeInTheDocument()
  })
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
    await selectOption(screen.getByRole("combobox"), "backfill")
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

it("constrains the manual trigger picker without losing long option names", () => {
  const label = "Manual trigger ".repeat(20)
  render(
    <RunBotNowButton
      row={row({
        triggers: [
          { id: "one", kind: "manual", armed: true, label },
          { id: "two", kind: "manual", armed: true, label: "Second" },
        ],
      })}
    />
  )
  expect(screen.getByRole("combobox").closest('[data-slot="native-select-wrapper"]')).toHaveClass(
    "min-w-0",
    "max-w-full"
  )
  expect(screen.getByRole("option", { hidden: true, name: label.trim() })).toBeInTheDocument()
})

/** ADR-0232: bots have no usage history yet, so the estimate is labelled inert. */
describe("RunBotNowButton — run estimate", () => {
  it("asks for a bot estimate, which the hint renders as unavailable", () => {
    render(<RunBotNowButton row={row()} />)
    expect(hintMock.mock.lastCall?.[0].queries).toEqual([{ surface: "bot" }])
  })

  it("is not shown when the run is blocked", () => {
    render(<RunBotNowButton row={row({ orphaned: true })} />)
    expect(hintMock).not.toHaveBeenCalled()
  })
})
