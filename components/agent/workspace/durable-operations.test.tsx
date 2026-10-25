/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AgentTeam } from "@/types/agent/agent-team"

let liveValue: unknown = null
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => liveValue }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
const retryChildMock = jest.fn<Promise<void>, [string, string?]>(async () => undefined)
jest.mock("@/lib/ai/agent/team/agent-team", () => ({
  agentTeamManager: {
    retryChild: (childRunId: string, hostRef?: string) => retryChildMock(childRunId, hostRef),
  },
}))

jest.mock("@/lib/ai/agent/execution/local-tauri-environment", () => ({
  createLocalTauriExecutionEnvironment: () => ({ preflight: () => ({ ok: true, missing: [] }) }),
}))

const approveAndPublishMock = jest.fn(async (..._args: unknown[]) => "graph-1")
jest.mock("@/lib/ai/agent/team/delivery/github-delivery-adapter", () => ({
  ...jest.requireActual("@/lib/ai/agent/team/delivery/github-delivery-adapter"),
  approveAndPublishGithubStack: (...args: unknown[]) => approveAndPublishMock(...args),
}))

import { DurableOperations } from "./durable-operations"

const team = (): AgentTeam =>
  ({
    id: "team-1",
    name: "Team",
    description: "",
    task: "Ship",
    status: "idle",
    config: {},
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    events: [],
    createdAt: new Date(),
  }) as unknown as AgentTeam

describe("DurableOperations", () => {
  beforeEach(() => {
    liveValue = null
  })

  it("shows the durable empty state before a run exists", () => {
    render(
      <DurableOperations
        team={team()}
        onOpenEditor={jest.fn()}
        onOpenTerminal={jest.fn()}
        onOpenBrowser={jest.fn()}
      />
    )
    expect(screen.getByText(/no durable run/i)).toBeInTheDocument()
  })

  describe("a stack publish the outbound policy held (ADR-0239 phase 2)", () => {
    const held = (recoveryReason: string, graphStatus = "draft", status = "needs_input") => ({
      run: {
        id: "run-1",
        status,
        recoveryReason,
        decisionVersion: 0,
        resourceUsage: { totalTokens: 0 },
      },
      children: [],
      decisions: [],
      evidence: [],
      graph: { id: "graph-1", runId: "run-1", status: graphStatus, createdAt: 1, updatedAt: 1 },
      deliveryNodes: [],
      retrospectives: [],
      environment: undefined,
    })
    const renderPanel = () =>
      render(
        <DurableOperations
          team={team()}
          onOpenEditor={jest.fn()}
          onOpenTerminal={jest.fn()}
          onOpenBrowser={jest.fn()}
        />
      )

    beforeEach(() => approveAndPublishMock.mockClear())

    it("says why it waits and publishes on a person's approval", async () => {
      const user = userEvent.setup()
      liveValue = held("delivery_awaiting_approval")
      renderPanel()
      expect(screen.getByTestId("delivery-publish-held")).toHaveTextContent(
        /nothing authorized publishing/i
      )
      await user.click(screen.getByRole("button", { name: /approve and publish/i }))
      expect(approveAndPublishMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "team-1" }),
        "run-1"
      )
    })

    it("says when a person refused it, and still offers approval", () => {
      liveValue = held("delivery_refused")
      renderPanel()
      expect(screen.getByTestId("delivery-publish-held")).toHaveTextContent(/refused/i)
      expect(screen.getByRole("button", { name: /approve and publish/i })).toBeInTheDocument()
    })

    it.each([
      ["a failed delivery", held("delivery_failed")],
      ["a published graph", held("delivery_awaiting_approval", "running")],
      ["a run no longer waiting", held("delivery_awaiting_approval", "draft", "completed")],
    ])("offers nothing for %s", (_label, value) => {
      liveValue = value
      renderPanel()
      expect(screen.queryByRole("button", { name: /approve and publish/i })).not.toBeInTheDocument()
      expect(screen.queryByTestId("delivery-publish-held")).not.toBeInTheDocument()
    })
  })

  it("opens the takeover terminal at the persisted child worktree", async () => {
    const user = userEvent.setup()
    const onOpenTerminal = jest.fn()
    liveValue = {
      run: {
        id: "run-1",
        status: "running",
        decisionVersion: 0,
        resourceUsage: { totalTokens: 0 },
      },
      children: [
        {
          id: "child-1",
          repositoryId: "primary",
          workspacePath: "/repo/.worktrees/child-1",
          status: "paused",
        },
      ],
      decisions: [],
      evidence: [],
      graph: undefined,
      deliveryNodes: [],
      retrospectives: [],
      environment: undefined,
    }
    render(
      <DurableOperations
        team={team()}
        onOpenEditor={jest.fn()}
        onOpenTerminal={onOpenTerminal}
        onOpenBrowser={jest.fn()}
      />
    )

    await user.click(screen.getByRole("button", { name: /open terminal/i }))
    expect(onOpenTerminal).toHaveBeenCalledWith("/repo/.worktrees/child-1")
  })

  it("shows remote lineage and routes same-host recovery through the manager", async () => {
    const user = userEvent.setup()
    liveValue = {
      run: {
        id: "run-1",
        status: "needs_input",
        decisionVersion: 0,
        resourceUsage: { totalTokens: 0 },
      },
      children: [
        {
          id: "child-remote",
          repositoryId: "primary",
          status: "needs_input",
          hostRef: "device:worker-a",
          remoteSessionId: "remote-session-1",
          waitingReason: "recovery_required",
          dispatchLeaseId: "lease-1",
          dispatchLeaseExpiresAt: Date.now() + 60_000,
        },
      ],
      decisions: [],
      evidence: [],
      graph: undefined,
      deliveryNodes: [],
      retrospectives: [],
      environment: undefined,
    }
    render(
      <DurableOperations
        team={team()}
        onOpenEditor={jest.fn()}
        onOpenTerminal={jest.fn()}
        onOpenBrowser={jest.fn()}
      />
    )

    expect(screen.getByText(/device:worker-a/)).toBeInTheDocument()
    expect(screen.getByText(/remote-session-1/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /retry same host/i }))
    expect(retryChildMock).toHaveBeenCalledWith("child-remote", "device:worker-a")
  })
})
