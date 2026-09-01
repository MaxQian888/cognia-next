import {
  collectSquadPresence,
  isLiveSquadStatus,
  LIVE_SQUAD_STATUSES,
  type SquadPresenceGate,
  type SquadPresenceMember,
  type SquadPresenceTeam,
} from "./squad-presence"

function team(over: Partial<SquadPresenceTeam> & { id: string }): SquadPresenceTeam {
  return { name: over.id, status: "idle", ...over }
}

function teams(...rows: SquadPresenceTeam[]): Record<string, SquadPresenceTeam> {
  return Object.fromEntries(rows.map((row) => [row.id, row]))
}

function members(...teamIds: string[]): Record<string, SquadPresenceMember> {
  return Object.fromEntries(teamIds.map((teamId, i) => [`m${i}`, { teamId }]))
}

describe("isLiveSquadStatus", () => {
  it("counts planning and executing, and nothing else", () => {
    expect(isLiveSquadStatus("planning")).toBe(true)
    expect(isLiveSquadStatus("executing")).toBe(true)
    for (const quiet of ["idle", "paused", "completed", "failed", "cancelled"]) {
      expect(isLiveSquadStatus(quiet)).toBe(false)
    }
  })

  it("treats a missing status as not live rather than throwing", () => {
    expect(isLiveSquadStatus(undefined)).toBe(false)
  })

  it("exposes the set so a caller can pin the same vocabulary", () => {
    expect([...LIVE_SQUAD_STATUSES].sort()).toEqual(["executing", "planning"])
  })
})

describe("collectSquadPresence", () => {
  it("counts teammates per Squad", () => {
    const rows = collectSquadPresence({
      teams: teams(team({ id: "a" }), team({ id: "b" })),
      teammates: members("a", "a", "a", "b"),
    })
    expect(rows.find((r) => r.id === "a")?.memberCount).toBe(3)
    expect(rows.find((r) => r.id === "b")?.memberCount).toBe(1)
  })

  it("reports zero members for a Squad nobody joined", () => {
    const rows = collectSquadPresence({ teams: teams(team({ id: "a" })), teammates: {} })
    expect(rows[0]?.memberCount).toBe(0)
  })

  it("marks a Squad waiting only for an OPEN gate that names it", () => {
    const gates: SquadPresenceGate[] = [
      { teamId: "a", status: "open" },
      { teamId: "b", status: "interrupted" },
      { status: "open" },
    ]
    const rows = collectSquadPresence({
      teams: teams(team({ id: "a" }), team({ id: "b" })),
      teammates: {},
      gates,
    })
    expect(rows.find((r) => r.id === "a")?.waiting).toBe(true)
    // An interrupted gate is dismiss-only, so it is not something to answer.
    expect(rows.find((r) => r.id === "b")?.waiting).toBe(false)
  })

  it("puts what needs a human first, then what is running, then name order", () => {
    const rows = collectSquadPresence({
      teams: teams(
        team({ id: "aardvark", name: "Aardvark", status: "idle" }),
        team({ id: "beta", name: "Beta", status: "executing" }),
        team({ id: "zulu", name: "Zulu", status: "idle" }),
        team({ id: "yankee", name: "Yankee", status: "idle" })
      ),
      teammates: {},
      gates: [{ teamId: "zulu", status: "open" }],
    })
    expect(rows.map((r) => r.id)).toEqual(["zulu", "beta", "aardvark", "yankee"])
  })

  it("scopes to a workspace but keeps unstamped Squads, which are shared not foreign", () => {
    const rows = collectSquadPresence({
      teams: teams(
        team({ id: "mine", projectId: "w1" }),
        team({ id: "theirs", projectId: "w2" }),
        team({ id: "shared" })
      ),
      teammates: {},
      workspaceId: "w1",
    })
    expect(rows.map((r) => r.id).sort()).toEqual(["mine", "shared"])
  })

  it("skips the workspace filter entirely when no workspace is active", () => {
    const rows = collectSquadPresence({
      teams: teams(team({ id: "a", projectId: "w1" }), team({ id: "b", projectId: "w2" })),
      teammates: {},
      workspaceId: null,
    })
    expect(rows).toHaveLength(2)
  })

  it("omits description rather than emitting an undefined key", () => {
    const rows = collectSquadPresence({ teams: teams(team({ id: "a" })), teammates: {} })
    expect("description" in rows[0]!).toBe(false)
    const described = collectSquadPresence({
      teams: teams(team({ id: "a", description: "does things" })),
      teammates: {},
    })
    expect(described[0]?.description).toBe("does things")
  })

  it("returns an empty list for an empty store", () => {
    expect(collectSquadPresence({ teams: {}, teammates: {} })).toEqual([])
  })
})
