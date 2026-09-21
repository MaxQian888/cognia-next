/**
 * @jest-environment jsdom
 */

import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let mockRow: unknown = undefined
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockRow,
}))

const mockToastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => mockToastError(...args) } }))

import {
  companionRunAnswerOf,
  companionRunSummaryOf,
  emptyCompanionRunFollow,
  type CompanionRunFollow,
  type PendingCompanionRun,
} from "@/lib/router-fusion/api/companion-run-client"

import { CompanionFusionRunList, CompanionFusionRunView } from "./companion-fusion-run-view"

const RUN = "8b1f7a2e-0000-4000-8000-000000000001"

const pending: PendingCompanionRun = {
  rowId: "row-1",
  idempotencyKey: "companion-run:k",
  payload: { mode: "panel", text: "compare", sessionId: "s1", idempotencyKey: "companion-run:k" },
  mode: "panel",
  sessionId: "s1",
  createdAt: 1,
}

function event(seq: number, type: string, payload: Record<string, unknown> = {}) {
  return {
    schema_version: "1.0.0",
    run_id: RUN,
    seq,
    event_type: type,
    timestamp: new Date(1_800_000_000_000 + seq).toISOString(),
    payload,
  }
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  let publish: ((view: CompanionRunFollow) => void) | null = null
  const client = {
    readBackCompanionFusionRun: jest.fn(async () => ({ ok: true, value: { run_id: RUN } })),
    followCompanionFusionRun: jest.fn(
      (_runId: string, options: { onUpdate: (view: CompanionRunFollow) => void }) => {
        publish = options.onUpdate
        return new Promise(() => undefined)
      }
    ),
    cancelCompanionFusionRun: jest.fn(async () => ({ accepted: true })),
    companionRunSummaryOf,
    companionRunAnswerOf,
    ...overrides,
  }
  return {
    client,
    load: async () => client as never,
    publish: (view: CompanionRunFollow) => act(() => publish?.(view)),
  }
}

beforeEach(() => {
  mockRow = undefined
  mockToastError.mockReset()
})

