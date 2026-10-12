/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"

const saveRoute = jest.fn(async (_id: string, _route: unknown) => true)
let pending = new Set<string>()
let readiness = { availability: { state: "available", reason: "local-host" }, can: true }

jest.mock("@/hooks/bots/use-bot-lifecycle-actions", () => ({
  useBotLifecycleReadiness: () => readiness,
  useBotLifecycleActions: () => ({ pending, saveRoute }),
}))
jest.mock("@/components/shared/model-select", () => ({
  ModelSelect: ({
    onSelect,
    model,
    disabled,
  }: {
    onSelect: (choice: { providerId: string; modelId: string }) => void
    model: string
    disabled?: boolean
  }) => (
    <button
      type="button"
      disabled={disabled}
      data-testid="model-select"
      onClick={() => onSelect({ providerId: "openai", modelId: "gpt-5" })}
    >
      {model || "pick"}
    </button>
  ),
}))

import { BotRouteSection } from "./route-section"

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
    triggers: [],
    armedTriggers: 0,
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
  saveRoute.mockClear().mockResolvedValue(true)
  pending = new Set()
  readiness = { availability: { state: "available", reason: "local-host" }, can: true }
})

describe("BotRouteSection", () => {
  it("saves a Cognia model only once one is chosen", async () => {
    render(<BotRouteSection row={row()} />)
    expect(screen.getByTestId("bot-route-save")).toBeDisabled()
    await userEvent.click(screen.getByTestId("bot-route-gateway"))
    // Gateway without a model is incomplete.
    expect(screen.getByTestId("bot-route-save")).toBeDisabled()
    await userEvent.click(screen.getByTestId("model-select"))
    await userEvent.click(screen.getByTestId("bot-route-save"))
    expect(saveRoute).toHaveBeenCalledWith("boti_1", {
      mode: "gateway",
      providerId: "openai",
      modelId: "gpt-5",
    })
  })

  it("labels the native lane's trade-off before it is saved", async () => {
    render(<BotRouteSection row={row()} />)
    expect(screen.queryByTestId("bot-route-native-warning")).toBeNull()
    await userEvent.click(screen.getByTestId("bot-route-native"))
    expect(screen.getByTestId("bot-route-native-warning")).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("bot-route-save"))
    expect(saveRoute).toHaveBeenCalledWith("boti_1", { mode: "native" })
  })

  it("clears a route back to not chosen", async () => {
    render(<BotRouteSection row={row({ executionRoute: { mode: "native" } })} />)
    expect(screen.getByTestId("bot-route-save")).toBeDisabled()
    await userEvent.click(screen.getByTestId("bot-route-unset"))
    await userEvent.click(screen.getByTestId("bot-route-save"))
    expect(saveRoute).toHaveBeenCalledWith("boti_1", null)
  })

  it("shows the stored model of a routed installation", () => {
    render(
      <BotRouteSection
        row={row({ executionRoute: { mode: "gateway", providerId: "anthropic", modelId: "opus" } })}
      />
    )
    expect(screen.getByTestId("model-select")).toHaveTextContent("opus")
  })

  it("surfaces the setup error a missing route left behind", () => {
    render(
      <BotRouteSection
        row={row({ status: "needs_setup", monitor: { lastError: "Choose a Cognia model" } })}
      />
    )
    expect(screen.getByTestId("bot-route-setup-error")).toBeInTheDocument()
  })

  it("is read-only where lifecycle writes cannot land", () => {
    readiness = { availability: { state: "unsupported", reason: "requires-companion" }, can: false }
    render(<BotRouteSection row={row()} />)
    expect(screen.getByTestId("bot-route-save")).toBeDisabled()
    expect(screen.getByTestId("bot-route-native")).toBeDisabled()
  })
})
