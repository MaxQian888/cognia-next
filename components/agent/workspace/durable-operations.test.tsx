/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AgentTeam } from "@/types/agent/agent-team"

let liveValue: unknown = null
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => liveValue }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

jest.mock("@/lib/ai/agent/execution/local-tauri-environment", () => ({
  createLocalTauriExecutionEnvironment: () => ({ preflight: () => ({ ok: true, missing: [] }) }),
}))

import { DurableOperations } from "./durable-operations"

const team = (runtimeVersion: "legacy" | "durable-v2"): AgentTeam =>
  ({
    id: "team-1",
    name: "Team",
    description: "",
    task: "Ship",
    status: "idle",
    config: { runtimeVersion },
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

  it("keeps legacy teams on the legacy runtime", () => {
    render(
      <DurableOperations
        team={team("legacy")}
        onOpenEditor={jest.fn()}
        onOpenTerminal={jest.fn()}
        onOpenBrowser={jest.fn()}
        onMigrate={jest.fn()}
      />
    )
    expect(screen.getByText(/legacy/i)).toBeInTheDocument()
  })

  it("shows the durable empty state before a run exists", () => {
    render(
      <DurableOperations
        team={team("durable-v2")}
        onOpenEditor={jest.fn()}
        onOpenTerminal={jest.fn()}
        onOpenBrowser={jest.fn()}
        onMigrate={jest.fn()}
      />
    )
    expect(screen.getByText(/no durable run/i)).toBeInTheDocument()
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
      retrospective: undefined,
      environment: undefined,
    }
    render(
      <DurableOperations
        team={team("durable-v2")}
        onOpenEditor={jest.fn()}
        onOpenTerminal={onOpenTerminal}
        onOpenBrowser={jest.fn()}
        onMigrate={jest.fn()}
      />
    )

    await user.click(screen.getByRole("button", { name: /open terminal/i }))
    expect(onOpenTerminal).toHaveBeenCalledWith("/repo/.worktrees/child-1")
  })
})
