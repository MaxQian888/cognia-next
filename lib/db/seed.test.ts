// Coverage for the first-run seeder — verifies that all four seed surfaces
// (characters, skills, presets, teams) are populated after one call, and
// that re-invoking is idempotent.

import "fake-indexeddb/auto"
import { seedBuiltIns } from "./seed"
import { __resetDbForTesting, getDb } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
})

describe("seedBuiltIns", () => {
  it("populates every built-in surface", async () => {
    await seedBuiltIns()
    const db = getDb()
    const characters = (await db.characters.toArray()).filter((c) => c.isBuiltIn)
    const skills = (await db.skills.toArray()).filter((s) => s.isBuiltIn)
    const presets = (await db.promptPresets.toArray()).filter((p) => p.isBuiltIn)
    const teams = (await db.teams.toArray()).filter((t) => t.isBuiltIn)
    expect(characters.length).toBeGreaterThanOrEqual(5)
    expect(skills.length).toBeGreaterThanOrEqual(5)
    expect(presets.length).toBeGreaterThanOrEqual(12)
    expect(teams.length).toBeGreaterThanOrEqual(1)
  })

  it("re-running is idempotent (no duplicates)", async () => {
    await seedBuiltIns()
    await seedBuiltIns()
    const db = getDb()
    const presets = (await db.promptPresets.toArray()).filter((p) => p.isBuiltIn)
    const characters = (await db.characters.toArray()).filter((c) => c.isBuiltIn)
    const teams = (await db.teams.toArray()).filter((t) => t.isBuiltIn)
    // Each builtin id is unique — repeat seeds upsert in place.
    expect(new Set(presets.map((p) => p.id)).size).toBe(presets.length)
    expect(new Set(characters.map((c) => c.id)).size).toBe(characters.length)
    expect(new Set(teams.map((t) => t.id)).size).toBe(teams.length)
  })

  it("teams seed references existing built-in characters", async () => {
    await seedBuiltIns()
    const db = getDb()
    const teams = (await db.teams.toArray()).filter((t) => t.isBuiltIn)
    const characterIds = new Set((await db.characters.toArray()).map((c) => c.id))
    for (const team of teams) {
      for (const member of team.members) {
        expect(characterIds.has(member.characterId)).toBe(true)
      }
    }
  })
})
