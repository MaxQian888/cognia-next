/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { BotWriteReadiness } from "@/hooks/bots/use-bot-control-writes"
import type { BotConsoleRow } from "@/lib/bot/console/bot-rows"
import type { BotEventDeliveryRow } from "@/lib/db/bot-types"

const replayDelivery = jest.fn(async (_deliveryId: string) => undefined)
let deliveries: { rows: BotEventDeliveryRow[]; loading: boolean } = { rows: [], loading: false }
let readiness: BotWriteReadiness = {
  route: "local",
  availability: { state: "available", reason: "local-host" },
  can: true,
}

jest.mock("@/hooks/bots/use-bot-deliveries", () => ({
  useBotDeliveries: () => deliveries,
  BOT_DELIVERY_PAGE_SIZE: 40,
}))
jest.mock("@/hooks/bots/use-bot-control-writes", () => ({
  useBotWriteReadiness: () => readiness,
  useBotControlActions: () => ({
    pending: new Set<string>(),
    replayDelivery: (id: string) => replayDelivery(id),
    setTriggerArmed: jest.fn(),
    runNow: jest.fn(),
  }),
}))

import { BotDeliveriesSection } from "./deliveries-section"

function row(): BotConsoleRow {
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
    deadLetters: 0,
    updatedAt: 10,
  }
}

function delivery(over: Partial<BotEventDeliveryRow> = {}): BotEventDeliveryRow {
  return {
    id: "bdl_1",
    eventId: "bev_1",
    installationId: "boti_1",
    triggerId: "push",
    source: "integration",
    type: "pull_request.opened",
    dedupKey: "boti_1::bev_1",
    status: "succeeded",
    attempts: 1,
    nextAttemptAt: 0,
    envelope: {} as BotEventDeliveryRow["envelope"],
    receivedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  }
}

beforeEach(() => {
  replayDelivery.mockClear()
  deliveries = { rows: [], loading: false }
  readiness = {
    route: "local",
    availability: { state: "available", reason: "local-host" },
    can: true,
  }
})

describe("BotDeliveriesSection", () => {
  it("lists a delivery with its status, attempts and error", () => {
    deliveries = {
      rows: [delivery({ status: "deadletter", attempts: 5, lastError: "token expired" })],
      loading: false,
    }
    render(<BotDeliveriesSection row={row()} />)
    const item = screen.getByTestId("bot-delivery-bdl_1")
    expect(item).toHaveAttribute("data-status", "deadletter")
    expect(item).toHaveTextContent("Gave up")
    expect(item).toHaveTextContent("5 attempts")
    expect(item).toHaveTextContent("token expired")
  })

  it("offers replay only on a dead letter", () => {
    // Replay resets the attempt budget. Doing that to a delivery that is
    // merely backing off hands it attempts it has not earned.
    deliveries = {
      rows: [delivery({ id: "bdl_ok" }), delivery({ id: "bdl_dead", status: "deadletter" })],
      loading: false,
    }
    render(<BotDeliveriesSection row={row()} />)
    expect(screen.queryByTestId("bot-delivery-replay-bdl_ok")).not.toBeInTheDocument()
    expect(screen.getByTestId("bot-delivery-replay-bdl_dead")).toBeInTheDocument()
  })

  it("routes replay through the facade", async () => {
    deliveries = { rows: [delivery({ status: "deadletter" })], loading: false }
    render(<BotDeliveriesSection row={row()} />)
    fireEvent.click(screen.getByTestId("bot-delivery-replay-bdl_1"))
    await waitFor(() => expect(replayDelivery).toHaveBeenCalledWith("bdl_1"))
  })

  it("says why replay is unavailable, but only when there is one to replay", () => {
    readiness = {
      route: "unavailable",
      availability: { state: "unsupported", reason: "requires-companion" },
      can: false,
    }
    const { unmount } = render(<BotDeliveriesSection row={row()} />)
    // No dead letter yet, so no refusal to explain.
    expect(screen.queryByTestId("bot-replay-blocked")).not.toBeInTheDocument()
    unmount()

    deliveries = { rows: [delivery({ status: "deadletter" })], loading: false }
    render(<BotDeliveriesSection row={row()} />)
    expect(screen.getByTestId("bot-replay-blocked")).toHaveTextContent(
      "This browser cannot run Bots"
    )
    expect(screen.getByTestId("bot-delivery-replay-bdl_1")).toBeDisabled()
  })

  it("shows placeholder bars while loading, not an empty state", () => {
    deliveries = { rows: [], loading: true }
    render(<BotDeliveriesSection row={row()} />)
    expect(screen.getByTestId("bot-deliveries-loading")).toBeInTheDocument()
    expect(screen.queryByText("No deliveries")).not.toBeInTheDocument()
  })

  it("explains an empty queue rather than rendering nothing", () => {
    render(<BotDeliveriesSection row={row()} />)
    expect(screen.getByText("No deliveries")).toBeInTheDocument()
  })

  it("paints a parked delivery as needing someone, not as settled", () => {
    // A run waiting on a person is the one row on the list that will never
    // move on its own.
    deliveries = { rows: [delivery({ status: "parked" })], loading: false }
    render(<BotDeliveriesSection row={row()} />)
    expect(screen.getByTestId("bot-delivery-bdl_1")).toHaveTextContent("Waiting")
  })
})
