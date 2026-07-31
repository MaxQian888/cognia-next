/** @jest-environment jsdom */
/**
 * Coverage for the per-item CRUD + pin helpers added on top of the existing
 * append/upsert API. The full table-level smoke (cascade delete, multi-twin
 * isolation, etc.) lives in `twin-tables.test.ts` — this file only exercises
 * the Persona-browser-facing surface added by ADR-0003 follow-up.
 */

import "fake-indexeddb/auto"
import {
  addEntity,
  addPlaybook,
  addStyleSample,
  appendDecisions,
  appendPlaybooks,
  appendStyleSamples,
  ensureTwinProfile,
  getTwinProfile,
  removeEntity,
  removePlaybook,
  removeStyleSample,
  setEntityPinned,
  setPlaybookPinned,
  setStyleSamplePinned,
  updateEntity,
  updatePlaybook,
  updateStyleSample,
  upsertEntities,
  upsertPlaybooks,
  upsertStyleSamples,
} from "./twin-profile"
import type { Playbook, ProfileEntity, StyleSample } from "@/types/twin"

const TWIN_ID = "twin-test"

function makeEntity(name: string, overrides: Partial<ProfileEntity> = {}): ProfileEntity {
  return {
    name,
    aliases: [],
    role: "person",
    firstSeenChunkId: "chunk-1",
    ...overrides,
  }
}

function makePlaybook(id: string, overrides: Partial<Playbook> = {}): Playbook {
  return {
    id,
    title: `Playbook ${id}`,
    trigger: "trigger",
    steps: [{ order: 1, action: "do thing" }],
    examples: [],
    confidence: 0.5,
    ...overrides,
  }
}

function makeStyleSample(id: string, overrides: Partial<StyleSample> = {}): StyleSample {
  return {
    id,
    contextLabel: `ctx ${id}`,
    original: "original text",
    summary: "summary text",
    sourceChunkId: "chunk-1",
    tone: [],
    addedAt: 1000,
    addedBy: "distill",
    ...overrides,
  }
}

beforeEach(async () => {
  // Wipe the fake-IndexedDB profile row between tests so they stay isolated.
  const profile = await getTwinProfile(TWIN_ID)
  if (profile) {
    const { deleteTwinProfile } = await import("./twin-profile")
    await deleteTwinProfile(TWIN_ID)
  }
})

describe("entity helpers", () => {
  it("addEntity appends and is idempotent on duplicate names", async () => {
    await addEntity(TWIN_ID, makeEntity("Sarah Chen"))
    const dup = await addEntity(TWIN_ID, makeEntity("sarah chen", { relation: "colleague" }))
    expect(dup.entities).toHaveLength(1)
    expect(dup.entities[0].relation).toBe("colleague")
  })

  it("updateEntity replaces by case-insensitive name", async () => {
    await upsertEntities(TWIN_ID, [makeEntity("Bob")])
    const updated = await updateEntity(TWIN_ID, "bob", makeEntity("Bob", { role: "team" }))
    expect(updated.entities[0].role).toBe("team")
  })

  it("updateEntity appends when no match exists", async () => {
    const updated = await updateEntity(TWIN_ID, "missing", makeEntity("New"))
    expect(updated.entities.map((e) => e.name)).toEqual(["New"])
  })

  it("removeEntity drops the matching row and is a no-op otherwise", async () => {
    await upsertEntities(TWIN_ID, [makeEntity("Alice"), makeEntity("Bob")])
    const after = await removeEntity(TWIN_ID, "ALICE")
    expect(after.entities.map((e) => e.name)).toEqual(["Bob"])
    const noop = await removeEntity(TWIN_ID, "ghost")
    expect(noop.entities).toEqual(after.entities)
  })

  it("setEntityPinned toggles the flag and bumps updatedAt only when it changes", async () => {
    await upsertEntities(TWIN_ID, [makeEntity("Alice")])
    const before = await ensureTwinProfile(TWIN_ID)
    const pinned = await setEntityPinned(TWIN_ID, "alice", true)
    expect(pinned.entities[0].pinned).toBe(true)
    expect(pinned.updatedAt).toBeGreaterThanOrEqual(before.updatedAt)
    const samePin = await setEntityPinned(TWIN_ID, "alice", true)
    expect(samePin.updatedAt).toBe(pinned.updatedAt)
  })
})

