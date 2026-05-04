/**
 * Coverage for `lib/db/wiki-manifest.ts` — per-scope manifest CRUD plus the
 * pure `diffManifest` function (Merkle-driven incremental refresh).
 */

import "fake-indexeddb/auto"
import {
  deleteWikiManifest,
  diffManifest,
  getWikiManifest,
  listAllWikiManifests,
  upsertWikiManifest,
} from "./wiki-manifest"
import type { WikiManifest } from "@/types/wiki"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function makeManifest(overrides: Partial<WikiManifest> = {}): WikiManifest {
  return {
    scope: overrides.scope ?? "cognia-self",
    fileHashes: overrides.fileHashes ?? { "lib/foo.ts": "abc" },
    lastBuildAt: overrides.lastBuildAt ?? Date.now(),
    articleCount: overrides.articleCount ?? 5,
    generatorVersion: overrides.generatorVersion ?? "v1",
  }
}

describe("wiki-manifest CRUD", () => {
  it("upsertWikiManifest writes and getWikiManifest reads back", async () => {
    const written = await upsertWikiManifest(makeManifest())
    const fetched = await getWikiManifest("cognia-self")
    expect(fetched).toEqual(written)
  })

  it("upsertWikiManifest replaces an existing scope's row", async () => {
    await upsertWikiManifest(makeManifest({ articleCount: 1 }))
    await upsertWikiManifest(makeManifest({ articleCount: 99 }))
    const fetched = await getWikiManifest("cognia-self")
    expect(fetched?.articleCount).toBe(99)
  })

  it("getWikiManifest returns undefined for an unseen scope", async () => {
    expect(await getWikiManifest("user-repo")).toBeUndefined()
  })

  it("deleteWikiManifest clears the scope row", async () => {
    await upsertWikiManifest(makeManifest())
    await deleteWikiManifest("cognia-self")
    expect(await getWikiManifest("cognia-self")).toBeUndefined()
  })

  it("listAllWikiManifests spans all scopes", async () => {
    await upsertWikiManifest(makeManifest({ scope: "cognia-self" }))
    await upsertWikiManifest(makeManifest({ scope: "user-repo" }))
    const all = await listAllWikiManifests()
    expect(all.map((m) => m.scope).sort()).toEqual(["cognia-self", "user-repo"])
  })
})

describe("diffManifest", () => {
  it("treats undefined manifest as everything-added", () => {
    const current = { "a.ts": "h1", "b.ts": "h2" }
    const result = diffManifest(undefined, current)
    expect(result).toEqual({
      added: ["a.ts", "b.ts"],
      changed: [],
      removed: [],
      unchanged: [],
    })
  })

  it("classifies added / changed / removed / unchanged correctly", () => {
    const previous = makeManifest({
      fileHashes: { "same.ts": "h1", "changed.ts": "old", "removed.ts": "h3" },
    })
    const current = { "same.ts": "h1", "changed.ts": "new", "added.ts": "h4" }
    const result = diffManifest(previous, current)
    expect(result.added).toEqual(["added.ts"])
    expect(result.changed).toEqual(["changed.ts"])
    expect(result.removed).toEqual(["removed.ts"])
    expect(result.unchanged).toEqual(["same.ts"])
  })

  it("returns empty arrays when manifest matches current state exactly", () => {
    const previous = makeManifest({ fileHashes: { "a.ts": "h1", "b.ts": "h2" } })
    const result = diffManifest(previous, { "a.ts": "h1", "b.ts": "h2" })
    expect(result.added).toEqual([])
    expect(result.changed).toEqual([])
    expect(result.removed).toEqual([])
    expect(result.unchanged.sort()).toEqual(["a.ts", "b.ts"])
  })

  it("handles empty current map (everything removed)", () => {
    const previous = makeManifest({ fileHashes: { "a.ts": "h1" } })
    const result = diffManifest(previous, {})
    expect(result.removed).toEqual(["a.ts"])
    expect(result.added).toEqual([])
  })
})
