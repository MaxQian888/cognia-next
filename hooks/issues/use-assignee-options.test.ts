/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let charactersForTest: Array<{ id: string; name: string }> = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: () => charactersForTest,
}))
jest.mock("@/lib/db/characters", () => ({ listCharacters: jest.fn() }))

let teamsForTest: Record<string, { id: string; name: string; projectId?: string }> = {}
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: { teams: unknown }) => unknown) =>
    selector({ teams: teamsForTest }),
}))

let workspaceId: string | null = "w1"
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: { activeProjectId: string | null }) => unknown) =>
    selector({ activeProjectId: workspaceId }),
}))

import { renderHook } from "@testing-library/react"
import { useAssigneeOptions } from "./use-assignee-options"

beforeEach(() => {
  charactersForTest = []
  teamsForTest = {}
  workspaceId = "w1"
})

describe("useAssigneeOptions", () => {
  it("always offers the local human first", () => {
    const { result } = renderHook(() => useAssigneeOptions())
    expect(result.current[0]).toMatchObject({ key: "human:self", group: "human" })
  })

  it("offers every Character as an agent actor", () => {
    charactersForTest = [{ id: "c1", name: "Scout" }]
    const { result } = renderHook(() => useAssigneeOptions())
    expect(result.current).toContainEqual(
      expect.objectContaining({
        key: "agent:c1",
        group: "agent",
        actor: { kind: "agent", id: "c1", label: "Scout" },
      })
    )
  })

  it("offers teams in this workspace", () => {
    teamsForTest = { t1: { id: "t1", name: "Squad", projectId: "w1" } }
    const { result } = renderHook(() => useAssigneeOptions())
    expect(result.current).toContainEqual(expect.objectContaining({ key: "team:t1" }))
  })

  it("hides a team belonging to a different workspace, which could never be dispatched", () => {
    teamsForTest = { t1: { id: "t1", name: "Elsewhere", projectId: "w2" } }
    const { result } = renderHook(() => useAssigneeOptions())
    expect(result.current.some((option) => option.key === "team:t1")).toBe(false)
  })

  it("keeps a workspace-less team, which belongs everywhere", () => {
    teamsForTest = { t1: { id: "t1", name: "Global" } }
    const { result } = renderHook(() => useAssigneeOptions())
    expect(result.current.some((option) => option.key === "team:t1")).toBe(true)
  })

  it("keeps every team when no workspace is active", () => {
    workspaceId = null
    teamsForTest = { t1: { id: "t1", name: "Squad", projectId: "w2" } }
    const { result } = renderHook(() => useAssigneeOptions())
    expect(result.current.some((option) => option.key === "team:t1")).toBe(true)
  })
})
