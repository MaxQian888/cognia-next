/** @jest-environment jsdom */

// Creating a Squad needs three pieces assembled: the store action, the active
// Project row, and names from the caller's namespace. Only the Settings
// library did that, which is most of why creating one meant navigating there.

import { renderHook } from "@testing-library/react"

import { useCreateSquad } from "./use-create-squad"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { Project } from "@/types"

const createSquad = jest.fn(async () => ({ id: "new" }))
jest.mock("@/lib/agent-team/create-squad", () => ({
  createSquad: (...a: unknown[]) => createSquad(...(a as [])),
}))

beforeEach(() => {
  jest.clearAllMocks()
  useProjectStore.setState({ projects: [], activeProjectId: null } as never)
})

/**
 * Through `createSquad`, not `store.createTeam`. That wrapper is async
 * precisely because resolving the durable-v2 default needs two Dexie reads and
 * a host preflight, and a Squad made from a console deserves the same default
 * one made in Settings gets.
 */
it("goes through createSquad so the durable default is resolved", async () => {
  const { result } = renderHook(() => useCreateSquad())
  await result.current({ name: "New Squad", leadName: "Team Lead" })
  expect(createSquad).toHaveBeenCalledWith(
    expect.objectContaining({ name: "New Squad", leadName: "Team Lead", task: "" }),
    expect.objectContaining({ createTeam: useAgentTeamStore.getState().createTeam })
  )
})

/** The resolver reads the workspace root off the Project row, not off an id. */
it("hands it the active Project row, not the id", async () => {
  const project = { id: "p1", name: "Repo" } as unknown as Project
  useProjectStore.setState({ projects: [project], activeProjectId: "p1" } as never)
  const { result } = renderHook(() => useCreateSquad())
  await result.current({ name: "x", leadName: "y" })
  expect(createSquad).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ project }))
})

it("passes no project when none is active, so the Squad is shared", async () => {
  const { result } = renderHook(() => useCreateSquad())
  await result.current({ name: "x", leadName: "y" })
  expect(createSquad.mock.calls[0]![1]).toMatchObject({ project: undefined })
})
