import "fake-indexeddb/auto"
import type { Memory } from "@/types/memory/memory"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import {
  clearMemories,
  countActive,
  createMemory,
  getMemoriesByVectorDocIds,
  getMemory,
  hardDeleteMemories,
  hardDeleteMemory,
  invalidateMemory,
  listActiveForReader,
  listActiveProcedural,
  listMemories,
  setMemoriesPinned,
  setMemoryPinned,
  touchMemories,
  updateMemory,
  type MemoryCreateInput,
} from "./memories"

function buildInput(overrides: Partial<MemoryCreateInput> = {}): MemoryCreateInput {
  return {
    scope: "global",
    type: "semantic",
    text: "The user prefers pnpm",
    tags: [],
    importance: 5,
    pinned: false,
    provenance: "user",
    ...overrides,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("memories CRUD", () => {
  it("createMemory stamps defaults and timestamps", async () => {
    const before = Date.now()
    const row = await createMemory(buildInput({ id: "m1" }))
    const after = Date.now()
    expect(row.id).toBe("m1")
    expect(row.status).toBe("active")
    expect(row.version).toBe(1)
    expect(row.accessCount).toBe(0)
    expect(row.createdAt).toBeGreaterThanOrEqual(before)
    expect(row.createdAt).toBeLessThanOrEqual(after)
    expect(row.updatedAt).toBe(row.createdAt)
    expect(row.lastAccessedAt).toBe(row.createdAt)
  })

  it("createMemory generates an id when none is supplied", async () => {
    const row = await createMemory(buildInput())
    expect(row.id).toMatch(/^mem_\d+_[a-z0-9]+$/)
  })

  it("createMemory defaults tags and pinned when omitted", async () => {
    const row = await createMemory({
      scope: "global",
      type: "semantic",
      text: "x",
      importance: 1,
      provenance: "user",
    } as MemoryCreateInput)
    expect(row.tags).toEqual([])
    expect(row.pinned).toBe(false)
  })

  it("getMemory round-trips", async () => {
    await createMemory(buildInput({ id: "m1" }))
    const got = await getMemory("m1")
    expect(got?.text).toBe("The user prefers pnpm")
    expect(await getMemory("missing")).toBeUndefined()
  })

  it("updateMemory bumps updatedAt and applies the patch", async () => {
    const row = await createMemory(buildInput({ id: "m1" }))
    await new Promise((r) => setTimeout(r, 2))
    await updateMemory("m1", { text: "changed", tags: ["t"] })
    const got = await getMemory("m1")
    expect(got?.text).toBe("changed")
    expect(got?.tags).toEqual(["t"])
    expect(got?.updatedAt).toBeGreaterThan(row.updatedAt)
    expect(got?.version).toBe(1) // not bumped without bumpVersion
  })

  it("updateMemory bumps version when bumpVersion is set", async () => {
    await createMemory(buildInput({ id: "m1" }))
    await updateMemory("m1", { text: "v2", bumpVersion: true })
    expect((await getMemory("m1"))?.version).toBe(2)
    await updateMemory("m1", { text: "v3", bumpVersion: true })
    expect((await getMemory("m1"))?.version).toBe(3)
  })

  it("invalidateMemory soft-deletes and preserves the row", async () => {
    await createMemory(buildInput({ id: "m1" }))
    await invalidateMemory("m1", "m2")
    const got = await getMemory("m1")
    expect(got?.status).toBe("invalidated")
    expect(got?.invalidatedAt).toBeGreaterThan(0)
    expect(got?.supersededById).toBe("m2")
  })

  it("invalidateMemory without supersededById leaves it unset", async () => {
    await createMemory(buildInput({ id: "m1" }))
    await invalidateMemory("m1")
    expect((await getMemory("m1"))?.supersededById).toBeUndefined()
  })
})

describe("touch / pin", () => {
  it("touchMemories bumps lastAccessedAt and accessCount", async () => {
    const row = await createMemory(buildInput({ id: "m1" }))
    await new Promise((r) => setTimeout(r, 2))
    await touchMemories(["m1", "missing"])
    const got = await getMemory("m1")
    expect(got?.accessCount).toBe(1)
    expect(got?.lastAccessedAt).toBeGreaterThan(row.lastAccessedAt)
  })

  it("touchMemories is a no-op on empty input", async () => {
    await expect(touchMemories([])).resolves.toBeUndefined()
  })

  it("setMemoryPinned toggles pinned", async () => {
    await createMemory(buildInput({ id: "m1" }))
    await setMemoryPinned("m1", true)
    expect((await getMemory("m1"))?.pinned).toBe(true)
    await setMemoryPinned("m1", false)
    expect((await getMemory("m1"))?.pinned).toBe(false)
  })
})

describe("listing & scope-union", () => {
  async function seed() {
    await createMemory(buildInput({ id: "g1", scope: "global", type: "semantic" }))
    await createMemory(buildInput({ id: "g2", scope: "global", type: "procedural" }))
    await createMemory(
      buildInput({ id: "cA", scope: "character", characterId: "charA", type: "semantic" })
    )
    await createMemory(
      buildInput({ id: "cB", scope: "character", characterId: "charB", type: "semantic" })
    )
    await invalidateMemory("g2")
  }

  it("listMemories filters by scope/type/status and sorts newest-first", async () => {
    await seed()
    const globals = await listMemories({ scope: "global" })
    expect(globals.map((m) => m.id).sort()).toEqual(["g1", "g2"])
    const active = await listMemories({ status: "active" })
    expect(active.find((m) => m.id === "g2")).toBeUndefined()
    const proc = await listMemories({ type: "procedural" })
    expect(proc.map((m) => m.id)).toEqual(["g2"])
    const charA = await listMemories({ scope: "character", characterId: "charA" })
    expect(charA.map((m) => m.id)).toEqual(["cA"])
  })

  it("listActiveForReader unions global with the character's own override layer", async () => {
    await seed()
    const forA = await listActiveForReader("charA")
    expect(forA.map((m) => m.id).sort()).toEqual(["cA", "g1"]) // g2 invalidated, cB other char
    const noChar = await listActiveForReader()
    expect(noChar.map((m) => m.id)).toEqual(["g1"])
  })

  it("listActiveProcedural returns only active procedural for the reader", async () => {
    await createMemory(buildInput({ id: "p1", type: "procedural" }))
    await createMemory(buildInput({ id: "s1", type: "semantic" }))
    const proc = await listActiveProcedural()
    expect(proc.map((m) => m.id)).toEqual(["p1"])
  })

  it("countActive counts per scope and character", async () => {
    await seed()
    expect(await countActive("global")).toBe(1) // g2 invalidated
    expect(await countActive("character", "charA")).toBe(1)
    expect(await countActive("character")).toBe(2) // both chars
  })

  it("getMemoriesByVectorDocIds maps doc ids to rows", async () => {
    await createMemory(buildInput({ id: "m1", vectorDocId: "v1" }))
    await createMemory(buildInput({ id: "m2", vectorDocId: "v2" }))
    const rows = await getMemoriesByVectorDocIds(["v1", "v2", "vX"])
    expect(rows.map((m) => m.id).sort()).toEqual(["m1", "m2"])
    expect(await getMemoriesByVectorDocIds([])).toEqual([])
  })
})

describe("delete & clear", () => {
  it("hardDeleteMemory removes a row entirely", async () => {
    await createMemory(buildInput({ id: "m1" }))
    await hardDeleteMemory("m1")
    expect(await getMemory("m1")).toBeUndefined()
  })

  it("clearMemories deletes matching rows and returns the count", async () => {
    await createMemory(buildInput({ id: "g1", scope: "global" }))
    await createMemory(buildInput({ id: "cA", scope: "character", characterId: "charA" }))
    const cleared = await clearMemories({ scope: "global" })
    expect(cleared).toBe(1)
    expect(await getMemory("g1")).toBeUndefined()
    expect(await getMemory("cA")).toBeDefined()
  })

  it("clearMemories returns 0 when nothing matches", async () => {
    expect(await clearMemories({ scope: "global" })).toBe(0)
  })

  it("clearMemories with no query clears everything", async () => {
    await createMemory(buildInput({ id: "g1" }))
    await createMemory(buildInput({ id: "g2" }))
    expect(await clearMemories()).toBe(2)
    expect((await listMemories()).length).toBe(0)
  })

  it("hardDeleteMemories removes the listed rows and returns the count", async () => {
    await createMemory(buildInput({ id: "a" }))
    await createMemory(buildInput({ id: "b" }))
    await createMemory(buildInput({ id: "c" }))
    expect(await hardDeleteMemories(["a", "c"])).toBe(2)
    expect(await getMemory("a")).toBeUndefined()
    expect(await getMemory("b")).toBeDefined()
    expect(await getMemory("c")).toBeUndefined()
  })

  it("hardDeleteMemories is a no-op on empty input", async () => {
    expect(await hardDeleteMemories([])).toBe(0)
  })

  it("setMemoriesPinned pins/unpins the listed rows in one pass", async () => {
    await createMemory(buildInput({ id: "a", pinned: false }))
    await createMemory(buildInput({ id: "b", pinned: false }))
    await setMemoriesPinned(["a", "b"], true)
    expect((await getMemory("a"))?.pinned).toBe(true)
    expect((await getMemory("b"))?.pinned).toBe(true)
    await setMemoriesPinned(["a"], false)
    expect((await getMemory("a"))?.pinned).toBe(false)
    expect((await getMemory("b"))?.pinned).toBe(true)
  })

  it("setMemoriesPinned is a no-op on empty input", async () => {
    await expect(setMemoriesPinned([], true)).resolves.toBeUndefined()
  })
})

// Belt-and-suspenders: the row shape the table stores matches the Memory type.
it("stored row satisfies the Memory contract", async () => {
  const row = await createMemory(buildInput({ id: "m1" }))
  const typed: Memory = row
  expect(typed.id).toBe("m1")
})
