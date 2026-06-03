/** @jest-environment jsdom */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { EventsTab } from "./events-tab"
import { emitSchedulerEvent } from "@/lib/scheduler/event-integration"

jest.mock("@/lib/scheduler/event-integration", () => {
  const actual = jest.requireActual("@/lib/scheduler/event-integration")
  return { ...actual, emitSchedulerEvent: jest.fn(async () => {}) }
})

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const listRemoteControlAudit = jest.fn()
jest.mock("@/lib/db/remote-control-audit", () => ({
  listRemoteControlAudit: (...a: unknown[]) => listRemoteControlAudit(...a),
}))

beforeEach(() => {
  jest.clearAllMocks()
  listRemoteControlAudit.mockResolvedValue([])
})

describe("EventsTab", () => {
  it("lists every SchedulerEventType including custom", () => {
    render(<EventsTab />)
    const expected = [
      "session:created",
      "session:completed",
      "session:deleted",
      "sync:started",
      "sync:completed",
      "sync:failed",
      "backup:needed",
      "backup:completed",
      "workflow:completed",
      "agent:completed",
      "custom",
    ]
    for (const name of expected) {
      expect(screen.getByText(name)).toBeInTheDocument()
    }
  })

  it("renders durable audit rows and filters by direction", async () => {
    listRemoteControlAudit.mockResolvedValueOnce([
      {
        id: "a1",
        at: 1748908800000,
        direction: "inbound",
        kind: "inbound.command",
        target: "workflow.run",
        result: "accepted",
      },
    ])
    render(<EventsTab />)
    await waitFor(() => expect(screen.getByText("workflow.run")).toBeInTheDocument())

    // Switching to the Outbound filter re-queries with direction: "outbound".
    fireEvent.click(screen.getByRole("button", { name: /^outbound$/i }))
    await waitFor(() =>
      expect(listRemoteControlAudit).toHaveBeenCalledWith(
        expect.objectContaining({ direction: "outbound" })
      )
    )
  })

  it("dispatches the corresponding event when the test button is clicked", async () => {
    render(<EventsTab />)
    const buttons = screen.getAllByRole("button", { name: /emit test/i })
    fireEvent.click(buttons[0])
    await waitFor(() =>
      expect(emitSchedulerEvent).toHaveBeenCalledWith(
        "session:created",
        expect.objectContaining({ source: "remote-control-test" })
      )
    )
  })
})
