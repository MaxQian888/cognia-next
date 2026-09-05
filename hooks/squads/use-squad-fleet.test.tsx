/** @jest-environment jsdom */

// The one Squad projection. Triage, workspace scope, narrowing and the
// loaded-versus-empty distinction live here, so they are tested here against
// the real store rather than through two layers of rendering.

import { renderHook } from "@testing-library/react"

import { useSquadFleet } from "./use-squad-fleet"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { AgentTeam, AgentTeammate, TeamStatus } from "@/types/agent/agent-team"

let mirroredCount: number | undefined = 0
jest.mock("@/hooks/data", () => ({ useClientLiveQuery: () => mirroredCount }))

// Durable Squad reviews (ADR-0169). The hook only ever yields PENDING rows, so
// the helper below models what the table would answer, not a UI mirror.
let pendingReviews: Array<{ teamId: string; status: "open" }> = []
jest.mock("./use-pending-squad-reviews", () => ({
  usePendingSquadReviews: () => pendingReviews,
}))

function squad(
  id: string,
  name: string,
  over: Partial<AgentTeam> = {},
  status: TeamStatus = "idle"
): AgentTeam {
  return {
    id,
    name,
    description: "",
    status,
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    config: {},
    ...over,
  } as unknown as AgentTeam
}

function seed(teams: AgentTeam[], members: Partial<AgentTeammate>[] = []) {
  useAgentTeamStore.setState({
    teams: Object.fromEntries(teams.map((t) => [t.id, t])) as never,
    teammates: Object.fromEntries(members.map((m, i) => [m.id ?? `m${i}`, m])) as never,
  })
}

function gates(entries: Array<{ teamId?: string; status?: "open" | "interrupted" }>) {
  // A review that is no longer pending is simply not in the durable answer.
  pendingReviews = entries
    .filter((entry) => entry.teamId && entry.status !== "interrupted")
    .map((entry) => ({ teamId: entry.teamId!, status: "open" as const }))
}

beforeEach(() => {
  mirroredCount = 0
  gates([])
  useProjectStore.setState({ activeProjectId: null } as never)
  seed([])
})

describe("triage", () => {
  /**
   * A fleet view is read to find what needs YOU. A Squad blocked on an approval
   * is the one row that will not move until it is answered, and sorting it
   * below an alphabetically earlier idle Squad buries the only actionable thing
   * on the page. `PendingGate.teamId` has carried this all along, so nothing
   * new is stored to sort by it.
   */
  it("puts a Squad waiting on a human above a working one", () => {
    seed([squad("a", "Alpha", {}, "executing"), squad("z", "Zulu")])
    gates([{ teamId: "z" }])
    const { result } = renderHook(() => useSquadFleet())
    expect(result.current.squads.map((s) => s.id)).toEqual(["z", "a"])
    expect(result.current.waiting).toBe(1)
  })

  it("puts working Squads above idle ones, then falls back to name", () => {
    seed([squad("m", "Mike"), squad("a", "Alpha"), squad("z", "Zulu", {}, "planning")])
    const { result } = renderHook(() => useSquadFleet())
    expect(result.current.squads.map((s) => s.id)).toEqual(["z", "a", "m"])
    expect(result.current.live).toBe(1)
  })

  /**
   * Only a PENDING durable review counts. A settled or expired one is not in
   * the answer at all, so a Squad nothing can unblock never floats to the top.
   */
  it("ignores a review that is no longer pending", () => {
    seed([squad("a", "Alpha"), squad("z", "Zulu")])
    gates([{ teamId: "z", status: "interrupted" }])
    const { result } = renderHook(() => useSquadFleet())
    expect(result.current.waiting).toBe(0)
    expect(result.current.squads[0]!.id).toBe("a")
  })
})

describe("workspace scope", () => {
  it("hides a Squad from another workspace and keeps an unscoped one", () => {
    // A Squad with no project is shared, not foreign.
    seed([
      squad("mine", "Mine", { projectId: "p1" }),
      squad("theirs", "Theirs", { projectId: "p2" }),
      squad("shared", "Shared"),
    ])
    useProjectStore.setState({ activeProjectId: "p1" } as never)
    const { result } = renderHook(() => useSquadFleet())
    expect(result.current.squads.map((s) => s.id).sort()).toEqual(["mine", "shared"])
    expect(result.current.total).toBe(2)
  })
})

describe("narrowing", () => {
  it("matches on name and description, case-insensitively", () => {
    seed([
      squad("a", "Review Crew"),
      squad("b", "Docs", { description: "reviews the changelog" }),
      squad("c", "Deploy"),
    ])
    const { result } = renderHook(() => useSquadFleet({ query: "REVIEW" }))
    expect(result.current.squads.map((s) => s.id).sort()).toEqual(["a", "b"])
  })

  /** `total`, `live` and `waiting` describe the workspace, not the narrowed view. */
  it("keeps the headline counts about the workspace, not the filtered list", () => {
    seed([squad("a", "Alpha", {}, "executing"), squad("z", "Zulu")])
    const { result } = renderHook(() => useSquadFleet({ query: "Zulu" }))
    expect(result.current.squads).toHaveLength(1)
    expect(result.current.total).toBe(2)
    expect(result.current.live).toBe(1)
  })

  it("filters to what needs you, and to what is working", () => {
    seed([squad("a", "Alpha", {}, "executing"), squad("z", "Zulu")])
    gates([{ teamId: "z" }])
    const waiting = renderHook(() => useSquadFleet({ filter: "waiting" }))
    expect(waiting.result.current.squads.map((s) => s.id)).toEqual(["z"])
    const live = renderHook(() => useSquadFleet({ filter: "live" }))
    expect(live.result.current.squads.map((s) => s.id)).toEqual(["a"])
  })
})

describe("member counts", () => {
  it("counts only the Squad's own roster", () => {
    seed(
      [squad("a", "Alpha"), squad("b", "Bravo")],
      [
        { id: "m1", teamId: "a" },
        { id: "m2", teamId: "a" },
        { id: "m3", teamId: "b" },
      ]
    )
    const { result } = renderHook(() => useSquadFleet())
    const byId = Object.fromEntries(result.current.squads.map((s) => [s.id, s.memberCount]))
    expect(byId).toEqual({ a: 2, b: 1 })
  })
})

describe("loading", () => {
  /**
   * Since persist v8 the definitions arrive through the store's async Dexie
   * bridge rather than out of localStorage, so a cold page rendered "No Squads
   * yet" for the whole first read. That is a claim about the user's data, made
   * before anything had been read.
   */
  it("is loading while Dexie has not answered and the store is empty", () => {
    mirroredCount = undefined
    const { result } = renderHook(() => useSquadFleet())
    expect(result.current.loading).toBe(true)
  })

  it("is not loading once the store has rows, even mid-read", () => {
    mirroredCount = undefined
    seed([squad("a", "Alpha")])
    const { result } = renderHook(() => useSquadFleet())
    expect(result.current.loading).toBe(false)
  })

  it("is not loading when Dexie answers that there are none", () => {
    mirroredCount = 0
    const { result } = renderHook(() => useSquadFleet())
    expect(result.current.loading).toBe(false)
    expect(result.current.total).toBe(0)
  })
})
