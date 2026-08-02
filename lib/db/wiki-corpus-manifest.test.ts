/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import {
  buildRebuildConfirmationToken,
  deleteWikiCorpusManifest,
  getSelfCorpusManifest,
  getWikiCorpusManifest,
  listWikiCorpusManifests,
  listWikiCorpusManifestsByScope,
  upsertWikiCorpusManifest,
  verifyRebuildConfirmation,
} from "./wiki-corpus-manifest"
import { hashFileHashes } from "@/lib/wiki/manifest-hash"
import { SELF_CORPUS_ID } from "@/types/wiki"
import { getDb } from "./schema"

beforeEach(async () => {
  await getDb().wikiCorpusManifest.clear()
}, 30_000)

const BASE = {
  scope: "user-repo" as const,
  lastBuildAt: 100,
  articleCount: 3,
  generatorVersion: "v1",
}

describe("upsert", () => {
  it("derives manifestHash from the file hashes rather than trusting the caller", async () => {
    const fileHashes = { "lib/a.ts": "sha-a" }
    const row = await upsertWikiCorpusManifest({ corpusId: "c1", fileHashes, ...BASE })

    expect(row.manifestHash).toBe(hashFileHashes(fileHashes))
    expect((await getWikiCorpusManifest("c1"))?.manifestHash).toBe(row.manifestHash)
  })

  it("moves the hash when the corpus content changes", async () => {
    const first = await upsertWikiCorpusManifest({
      corpusId: "c1",
      fileHashes: { "a.ts": "1" },
      ...BASE,
    })
    const second = await upsertWikiCorpusManifest({
      corpusId: "c1",
      fileHashes: { "a.ts": "2" },
      ...BASE,
    })
    expect(second.manifestHash).not.toBe(first.manifestHash)
  })
})

describe("listing", () => {
  it("lists all manifests and filters by scope", async () => {
    await upsertWikiCorpusManifest({ corpusId: "c1", fileHashes: {}, ...BASE })
    await upsertWikiCorpusManifest({
      corpusId: SELF_CORPUS_ID,
      fileHashes: {},
      ...BASE,
      scope: "cognia-self",
    })

    expect(await listWikiCorpusManifests()).toHaveLength(2)
    expect((await listWikiCorpusManifestsByScope("user-repo")).map((m) => m.corpusId)).toEqual([
      "c1",
    ])
    expect((await getSelfCorpusManifest())?.scope).toBe("cognia-self")
  })

  it("deletes a manifest", async () => {
    await upsertWikiCorpusManifest({ corpusId: "c1", fileHashes: {}, ...BASE })
    await deleteWikiCorpusManifest("c1")
    expect(await getWikiCorpusManifest("c1")).toBeUndefined()
  })
})

describe("rebuild confirmation token", () => {
  it("accepts a token minted against the current manifest", async () => {
    const manifest = await upsertWikiCorpusManifest({
      corpusId: "c1",
      fileHashes: { "a.ts": "1" },
      ...BASE,
    })
    const token = buildRebuildConfirmationToken("c1", manifest.manifestHash)

    expect(await verifyRebuildConfirmation("c1", token)).toEqual({ ok: true })
  })

  it("rejects a token once the repo has changed on disk", async () => {
    const manifest = await upsertWikiCorpusManifest({
      corpusId: "c1",
      fileHashes: { "a.ts": "1" },
      ...BASE,
    })
    const token = buildRebuildConfirmationToken("c1", manifest.manifestHash)

    // The user edited the repo between seeing the estimate and confirming it.
    await upsertWikiCorpusManifest({ corpusId: "c1", fileHashes: { "a.ts": "2" }, ...BASE })

    expect(await verifyRebuildConfirmation("c1", token)).toEqual({
      ok: false,
      reason: "manifest-changed",
    })
  })

  it("rejects a token minted for a different corpus", async () => {
    const manifest = await upsertWikiCorpusManifest({ corpusId: "c1", fileHashes: {}, ...BASE })
    await upsertWikiCorpusManifest({ corpusId: "c2", fileHashes: {}, ...BASE })

    const token = buildRebuildConfirmationToken("c1", manifest.manifestHash)
    expect(await verifyRebuildConfirmation("c2", token)).toEqual({
      ok: false,
      reason: "corpus-mismatch",
    })
  })

  it("fails closed for a malformed token and for a corpus with no manifest", async () => {
    await upsertWikiCorpusManifest({ corpusId: "c1", fileHashes: {}, ...BASE })

    expect(await verifyRebuildConfirmation("c1", "no-separator")).toEqual({
      ok: false,
      reason: "corpus-mismatch",
    })
    expect(await verifyRebuildConfirmation("never-built", "never-built:abc")).toEqual({
      ok: false,
      reason: "no-manifest",
    })
  })

  it("handles a corpus id containing a colon", async () => {
    const manifest = await upsertWikiCorpusManifest({
      corpusId: "repo:sub",
      fileHashes: {},
      ...BASE,
    })
    const token = buildRebuildConfirmationToken("repo:sub", manifest.manifestHash)

    expect(await verifyRebuildConfirmation("repo:sub", token)).toEqual({ ok: true })
  })
})
