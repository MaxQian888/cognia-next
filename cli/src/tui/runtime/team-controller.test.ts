/**
 * @jest-environment node
 */
import { teamList, teamRunUnavailable, teamShow } from "./team-controller"
import type { Team } from "@/lib/claude/types"
import type { TuiAction } from "../state/types"

function recorder() {
  const actions: TuiAction[] = []
  return { dispatch: (a: TuiAction) => actions.push(a), actions }
}

const team = (id: string, name: string, members = 2): Team =>
  ({
    id,
    name,
    avatarColor: "#000",
    members: Array.from({ length: members }, (_, i) => ({ characterId: `c${i}` })),
    orchestration: "round-robin",
    createdAt: 0,
    updatedAt: 0,
  }) as unknown as Team

describe("teamList", () => {
  it("opens a select overlay wired to `team show`", async () => {
    const { dispatch, actions } = recorder()
    await teamList({ dispatch, ensureDb: async () => {}, list: async () => [team("t1", "Squad")] })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: {
        kind: "select",
        onSelectCommand: "team show",
        items: [{ id: "t1", label: "Squad" }],
      },
    })
  })

  it("notices when there are no teams", async () => {
    const { dispatch, actions } = recorder()
    await teamList({ dispatch, ensureDb: async () => {}, list: async () => [] })
    expect(actions[0]).toMatchObject({ type: "NOTICE" })
  })
})

describe("teamShow", () => {
  it("notices the team's orchestration + members", async () => {
    const { dispatch, actions } = recorder()
    await teamShow("t1", {
      dispatch,
      ensureDb: async () => {},
      get: async () => team("t1", "Squad", 3),
    })
    const msg = (actions[0] as { message: string }).message
    expect(msg).toContain("Squad")
    expect(msg).toContain("round-robin")
  })

  it("notices a missing team", async () => {
    const { dispatch, actions } = recorder()
    await teamShow("x", { dispatch, ensureDb: async () => {}, get: async () => undefined })
    expect((actions[0] as { message: string }).message).toContain("not found")
  })
})

describe("teamRunUnavailable", () => {
  it("explains that team execution is desktop-only", () => {
    const { dispatch, actions } = recorder()
    teamRunUnavailable({ dispatch })
    expect((actions[0] as { message: string }).message).toContain("desktop")
  })
})
