/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Operation, OperationEvent } from "@/lib/server-ops/client"
import { isCancellableOperation, OperationInspector } from "./operation-inspector"

const operation = (overrides: Partial<Operation> = {}): Operation => ({
  id: "3f1d2c00-0000-4000-8000-000000000001",
  targetId: "staging",
  kind: "deploy",
  state: "queued",
  request: { targetRevision: 3 },
  result: null,
  error: null,
  createdBy: "operator@example.com",
  createdAt: "2026-08-19T10:00:00.000Z",
  updatedAt: "2026-08-19T10:05:00.000Z",
  ...overrides,
})

function renderInspector(
  value: Operation | null,
  loadEvents?: ((operationId: string) => Promise<OperationEvent[]>) | null
) {
  const onCancel = jest.fn()
  const onOpenChange = jest.fn()
  render(
    <OperationInspector
      operation={value}
      loadEvents={loadEvents}
      onOpenChange={onOpenChange}
      onCancel={onCancel}
    />
  )
  return { onCancel, onOpenChange }
}

const event = (overrides: Partial<OperationEvent> = {}): OperationEvent => ({
  id: 1,
  operationId: "3f1d2c00-0000-4000-8000-000000000001",
  targetId: "staging",
  state: "queued",
  timestamp: "2026-08-19T10:00:00.000Z",
  message: "operation queued",
  ...overrides,
})

describe("isCancellableOperation", () => {
  it("is true only before an agent claims the operation", () => {
    // Past `queued` the agent holds the target lock and is already changing the
    // host, so a controller-side "cancelled" would be a claim it cannot back.
    expect(isCancellableOperation(operation({ state: "queued" }))).toBe(true)
    for (const state of ["validating", "preparing", "executing", "succeeded"] as const) {
      expect(isCancellableOperation(operation({ state }))).toBe(false)
    }
  })
})

it("shows the controller's error code and message on a failure", () => {
  // The old panel fetched both and rendered neither, so a failed operation was
  // a red badge with no way to learn why.
  renderInspector(
    operation({
      state: "failed",
      error: { code: "target_busy", message: "Another destructive operation is running" },
    })
  )

  expect(screen.getByText("target_busy")).toBeInTheDocument()
  expect(screen.getByText("Another destructive operation is running")).toBeInTheDocument()
})

it("renders the agent's result payload once there is one", () => {
  renderInspector(operation({ state: "succeeded", result: { recoveryPoints: [{ id: "rp-1" }] } }))
  expect(screen.getByText("Result")).toBeInTheDocument()
  expect(screen.getByText(/rp-1/)).toBeInTheDocument()
})

it("omits the result block while the operation has produced none", () => {
  renderInspector(operation())
  expect(screen.queryByText("Result")).not.toBeInTheDocument()
  expect(screen.getByText("Request")).toBeInTheDocument()
})

it("confirms before cancelling and reports the operation id upward", async () => {
  const user = userEvent.setup()
  const { onCancel } = renderInspector(operation())

  await user.click(screen.getByRole("button", { name: "Cancel operation" }))
  // A confirmation step, not a bare button: this is the one control in the
  // inspector that changes controller state.
  expect(screen.getByText("Cancel this queued operation?")).toBeInTheDocument()

  await user.click(screen.getByRole("button", { name: "Cancel operation" }))
  expect(onCancel).toHaveBeenCalledWith("3f1d2c00-0000-4000-8000-000000000001")
})

it("disables cancelling for a claimed operation and says why", () => {
  renderInspector(operation({ state: "executing" }))
  expect(screen.getByRole("button", { name: "Cancel operation" })).toBeDisabled()
  expect(
    screen.getByText(
      "An agent has claimed this operation, so it can no longer be cancelled from here."
    )
  ).toBeInTheDocument()
})

it("renders nothing when no operation is selected", () => {
  renderInspector(null)
  expect(screen.queryByText("Request")).not.toBeInTheDocument()
})

describe("timeline", () => {
  it("renders the controller's state-change trail in order", async () => {
    const loadEvents = jest
      .fn()
      .mockResolvedValue([
        event({ id: 1, state: "queued", message: "operation queued" }),
        event({ id: 2, state: "executing", message: "operation executing" }),
      ])
    renderInspector(operation({ state: "executing" }), loadEvents)

    await waitFor(() => expect(loadEvents).toHaveBeenCalledWith(operation().id))
    expect(await screen.findByText("operation queued")).toBeInTheDocument()
    expect(screen.getByText("operation executing")).toBeInTheDocument()
  })

  it("says the trail is empty rather than implying nothing happened", async () => {
    // An operation opened from history has no stream events to accumulate, so
    // a blank section would read as "nothing happened".
    renderInspector(operation(), jest.fn().mockResolvedValue([]))
    expect(
      await screen.findByText(
        "The controller has not recorded a state change for this operation yet."
      )
    ).toBeInTheDocument()
  })

  it("reports a failed trail load inline instead of as a toast", async () => {
    renderInspector(operation(), jest.fn().mockRejectedValue(new Error("gone")))
    expect(
      await screen.findByText("The state-change trail could not be loaded.")
    ).toBeInTheDocument()
  })

  it("shows the empty note when disconnected rather than calling nothing", () => {
    renderInspector(operation(), null)
    expect(
      screen.getByText("The controller has not recorded a state change for this operation yet.")
    ).toBeInTheDocument()
  })
})