describe("CompanionFusionRunView", () => {
  it("waits for the queue to deliver before asking the host anything", async () => {
    mockRow = { id: "row-1", status: "pending" }
    const { client, load } = fakeClient()
    render(<CompanionFusionRunView run={pending} onDismiss={jest.fn()} loadClient={load} />)
    expect(await screen.findByTestId("companion-fusion-run-queued")).toHaveTextContent(
      "Waiting to reach the host…"
    )
    expect(screen.getByTestId("companion-fusion-run")).toHaveAttribute("data-stage", "queued")
    expect(screen.getByText("Panel run")).toBeInTheDocument()
    await waitFor(() => expect(client.readBackCompanionFusionRun).not.toHaveBeenCalled())
  })

  it("says why a run never reached the host, and can be dismissed", async () => {
    const user = userEvent.setup()
    mockRow = { id: "row-1", status: "deadlettered", lastError: "403 missing_capability" }
    const onDismiss = jest.fn()
    const { load } = fakeClient()
    render(<CompanionFusionRunView run={pending} onDismiss={onDismiss} loadClient={load} />)
    expect(await screen.findByTestId("companion-fusion-run-undelivered")).toHaveTextContent(
      "The run never reached the host: 403 missing_capability"
    )
    await user.click(screen.getByTestId("companion-fusion-run-dismiss"))
    expect(onDismiss).toHaveBeenCalledWith("row-1")
  })

  it("shows the host's refusal of a delivered run in words", async () => {
    mockRow = { id: "row-1", status: "sent" }
    const { client, load } = fakeClient({
      readBackCompanionFusionRun: jest.fn(async () => ({
        ok: false,
        error: { code: "ROUTER_FUSION_DISABLED", message: "off" },
      })),
    })
    render(<CompanionFusionRunView run={pending} onDismiss={jest.fn()} loadClient={load} />)
    expect(await screen.findByTestId("companion-fusion-run-refused")).toHaveTextContent(
      "Router + Fusion is switched off for companions on the host."
    )
    expect(client.readBackCompanionFusionRun).toHaveBeenCalledWith(pending)
    expect(client.followCompanionFusionRun).not.toHaveBeenCalled()
  })

  it("follows a delivered run, stops it on request, and shows the verified answer and its card", async () => {
    const user = userEvent.setup()
    mockRow = null // delivered and vacuumed
    const { client, load, publish } = fakeClient()
    render(<CompanionFusionRunView run={pending} onDismiss={jest.fn()} loadClient={load} />)
    await waitFor(() => expect(client.followCompanionFusionRun).toHaveBeenCalled())
    expect(client.followCompanionFusionRun.mock.calls[0][0]).toBe(RUN)

    await publish({
      ...emptyCompanionRunFollow(RUN),
      events: [
        event(1, "run.queued", { cap_microusd: 2_500_000 }),
        event(2, "route.selected", { action_id: "panel_research", mode: "panel", roles: {} }),
      ] as never,
      lastSeq: 2,
    })
    expect(screen.getByTestId("companion-fusion-run")).toHaveAttribute("data-stage", "following")
    expect(screen.getByTestId("companion-fusion-run-status")).toHaveTextContent("Running")
    await user.click(screen.getByTestId("companion-fusion-run-stop"))
    expect(client.cancelCompanionFusionRun).toHaveBeenCalledWith(RUN, 2)

    await publish({
      ...emptyCompanionRunFollow(RUN),
      events: [
        event(1, "run.queued", { cap_microusd: 2_500_000 }),
        event(2, "route.selected", { action_id: "panel_research", mode: "panel", roles: {} }),
        event(3, "answer.completed", { quality_status: "accepted" }),
        event(4, "run.completed"),
      ] as never,
      lastSeq: 4,
      terminal: true,
      snapshot: {
        status: "succeeded",
        result: { answer: "Design B wins on latency." },
        billing: {
          budget_cap_microusd: 2_500_000,
          spent_microusd: 12_000,
          model_calls: 4,
          status: "actual",
        },
        error: null,
        decision: null,
      } as never,
    })
    expect(screen.getByTestId("companion-fusion-run-answer")).toHaveTextContent(
      "Design B wins on latency."
    )
    expect(screen.queryByTestId("companion-fusion-run-stop")).toBeNull()
    expect(screen.getByTestId("companion-fusion-run-status")).toHaveTextContent("Succeeded")
    await user.click(screen.getByTestId("companion-fusion-run-details-toggle"))
    expect(await screen.findByTestId("router-fusion-fusion-details")).toHaveTextContent(
      "panel_research"
    )
  })

  it("says the timeline is incomplete when the host no longer holds its history", async () => {
    mockRow = { id: "row-1", status: "sent" }
    const { load, publish, client } = fakeClient()
    render(<CompanionFusionRunView run={pending} onDismiss={jest.fn()} loadClient={load} />)
    await waitFor(() => expect(client.followCompanionFusionRun).toHaveBeenCalled())
    await publish({ ...emptyCompanionRunFollow(RUN), historyExpired: true })
    expect(screen.getByTestId("companion-fusion-run-history-expired")).toBeInTheDocument()
  })

  it("reports a stop the host refused", async () => {
    const user = userEvent.setup()
    mockRow = { id: "row-1", status: "sent" }
    const { load, publish, client } = fakeClient({
      cancelCompanionFusionRun: jest.fn(async () => ({ accepted: false, code: "RUN_NOT_FOUND" })),
    })
    render(<CompanionFusionRunView run={pending} onDismiss={jest.fn()} loadClient={load} />)
    await waitFor(() => expect(client.followCompanionFusionRun).toHaveBeenCalled())
    await publish({
      ...emptyCompanionRunFollow(RUN),
      events: [event(1, "run.queued")] as never,
      lastSeq: 1,
    })
    await user.click(screen.getByTestId("companion-fusion-run-stop"))
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("The run could not be stopped (RUN_NOT_FOUND).")
    )
  })
})

describe("CompanionFusionRunList", () => {
  it("renders nothing without runs, and one card per run", async () => {
    const { load } = fakeClient()
    const { rerender } = render(
      <CompanionFusionRunList runs={[]} onDismiss={jest.fn()} loadClient={load} />
    )
    expect(screen.queryByTestId("companion-fusion-runs")).toBeNull()
    mockRow = { id: "row-1", status: "pending" }
    rerender(<CompanionFusionRunList runs={[pending]} onDismiss={jest.fn()} loadClient={load} />)
    expect(
      screen.getByRole("region", { name: "Router + Fusion runs started from this device" })
    ).toBeInTheDocument()
    expect(await screen.findAllByTestId("companion-fusion-run")).toHaveLength(1)
  })
})