describe("playbook helpers", () => {
  it("addPlaybook appends and replaces existing id", async () => {
    await addPlaybook(TWIN_ID, makePlaybook("p1"))
    const replaced = await addPlaybook(TWIN_ID, makePlaybook("p1", { title: "Renamed" }))
    expect(replaced.playbooks).toHaveLength(1)
    expect(replaced.playbooks[0].title).toBe("Renamed")
  })

  it("updatePlaybook replaces by id and appends when missing", async () => {
    await appendPlaybooks(TWIN_ID, [makePlaybook("p1")])
    const updated = await updatePlaybook(TWIN_ID, "p1", makePlaybook("p1", { confidence: 0.9 }))
    expect(updated.playbooks[0].confidence).toBe(0.9)
    const appended = await updatePlaybook(TWIN_ID, "p-missing", makePlaybook("p2"))
    expect(appended.playbooks.map((p) => p.id)).toEqual(["p1", "p2"])
  })

  it("removePlaybook drops by id and is a no-op when missing", async () => {
    await appendPlaybooks(TWIN_ID, [makePlaybook("p1"), makePlaybook("p2")])
    const after = await removePlaybook(TWIN_ID, "p1")
    expect(after.playbooks.map((p) => p.id)).toEqual(["p2"])
    const noop = await removePlaybook(TWIN_ID, "ghost")
    expect(noop.playbooks).toEqual(after.playbooks)
  })

  it("setPlaybookPinned toggles per id", async () => {
    await appendPlaybooks(TWIN_ID, [makePlaybook("p1"), makePlaybook("p2")])
    const after = await setPlaybookPinned(TWIN_ID, "p2", true)
    expect(after.playbooks.find((p) => p.id === "p2")?.pinned).toBe(true)
    expect(after.playbooks.find((p) => p.id === "p1")?.pinned).toBeUndefined()
  })
})

describe("styleSample helpers", () => {
  it("addStyleSample appends and replaces by id", async () => {
    await addStyleSample(TWIN_ID, makeStyleSample("s1"))
    const replaced = await addStyleSample(
      TWIN_ID,
      makeStyleSample("s1", { summary: "new summary" })
    )
    expect(replaced.styleSamples).toHaveLength(1)
    expect(replaced.styleSamples[0].summary).toBe("new summary")
  })

  it("updateStyleSample replaces by id", async () => {
    await appendStyleSamples(TWIN_ID, [makeStyleSample("s1")])
    const updated = await updateStyleSample(
      TWIN_ID,
      "s1",
      makeStyleSample("s1", { tone: ["formal"] })
    )
    expect(updated.styleSamples[0].tone).toEqual(["formal"])
  })

  it("removeStyleSample drops by id", async () => {
    await appendStyleSamples(TWIN_ID, [makeStyleSample("s1"), makeStyleSample("s2")])
    const after = await removeStyleSample(TWIN_ID, "s1")
    expect(after.styleSamples.map((s) => s.id)).toEqual(["s2"])
  })

  it("setStyleSamplePinned toggles per id", async () => {
    await appendStyleSamples(TWIN_ID, [makeStyleSample("s1")])
    const after = await setStyleSamplePinned(TWIN_ID, "s1", true)
    expect(after.styleSamples[0].pinned).toBe(true)
  })
})

