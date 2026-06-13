/**
 * @jest-environment node
 */
import { formatTeamDoc, teamList, teamRunUnavailable, teamShow } from "./team-controller"
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
  it("opens a markdown document with the team's orchestration + members", async () => {
    const { dispatch, actions } = recorder()
    await teamShow("t1", {
      dispatch,
      ensureDb: async () => {},
      get: async () => team("t1", "Squad", 3),
    })
    expect(actions[0]).toMatchObject({
      type: "OVERLAY_OPEN",
      overlay: { kind: "document", format: "markdown" },
    })
    const body = (actions[0] as { overlay: { body: string } }).overlay.body
    expect(body).toContain("Squad")
    expect(body).toContain("round-robin")
    expect(body).toContain("c0")
    expect(body).toContain("c2")
  })

  it("notices a missing team", async () => {
    const { dispatch, actions } = recorder()
    await teamShow("x", { dispatch, ensureDb: async () => {}, get: async () => undefined })
    expect((actions[0] as { message: string }).message).toContain("not found")
  })
})

describe("formatTeamDoc", () => {
  it("marks the supervisor lead and renders member overrides", () => {
    const supervised = {
      id: "t2",
      name: "Brain Trust",
      description: "deep work",
      avatarColor: "#000",
      orchestration: "supervisor",
      supervisorCharacterId: "lead1",
      members: [
        { characterId: "lead1", role: "Lead", modelOverride: "opus" },
        { characterId: "w1", role: "Worker", allowedToolsOverride: ["read", "grep"] },
      ],
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Team
    const doc = formatTeamDoc(supervised)
    expect(doc).toContain("# Brain Trust")
    expect(doc).toContain("supervisor")
    expect(doc).toContain("lead `lead1`")
    expect(doc).toContain("👑")
    expect(doc).toContain("model: opus")
    expect(doc).toContain("tools: read, grep")
    expect(doc).toContain("> deep work")
    expect(doc).toContain("desktop app")
  })
})

describe("teamRunUnavailable", () => {
  it("explains that team execution is desktop-only", () => {
    const { dispatch, actions } = recorder()
    teamRunUnavailable({ dispatch })
    expect((actions[0] as { message: string }).message).toContain("desktop")
  })
})
