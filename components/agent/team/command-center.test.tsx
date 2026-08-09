/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const controlDurableRuns = jest.fn<
  Promise<Array<{ runId: string }>>,
  [runIds: string[], action: string]
>(async () => [{ runId: "run-1" }])

jest.mock("@/lib/ai/agent/team/durable-control", () => ({
  controlDurableRuns: (runIds: string[], action: string) => controlDurableRuns(runIds, action),
}))

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (state: unknown) => unknown) =>
    selector({
      teams: {
        "team-1": {
          id: "team-1",
          name: "Durable Team",
          config: { runtimeVersion: "durable-v2" },
        },
      },
    }),
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => ({
    runs: [
      {
        id: "run-1",
        teamId: "team-1",
        projectId: "project-1",
        objective: "Ship durable orchestration",
        status: "needs_input",
        recoveryReason: "side_effect_uncertain:tool-1",
        priority: 4,
        decisionVersion: 0,
        resourceUsage: { totalTokens: 120, wallTimeMs: 12_000 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
    children: [
      {
        id: "child-1",
        runId: "run-1",
        repositoryId: "primary",
        status: "running",
      },
    ],
    graphs: [],
    deliveryNodes: [],
    retrospectives: [],
  }),
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { AgentTeamCommandCenter } from "./command-center"

describe("AgentTeamCommandCenter", () => {
  it("projects durable runs and applies a bulk control", async () => {
    const user = userEvent.setup()
    render(<AgentTeamCommandCenter />)

    expect(screen.getAllByText("Durable Team")).toHaveLength(2)
    expect(screen.getByText("Ship durable orchestration")).toBeInTheDocument()
    await user.click(screen.getByRole("checkbox", { name: /run-1/i }))
    await user.click(screen.getByRole("button", { name: /pause/i }))

    expect(controlDurableRuns).toHaveBeenCalledWith(["run-1"], "pause")
  })

  it("filters runs by repository", async () => {
    const user = userEvent.setup()
    render(<AgentTeamCommandCenter />)
    await user.selectOptions(screen.getByRole("combobox", { name: /repository/i }), "primary")
    expect(screen.getByTestId("command-run-run-1")).toBeInTheDocument()
  })

  it("filters runs by project, team, runtime, gate, and failure class", async () => {
    const user = userEvent.setup()
    render(<AgentTeamCommandCenter />)

    await user.selectOptions(screen.getByRole("combobox", { name: /^project$/i }), "project-1")
    await user.selectOptions(screen.getByRole("combobox", { name: /^team$/i }), "team-1")
    await user.selectOptions(screen.getByRole("combobox", { name: /^runtime$/i }), "durable-v2")
    await user.selectOptions(screen.getByRole("combobox", { name: /^gate$/i }), "pending")
    await user.selectOptions(
      screen.getByRole("combobox", { name: /failure class/i }),
      "side_effect_uncertain"
    )

    expect(screen.getByTestId("command-run-run-1")).toBeInTheDocument()
  })
})
