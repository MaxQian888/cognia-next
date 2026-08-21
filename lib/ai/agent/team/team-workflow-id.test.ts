import {
  TEAM_WORKFLOW_ID_PREFIX,
  buildTeamWorkflowId,
  isTeamWorkflowId,
  parseTeamWorkflowId,
  teamWorkflowIdPrefix,
} from "./team-workflow-id"

describe("team-workflow-id", () => {
  // The literal is pinned here on purpose: `workflowRuns` rows written by older
  // builds carry this exact prefix, so renaming it is a data migration, not a
  // refactor. This assertion is what makes such a rename break loudly.
  it("pins the on-disk prefix literal", () => {
    expect(TEAM_WORKFLOW_ID_PREFIX).toBe("__team__:")
  })

  it("builds `__team__:<teamId>:<nonce>`", () => {
    const id = buildTeamWorkflowId("team-1")
    expect(id).toMatch(/^__team__:team-1:[A-Za-z0-9_-]{8}$/)
  })

  it("gives each run of one team a distinct id", () => {
    expect(buildTeamWorkflowId("team-1")).not.toBe(buildTeamWorkflowId("team-1"))
  })

  it("round-trips a built id back to its team", () => {
    const id = buildTeamWorkflowId("team-1")
    const parsed = parseTeamWorkflowId(id)
    expect(parsed?.teamId).toBe("team-1")
    expect(parsed?.nonce).toHaveLength(8)
  })

  it("builds a lookup prefix that every run of the team starts with", () => {
    const prefix = teamWorkflowIdPrefix("team-1")
    expect(prefix).toBe("__team__:team-1:")
    expect(buildTeamWorkflowId("team-1").startsWith(prefix)).toBe(true)
  })

  // The trailing `:` is load-bearing — without it the Dexie `startsWith` query
  // in `useTeamLiveStatus` would report `team-10`'s runs as `team-1`'s.
  it("does not let one team's prefix match another whose id extends it", () => {
    expect(buildTeamWorkflowId("team-10").startsWith(teamWorkflowIdPrefix("team-1"))).toBe(false)
  })

  describe("isTeamWorkflowId", () => {
    it("accepts a synthesized team id", () => {
      expect(isTeamWorkflowId(buildTeamWorkflowId("team-1"))).toBe(true)
    })

    it("rejects a plain workflow id", () => {
      expect(isTeamWorkflowId("wf_abc123")).toBe(false)
      expect(isTeamWorkflowId("")).toBe(false)
    })
  })

  describe("parseTeamWorkflowId", () => {
    it("returns null for a non-team id", () => {
      expect(parseTeamWorkflowId("wf_abc123")).toBeNull()
    })

    it("returns null when the team segment is empty", () => {
      expect(parseTeamWorkflowId("__team__:")).toBeNull()
      expect(parseTeamWorkflowId("__team__::nonce")).toBeNull()
    })

    it("tolerates a legacy id with no nonce segment", () => {
      expect(parseTeamWorkflowId("__team__:team-1")).toEqual({ teamId: "team-1", nonce: "" })
    })

    it("splits on the first separator so a nonce cannot bleed into the team id", () => {
      expect(parseTeamWorkflowId("__team__:team-1:a:b")).toEqual({
        teamId: "team-1",
        nonce: "a:b",
      })
    })
  })
})