describe("upsertEntities honors pinned", () => {
  it("preserves a pinned existing entity when distill submits the same name", async () => {
    await upsertEntities(TWIN_ID, [makeEntity("Alice", { relation: "manual" })])
    await setEntityPinned(TWIN_ID, "Alice", true)
    await upsertEntities(TWIN_ID, [
      makeEntity("Alice", { relation: "distill", aliases: ["alicia"] }),
    ])
    const profile = await getTwinProfile(TWIN_ID)
    const alice = profile?.entities.find((e) => e.name === "Alice")
    expect(alice?.relation).toBe("manual")
    expect(alice?.pinned).toBe(true)
    expect(alice?.aliases).toEqual([])
  })

  it("still overwrites a non-pinned existing entity", async () => {
    await upsertEntities(TWIN_ID, [makeEntity("Bob", { relation: "old" })])
    await upsertEntities(TWIN_ID, [makeEntity("Bob", { relation: "new" })])
    const profile = await getTwinProfile(TWIN_ID)
    expect(profile?.entities.find((e) => e.name === "Bob")?.relation).toBe("new")
  })

  it("keeps same-name entities with different roles distinct (T2.5)", async () => {
    await upsertEntities(TWIN_ID, [
      makeEntity("Phoenix", { role: "person" }),
      makeEntity("Phoenix", { role: "project" }),
    ])
    const profile = await getTwinProfile(TWIN_ID)
    const phoenixes = profile?.entities.filter((e) => e.name === "Phoenix") ?? []
    expect(phoenixes).toHaveLength(2)
    expect(phoenixes.map((e) => e.role).sort()).toEqual(["person", "project"])
  })
})

describe("upsertStyleSamples / upsertPlaybooks — re-distill safety (T1.2)", () => {
  it("de-dupes style samples by content key across repeated distills", async () => {
    await upsertStyleSamples(TWIN_ID, [
      makeStyleSample("s1", { summary: "tone A", sourceChunkId: "c1" }),
    ])
    const again = await upsertStyleSamples(TWIN_ID, [
      makeStyleSample("s2", { summary: "tone A", sourceChunkId: "c1" }),
    ])
    // Same sourceChunkId + summary → one row, refreshed (not duplicated).
    expect(again.styleSamples).toHaveLength(1)
  })

  it("preserves a pinned style sample, dropping the incoming distill duplicate", async () => {
    await upsertStyleSamples(TWIN_ID, [
      makeStyleSample("s1", { summary: "X", sourceChunkId: "c1" }),
    ])
    await setStyleSamplePinned(TWIN_ID, "s1", true)
    const after = await upsertStyleSamples(TWIN_ID, [
      makeStyleSample("s2", { summary: "X", sourceChunkId: "c1" }),
    ])
    expect(after.styleSamples).toHaveLength(1)
    expect(after.styleSamples[0].id).toBe("s1")
    expect(after.styleSamples[0].pinned).toBe(true)
  })

  it("adds genuinely new style content and populates embeddings via embeddingFn", async () => {
    const after = await upsertStyleSamples(
      TWIN_ID,
      [
        makeStyleSample("s1", { summary: "A", sourceChunkId: "c1" }),
        makeStyleSample("s2", { summary: "B", sourceChunkId: "c1" }),
      ],
      { embeddingFn: async () => [0.1, 0.2, 0.3] }
    )
    expect(after.styleSamples).toHaveLength(2)
    expect(after.styleSamples.every((s) => s.embedding?.length === 3)).toBe(true)
  })

  it("de-dupes playbooks by title+trigger and preserves pinned", async () => {
    await upsertPlaybooks(TWIN_ID, [
      makePlaybook("p1", { title: "Handle refund", trigger: "refund asked" }),
    ])
    const dup = await upsertPlaybooks(TWIN_ID, [
      makePlaybook("p2", { title: "Handle refund", trigger: "refund asked" }),
    ])
    expect(dup.playbooks).toHaveLength(1)

    await setPlaybookPinned(TWIN_ID, dup.playbooks[0].id, true)
    const pinnedId = dup.playbooks[0].id
    const after = await upsertPlaybooks(TWIN_ID, [
      makePlaybook("p3", { title: "Handle refund", trigger: "refund asked", confidence: 0.99 }),
    ])
    expect(after.playbooks).toHaveLength(1)
    expect(after.playbooks[0].id).toBe(pinnedId)
    expect(after.playbooks[0].pinned).toBe(true)
  })
})

describe("decisions stay untouched by the new API", () => {
  it("only the four target arrays are mutated", async () => {
    await appendDecisions(TWIN_ID, [
      {
        id: "d1",
        context: "ctx",
        choice: "choice",
        rationale: "why",
        sourceChunkIds: [],
      },
    ])
    await addEntity(TWIN_ID, makeEntity("Alice"))
    const profile = await getTwinProfile(TWIN_ID)
    expect(profile?.decisions).toHaveLength(1)
    expect(profile?.entities).toHaveLength(1)
  })
})
