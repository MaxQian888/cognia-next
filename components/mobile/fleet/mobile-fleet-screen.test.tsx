/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

import { MobileFleetScreen } from "./mobile-fleet-screen"
import type { FleetSession, FleetSnapshot } from "@/lib/fleet/types"
import type { FleetSnapshotSource } from "@/hooks/fleet/use-fleet-snapshot"

const snapshotState: { snapshot: FleetSnapshot; source: FleetSnapshotSource } = {
  snapshot: { sessions: [], generatedAt: 0 },
  source: "companion",
}
jest.mock("@/hooks/fleet/use-fleet-snapshot", () => ({
  useFleetSnapshot: () => snapshotState,
}))
jest.mock("./mobile-fleet-row", () => ({
  MobileFleetRow: ({ session }: { session: { sessionId: string } }) => (
    <div data-testid={`fleet-row-${session.sessionId}`} />
  ),
}))

const sessionLike = (id: string, status: FleetSession["status"] = "working"): FleetSession =>
  ({ agent: "claude-code", sessionId: id, status, lastEventAt: 0 }) as FleetSession

describe("MobileFleetScreen", () => {
  it("prompts to connect when there is no companion source", () => {
    snapshotState.source = "none"
    render(<MobileFleetScreen />)
    expect(screen.getByTestId("mobile-fleet-connect")).toBeInTheDocument()
  })

  it("shows the empty state when connected with no sessions", () => {
    snapshotState.source = "companion"
    snapshotState.snapshot = { sessions: [], generatedAt: 1 }
    render(<MobileFleetScreen />)
    expect(screen.getByTestId("mobile-fleet-empty")).toBeInTheDocument()
  })

  it("renders a row per session with a summary", () => {
    snapshotState.source = "companion"
    snapshotState.snapshot = {
      sessions: [sessionLike("a"), sessionLike("b", "waiting-input")],
      generatedAt: 2,
    }
    render(<MobileFleetScreen />)
    expect(screen.getByTestId("fleet-row-a")).toBeInTheDocument()
    expect(screen.getByTestId("fleet-row-b")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-fleet-summary")).toBeInTheDocument()
  })

  it("omits the waiting suffix when nothing needs attention", () => {
    snapshotState.source = "companion"
    snapshotState.snapshot = { sessions: [sessionLike("only", "working")], generatedAt: 4 }
    render(<MobileFleetScreen />)
    expect(screen.getByTestId("mobile-fleet-summary").textContent).not.toContain("waiting")
  })

  it("groups managed sessions under authenticated worker hosts", () => {
    snapshotState.source = "companion"
    snapshotState.snapshot = {
      sessions: [{ ...sessionLike("remote"), hostRef: "device:a", origin: "managed-team" }],
      hosts: [
        {
          hostRef: "device:a",
          online: true,
          maxActiveTurns: 1,
          usedSlots: 1,
          runtime: "test",
          workspaceBindingReady: true,
          lastSeenAt: 1,
        },
      ],
      generatedAt: 5,
    }
    render(<MobileFleetScreen />)
    expect(screen.getByTestId("fleet-host-device:a")).toContainElement(
      screen.getByTestId("fleet-row-remote")
    )
  })
})
