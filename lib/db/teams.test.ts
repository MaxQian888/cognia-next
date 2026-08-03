// Coverage for the teams CRUD layer + member management + supervisor
// validation.

import {
  TEAM_ORCHESTRATIONS,
  addMember,
  createTeam,
  deleteTeam,
  duplicateTeam,
  getTeam,
  listTeams,
  removeMember,
  reorderMembers,
  seedBuiltInTeams,
  updateMemberOverride,
  updateTeam,
} from "./teams"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
// Built-in characters power the built-in team seed; making sure they exist
// keeps `seedBuiltInTeams` consistent with what production runs.
import { seedBuiltInCharacters } from "./characters"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().teams.clear()
})
afterAll(dbFixture.dispose)

describe("TEAM_ORCHESTRATIONS", () => {
  it("exposes the four supported strategies in a stable order", () => {
    expect(TEAM_ORCHESTRATIONS).toEqual([
      "mention_round_robin",
      "round_robin",
      "manual",
      "supervisor",
    ])
  })
})

describe("createTeam", () => {
  it("inserts a row with sensible defaults", async () => {
    const team = await createTeam({
      name: "  Squad  ",
      members: [{ characterId: "c1" }],
    })
    expect(team.id).toMatch(/^team_/)
    expect(team.name).toBe("Squad")
    expect(team.orchestration).toBe("mention_round_robin")
    expect(team.avatarColor).toBe("oklch(0.7 0.15 200)")
    expect(team.members).toHaveLength(1)
  })

  it("falls back to 'Untitled team' on empty name", async () => {
    const team = await createTeam({
      name: "   ",
      members: [{ characterId: "c1" }],
    })
    expect(team.name).toBe("Untitled team")
  })

  it("rejects empty member list", async () => {
    await expect(createTeam({ name: "X", members: [] })).rejects.toThrow(/at least one member/)
  })

  it("validates supervisor mode requires a supervisor in the member list", async () => {
    await expect(
      createTeam({
        name: "X",
        members: [{ characterId: "c1" }],
        orchestration: "supervisor",
      })
    ).rejects.toThrow(/requires a designated supervisor/)
    await expect(
      createTeam({
        name: "X",
        members: [{ characterId: "c1" }],
        orchestration: "supervisor",
        supervisorCharacterId: "c2",
      })
    ).rejects.toThrow(/must be one of the team's members/)
  })

  it("creates valid supervisor team", async () => {
    const team = await createTeam({
      name: "X",
      members: [{ characterId: "c1" }, { characterId: "c2" }],
      orchestration: "supervisor",
      supervisorCharacterId: "c2",
    })
    expect(team.supervisorCharacterId).toBe("c2")
  })
})

describe("listTeams / getTeam", () => {
  it("listTeams orders by name", async () => {
    await createTeam({ name: "Charlie", members: [{ characterId: "c1" }] })
    await createTeam({ name: "Alpha", members: [{ characterId: "c1" }] })
    await createTeam({ name: "Bravo", members: [{ characterId: "c1" }] })
    const rows = await listTeams()
    expect(rows.map((t) => t.name)).toEqual(["Alpha", "Bravo", "Charlie"])
  })

  it("getTeam returns undefined for missing ids", async () => {
    expect(await getTeam("missing")).toBeUndefined()
  })
})

describe("updateTeam", () => {
  it("rejects empty members", async () => {
    const t = await createTeam({ name: "X", members: [{ characterId: "c1" }] })
    await expect(updateTeam(t.id, { members: [] })).rejects.toThrow(/at least one member/)
  })

  it("re-validates supervisor invariants on patch", async () => {
    const t = await createTeam({
      name: "X",
      members: [{ characterId: "c1" }, { characterId: "c2" }],
      orchestration: "supervisor",
      supervisorCharacterId: "c2",
    })
    // Drop the supervisor — must throw.
    await expect(updateTeam(t.id, { members: [{ characterId: "c1" }] })).rejects.toThrow(
      /must be one of the team's members/
    )
  })

  it("throws when team is missing", async () => {
    await expect(updateTeam("missing", { name: "x" })).rejects.toThrow(/not found/)
  })

  it("respects explicit supervisor=undefined patch", async () => {
    const t = await createTeam({
      name: "X",
      members: [{ characterId: "c1" }, { characterId: "c2" }],
      orchestration: "supervisor",
      supervisorCharacterId: "c2",
    })
    // Switch back to mention mode and clear supervisor.
    await updateTeam(t.id, {
      orchestration: "mention_round_robin",
      supervisorCharacterId: undefined,
    })
    const fresh = await getTeam(t.id)
    expect(fresh?.supervisorCharacterId).toBeUndefined()
  })
})

describe("deleteTeam", () => {
  it("removes a user team", async () => {
    const t = await createTeam({ name: "X", members: [{ characterId: "c1" }] })
    await deleteTeam(t.id)
    expect(await getTeam(t.id)).toBeUndefined()
  })

  it("rejects deletion of built-ins", async () => {
    await seedBuiltInCharacters()
    await seedBuiltInTeams()
    const builtIn = (await listTeams()).find((t) => t.isBuiltIn)!
    await expect(deleteTeam(builtIn.id)).rejects.toThrow(/Built-in/)
  })

  it("is a no-op for missing ids", async () => {
    await expect(deleteTeam("missing")).resolves.toBeUndefined()
  })
})

describe("duplicateTeam", () => {
  it("clones the row and resets isBuiltIn", async () => {
    await seedBuiltInCharacters()
    await seedBuiltInTeams()
    const builtIn = (await listTeams()).find((t) => t.isBuiltIn)!
    const copy = await duplicateTeam(builtIn.id)
    expect(copy.id).not.toBe(builtIn.id)
    expect(copy.name).toBe(`${builtIn.name} (copy)`)
    expect(copy.isBuiltIn).toBe(false)
    // Members are cloned (different array reference).
    expect(copy.members).not.toBe(builtIn.members)
    expect(copy.members.length).toBe(builtIn.members.length)
  })

  it("throws when source is missing", async () => {
    await expect(duplicateTeam("missing")).rejects.toThrow(/not found/)
  })
})

describe("addMember / removeMember", () => {
  it("addMember appends and is idempotent", async () => {
    const t = await createTeam({ name: "X", members: [{ characterId: "c1" }] })
    await addMember(t.id, "c2")
    const after1 = await getTeam(t.id)
    expect(after1?.members.map((m) => m.characterId)).toEqual(["c1", "c2"])
    await addMember(t.id, "c2") // already a member — no-op
    const after2 = await getTeam(t.id)
    expect(after2?.members.length).toBe(2)
  })

  it("addMember throws for missing team", async () => {
    await expect(addMember("missing", "c1")).rejects.toThrow(/not found/)
  })

  it("removeMember drops the member", async () => {
    const t = await createTeam({
      name: "X",
      members: [{ characterId: "c1" }, { characterId: "c2" }],
    })
    await removeMember(t.id, "c1")
    const after = await getTeam(t.id)
    expect(after?.members.map((m) => m.characterId)).toEqual(["c2"])
  })

  it("removeMember refuses to remove the last member", async () => {
    const t = await createTeam({ name: "X", members: [{ characterId: "c1" }] })
    await expect(removeMember(t.id, "c1")).rejects.toThrow(/last member/)
  })

  it("removeMember clears supervisor reference and falls back to mention mode", async () => {
    const t = await createTeam({
      name: "X",
      members: [{ characterId: "c1" }, { characterId: "c2" }],
      orchestration: "supervisor",
      supervisorCharacterId: "c2",
    })
    await removeMember(t.id, "c2")
    const after = await getTeam(t.id)
    expect(after?.supervisorCharacterId).toBeUndefined()
    expect(after?.orchestration).toBe("mention_round_robin")
  })

  it("removeMember preserves orchestration when supervisor was removed but orchestration is not 'supervisor'", async () => {
    const t = await createTeam({
      name: "X",
      members: [{ characterId: "c1" }, { characterId: "c2" }],
      orchestration: "manual",
      // supervisor field still permitted but unused
      supervisorCharacterId: "c2",
    })
    await removeMember(t.id, "c2")
    const after = await getTeam(t.id)
    expect(after?.supervisorCharacterId).toBeUndefined()
    expect(after?.orchestration).toBe("manual")
  })

  it("removeMember throws when team is missing", async () => {
    await expect(removeMember("missing", "c1")).rejects.toThrow(/not found/)
  })
})

describe("reorderMembers", () => {
  it("rejects empty ordered list", async () => {
    const t = await createTeam({ name: "X", members: [{ characterId: "c1" }] })
    await expect(reorderMembers(t.id, [])).rejects.toThrow(/at least one member/)
  })

  it("preserves member overrides for known ids and adds plain slots for unknown", async () => {
    const t = await createTeam({
      name: "X",
      members: [{ characterId: "c1", role: "Critic" }, { characterId: "c2" }],
    })
    await reorderMembers(t.id, ["c2", "c1", "c3"])
    const after = await getTeam(t.id)
    expect(after?.members[0]).toEqual({ characterId: "c2" })
    expect(after?.members[1].role).toBe("Critic")
    expect(after?.members[2]).toEqual({ characterId: "c3" })
  })

  it("throws when team is missing", async () => {
    await expect(reorderMembers("missing", ["c1"])).rejects.toThrow(/not found/)
  })
})

describe("updateMemberOverride", () => {
  it("patches a single member's override fields", async () => {
    const t = await createTeam({
      name: "X",
      members: [{ characterId: "c1" }, { characterId: "c2" }],
    })
    await updateMemberOverride(t.id, "c2", { role: "Reviewer", modelOverride: "claude-haiku" })
    const after = await getTeam(t.id)
    const c2 = after?.members.find((m) => m.characterId === "c2")
    expect(c2?.role).toBe("Reviewer")
    expect(c2?.modelOverride).toBe("claude-haiku")
  })

  it("is a no-op when the member id isn't in the team", async () => {
    const t = await createTeam({ name: "X", members: [{ characterId: "c1" }] })
    const before = await getTeam(t.id)
    await updateMemberOverride(t.id, "missing", { role: "Critic" })
    const after = await getTeam(t.id)
    expect(after?.updatedAt).toBe(before?.updatedAt)
  })

  it("throws when team is missing", async () => {
    await expect(updateMemberOverride("missing", "c1", { role: "x" })).rejects.toThrow(/not found/)
  })
})

describe("seedBuiltInTeams", () => {
  it("seeds every built-in with stable ids and the isBuiltIn flag", async () => {
    await seedBuiltInTeams()
    const built = (await listTeams()).filter((t) => t.isBuiltIn)
    const ids = built.map((t) => t.id).sort()
    expect(ids).toEqual([
      "team_builtin_brainstorm",
      "team_builtin_code_review_pair",
      "team_builtin_doc_polishers",
      "team_builtin_research_squad",
    ])
    expect(built.every((t) => t.isBuiltIn === true)).toBe(true)
  })

  it("re-seeding doesn't introduce duplicates", async () => {
    await seedBuiltInTeams()
    await seedBuiltInTeams()
    const built = (await listTeams()).filter((t) => t.isBuiltIn)
    expect(built.length).toBe(4)
  })

  it("supervisor-mode built-ins all reference a supervisor that is in the member list", async () => {
    await seedBuiltInTeams()
    const built = (await listTeams()).filter((t) => t.isBuiltIn)
    const supervisorTeams = built.filter((t) => t.orchestration === "supervisor")
    expect(supervisorTeams.length).toBeGreaterThan(0)
    for (const team of supervisorTeams) {
      expect(team.supervisorCharacterId).toBeDefined()
      expect(team.members.some((m) => m.characterId === team.supervisorCharacterId)).toBe(true)
    }
  })

  it("only references the 5 existing built-in character ids", async () => {
    await seedBuiltInTeams()
    const built = (await listTeams()).filter((t) => t.isBuiltIn)
    const allowedIds = new Set([
      "char_builtin_coding",
      "char_builtin_writer",
      "char_builtin_research",
      "char_builtin_brainstorm",
      "char_builtin_translator",
    ])
    for (const team of built) {
      for (const member of team.members) {
        expect(allowedIds.has(member.characterId)).toBe(true)
      }
    }
  })
})
