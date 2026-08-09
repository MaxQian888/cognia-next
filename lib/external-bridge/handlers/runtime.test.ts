/**
 * Coverage for the `runtime_query` MCP handler. Drives Dexie via
 * fake-indexeddb against the seeded built-ins so the tests exercise real
 * row shapes instead of a parallel mock.
 */

import { runtimeQuery } from "./runtime"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { listSkills } from "@/lib/db/skills"
import { listCharacters } from "@/lib/db/characters"
import { listTeams } from "@/lib/db/teams"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
}, 30_000)

afterAll(dbFixture.dispose)

describe("runtimeQuery — list", () => {
  it("lists seeded skills with name + meta", async () => {
    const out = await runtimeQuery({ entityType: "skill", op: "list" })
    expect(out.op).toBe("list")
    if (out.op !== "list") return
    const skillRows = await listSkills()
    expect(out.entries).toHaveLength(skillRows.length)
    if (out.entries.length > 0) {
      expect(out.entries[0]).toHaveProperty("id")
      expect(out.entries[0]).toHaveProperty("name")
      expect(out.entries[0].meta).toHaveProperty("isBuiltIn")
    }
  })

  it("lists seeded characters", async () => {
    const out = await runtimeQuery({ entityType: "character", op: "list" })
    if (out.op !== "list") throw new Error("expected list op")
    const characters = await listCharacters()
    expect(out.entries).toHaveLength(characters.length)
  })

  it("lists seeded agent-teams", async () => {
    const out = await runtimeQuery({ entityType: "agent-team", op: "list" })
    if (out.op !== "list") throw new Error("expected list op")
    const teams = await listTeams()
    expect(out.entries).toHaveLength(teams.length)
    if (out.entries.length > 0) {
      expect(out.entries[0].meta).toHaveProperty("memberCount")
    }
  })

  it("lists plugins (empty by default — no built-ins)", async () => {
    const out = await runtimeQuery({ entityType: "plugin", op: "list" })
    if (out.op !== "list") throw new Error("expected list op")
    expect(Array.isArray(out.entries)).toBe(true)
  })

  it("lists twins via character.twinId values", async () => {
    const out = await runtimeQuery({ entityType: "twin", op: "list" })
    if (out.op !== "list") throw new Error("expected list op")
    expect(Array.isArray(out.entries)).toBe(true)
  })
})

describe("runtimeQuery — get", () => {
  it("returns undefined when id is missing", async () => {
    const out = await runtimeQuery({ entityType: "skill", op: "get", id: "" })
    if (out.op !== "get") throw new Error("expected get op")
    expect(out.entity).toBeUndefined()
  })

  it("returns undefined when id is whitespace", async () => {
    const out = await runtimeQuery({ entityType: "skill", op: "get", id: "   " })
    if (out.op !== "get") throw new Error("expected get op")
    expect(out.entity).toBeUndefined()
  })

  it("returns undefined for unknown skill id", async () => {
    const out = await runtimeQuery({ entityType: "skill", op: "get", id: "nope" })
    if (out.op !== "get") throw new Error("expected get op")
    expect(out.entity).toBeUndefined()
  })

  it("returns the row for a known skill id", async () => {
    const skills = await listSkills()
    if (skills.length === 0) return
    const target = skills[0]
    const out = await runtimeQuery({ entityType: "skill", op: "get", id: target.id })
    if (out.op !== "get") throw new Error("expected get op")
    expect(out.entity).toBeDefined()
    expect(out.entity?.id).toBe(target.id)
  })

  it("returns the row for a known character id", async () => {
    const characters = await listCharacters()
    if (characters.length === 0) return
    const target = characters[0]
    const out = await runtimeQuery({ entityType: "character", op: "get", id: target.id })
    if (out.op !== "get") throw new Error("expected get op")
    expect(out.entity?.id).toBe(target.id)
  })

  it("returns the row for a known team id", async () => {
    const teams = await listTeams()
    if (teams.length === 0) return
    const target = teams[0]
    const out = await runtimeQuery({ entityType: "agent-team", op: "get", id: target.id })
    if (out.op !== "get") throw new Error("expected get op")
    expect(out.entity?.id).toBe(target.id)
  })

  it("returns plugin row when present (test inserts one)", async () => {
    const now = Date.now()
    await getDb().plugins.put({
      id: "p_test",
      name: "Test Plugin",
      version: "1.0.0",
      status: "enabled",
      source: "builtin",
      type: "frontend",
      enabled: true,
      capabilities: [],
      path: "<builtin>/p_test",
      manifest: { id: "p_test", name: "Test Plugin", version: "1.0.0" },
      createdAt: now,
      updatedAt: now,
    })
    const out = await runtimeQuery({ entityType: "plugin", op: "get", id: "p_test" })
    if (out.op !== "get") throw new Error("expected get op")
    expect(out.entity?.name).toBe("Test Plugin")
  })

  it("returns undefined for unknown plugin id", async () => {
    const out = await runtimeQuery({ entityType: "plugin", op: "get", id: "ghost" })
    if (out.op !== "get") throw new Error("expected get op")
    expect(out.entity).toBeUndefined()
  })

  it("returns aggregated twin info when twinSources rows exist", async () => {
    const now = Date.now()
    await getDb().twinSources.add({
      id: "twin_test_src",
      twinId: "twin_test",
      kind: "code",
      format: "code",
      source: "manual",
      title: "src",
      bytes: 100,
      fingerprint: "f",
      chunkCount: 1,
      status: "parsed",
      importedAt: now,
      redacted: false,
    })
    const out = await runtimeQuery({ entityType: "twin", op: "get", id: "twin_test" })
    if (out.op !== "get") throw new Error("expected get op")
    expect(out.entity?.twinId).toBe("twin_test")
    expect(out.entity?.sourceCount).toBe(1)
  })

  it("returns undefined for an unknown twin", async () => {
    const out = await runtimeQuery({ entityType: "twin", op: "get", id: "ghost_twin" })
    if (out.op !== "get") throw new Error("expected get op")
    expect(out.entity).toBeUndefined()
  })
})
