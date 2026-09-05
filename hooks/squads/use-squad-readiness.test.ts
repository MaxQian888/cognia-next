/** @jest-environment jsdom */
import { renderHook, waitFor } from "@testing-library/react"

const evaluateSquadReadiness = jest.fn()
jest.mock("@/lib/agent-team/squad-readiness", () => ({
  evaluateSquadReadiness: (...args: unknown[]) => evaluateSquadReadiness(...args),
}))
// `useClientLiveQuery` is a thin wrapper over dexie's `useLiveQuery`. Running
// the querier directly is enough to pin the hook's own contract.
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (query: () => Promise<unknown>, deps: unknown[], initial: unknown) => {
    const React = jest.requireActual("react") as typeof import("react")
    const [value, setValue] = React.useState<unknown>(initial)
    React.useEffect(() => {
      let live = true
      void Promise.resolve(query()).then((next) => {
        if (live) setValue(next)
      })
      return () => {
        live = false
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)
    return value
  },
}))

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"
import { useSquadReadiness } from "./use-squad-readiness"

const team = {
  id: "t1",
  name: "T",
  description: "",
  task: "",
  status: "idle",
  config: { repositories: [{ id: "primary", role: "primary", path: "/r", writable: true }] },
  leadId: "lead",
  teammateIds: ["lead", "w1"],
  taskIds: [],
  messageIds: [],
  progress: 0,
  totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  createdAt: new Date(),
} as unknown as AgentTeam

const member = (id: string, role: "lead" | "teammate"): AgentTeammate =>
  ({ id, teamId: "t1", name: id, role, status: "idle", config: {} }) as unknown as AgentTeammate

beforeEach(() => {
  useAgentTeamStore.getState().reset()
  evaluateSquadReadiness.mockReset()
  useAgentTeamStore.getState().upsertTeam(team)
  useAgentTeamStore.getState().upsertTeammate(member("lead", "lead"))
  useAgentTeamStore.getState().upsertTeammate(member("w1", "teammate"))
})

describe("useSquadReadiness", () => {
  it("reports loading, then the evaluation, handing the evaluator the roster", async () => {
    evaluateSquadReadiness.mockResolvedValue({
      ready: false,
      blockers: [{ code: "missing_environment_ref", action: "configure_environment" }],
      evaluatedAt: 5,
    })
    const { result } = renderHook(() => useSquadReadiness("t1"))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.ready).toBe(false)
    expect(result.current.blockers[0]?.code).toBe("missing_environment_ref")
    expect(evaluateSquadReadiness).toHaveBeenCalledWith({
      team: expect.objectContaining({ id: "t1" }),
      teammates: expect.arrayContaining([expect.objectContaining({ id: "w1" })]),
    })
  })

  it("stays pending for an unknown Squad without calling the evaluator", async () => {
    const { result } = renderHook(() => useSquadReadiness("nope"))
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.loading).toBe(true)
    expect(evaluateSquadReadiness).not.toHaveBeenCalled()
  })

  it("treats an evaluator failure as still loading rather than as ready", async () => {
    evaluateSquadReadiness.mockRejectedValue(new Error("db locked"))
    const { result } = renderHook(() => useSquadReadiness("t1"))
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.loading).toBe(true)
    expect(result.current.ready).toBe(false)
  })
})
