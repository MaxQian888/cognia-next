/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import {
  ALWAYS_EXCLUDED,
  DEFAULT_MAX_FILE_BYTES,
  WikiCorpusValidationError,
  createWikiCorpus,
  deleteWikiCorpus,
  getWikiCorpus,
  isWithinRoot,
  listEnabledWikiCorpora,
  listWikiCorpora,
  normalizeRootPath,
  purgeWikiCorpusContent,
  updateWikiCorpus,
} from "./wiki-corpora"
import { SELF_CORPUS_ID } from "@/types/wiki"
import { getDb } from "./schema"

beforeEach(async () => {
  const db = getDb()
  await db.wikiCorpora.clear()
  await db.wikiArticles.clear()
  await db.wikiSections.clear()
  await db.wikiArticlesStaging.clear()
  await db.wikiSectionsStaging.clear()
  await db.wikiBuildJobs.clear()
  await db.wikiCorpusManifest.clear()
}, 30_000)

describe("normalizeRootPath", () => {
  it("canonicalizes separators, duplicate slashes, and dot segments", () => {
    expect(normalizeRootPath("/Users/me//repo/")).toBe("/Users/me/repo")
    expect(normalizeRootPath("/Users/me/./repo")).toBe("/Users/me/repo")
    expect(normalizeRootPath("/Users/me/nested/../repo")).toBe("/Users/me/repo")
  })

  it("handles Windows drive-letter roots", () => {
    expect(normalizeRootPath("C:\\Users\\me\\repo")).toBe("C:/Users/me/repo")
    expect(normalizeRootPath("C:/Users/me/repo/")).toBe("C:/Users/me/repo")
  })

  it("rejects relative paths — an uncomparable root is an unenforceable one", () => {
    expect(() => normalizeRootPath("repo/src")).toThrow(WikiCorpusValidationError)
    expect(() => normalizeRootPath("./repo")).toThrow(/must be absolute/)
    expect(() => normalizeRootPath("   ")).toThrow(/must not be empty/)
  })

  it("rejects a path that walks above the filesystem root", () => {
    expect(() => normalizeRootPath("/../etc")).toThrow(/escapes the filesystem root/)
  })
})

describe("isWithinRoot", () => {
  it("accepts the root itself and descendants", () => {
    expect(isWithinRoot("/repo", "/repo")).toBe(true)
    expect(isWithinRoot("/repo", "/repo/lib/a.ts")).toBe(true)
    expect(isWithinRoot("/repo/", "/repo/lib/a.ts")).toBe(true)
  })

  it("rejects a sibling directory that merely shares a name prefix", () => {
    // A bare startsWith would accept this. It must not.
    expect(isWithinRoot("/repo", "/repo-secrets/creds.env")).toBe(false)
    expect(isWithinRoot("/repo", "/repository/a.ts")).toBe(false)
  })

  it("rejects traversal out of the root", () => {
    expect(isWithinRoot("/repo", "/repo/../etc/passwd")).toBe(false)
    expect(isWithinRoot("/repo", "/etc/passwd")).toBe(false)
  })

  it("rejects a candidate that cannot be normalized at all", () => {
    expect(isWithinRoot("/repo", "relative/path")).toBe(false)
  })
})

describe("createWikiCorpus", () => {
  it("applies safe defaults and always-on exclusions", async () => {
    const corpus = await createWikiCorpus({ displayName: "My repo", rootPath: "/Users/me/repo" })

    expect(corpus.kind).toBe("user-repo")
    expect(corpus.rootPath).toBe("/Users/me/repo")
    expect(corpus.maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES)
    // Not following symlinks is the safe default — following one is how a walk
    // leaves rootPath.
    expect(corpus.symlinkPolicy).toBe("skip")
    expect(corpus.exclude).toEqual(expect.arrayContaining([...ALWAYS_EXCLUDED]))
    expect(corpus.enabled).toBe(true)
  })

  it("keeps .git excluded even when the caller supplies its own exclude list", async () => {
    const corpus = await createWikiCorpus({
      displayName: "r",
      rootPath: "/r",
      exclude: ["docs/**"],
    })
    expect(corpus.exclude).toContain(".git/**")
    expect(corpus.exclude).toContain("docs/**")
  })

  it("refuses to let a caller claim the reserved self-corpus id", async () => {
    await expect(
      createWikiCorpus({ id: SELF_CORPUS_ID, displayName: "hijack", rootPath: "/tmp" })
    ).rejects.toThrow(/reserved/)
  })

  it("rejects an empty display name and a relative root", async () => {
    await expect(createWikiCorpus({ displayName: "  ", rootPath: "/r" })).rejects.toThrow(
      /displayName/
    )
    await expect(createWikiCorpus({ displayName: "r", rootPath: "rel" })).rejects.toThrow(
      /must be absolute/
    )
  })
})

describe("corpus listing and updates", () => {
  it("lists oldest-first and filters disabled ones", async () => {
    const db = getDb()
    const older = await createWikiCorpus({ displayName: "a", rootPath: "/a" })
    const newer = await createWikiCorpus({ displayName: "b", rootPath: "/b", enabled: false })
    // Force distinct timestamps: `createWikiCorpus` stamps `Date.now()`, and
    // two calls in the same tick are indistinguishable by time alone.
    await db.wikiCorpora.update(older.id, { createdAt: 100 })
    await db.wikiCorpora.update(newer.id, { createdAt: 200 })

    expect((await listWikiCorpora()).map((c) => c.id)).toEqual([older.id, newer.id])
    expect((await listEnabledWikiCorpora()).map((c) => c.id)).toEqual([older.id])
  })

  it("orders same-millisecond corpora deterministically instead of arbitrarily", async () => {
    const db = getDb()
    const first = await createWikiCorpus({ displayName: "a", rootPath: "/a" })
    const second = await createWikiCorpus({ displayName: "b", rootPath: "/b" })
    // Same tick — the settings list must not reshuffle between reads.
    await db.wikiCorpora.update(first.id, { createdAt: 500 })
    await db.wikiCorpora.update(second.id, { createdAt: 500 })

    const expected = [first.id, second.id].sort((x, y) => x.localeCompare(y))
    expect((await listWikiCorpora()).map((c) => c.id)).toEqual(expected)
    expect((await listWikiCorpora()).map((c) => c.id)).toEqual(expected)
  })

  it("normalizes a patched root path and re-applies always-on exclusions", async () => {
    const corpus = await createWikiCorpus({ displayName: "a", rootPath: "/a" })

    const updated = await updateWikiCorpus(corpus.id, {
      rootPath: "/a/nested/../moved/",
      exclude: ["vendor/**"],
    })

    expect(updated?.rootPath).toBe("/a/moved")
    expect(updated?.exclude).toContain(".git/**")
    expect(updated?.exclude).toContain("vendor/**")
    // Always-on entries must not be duplicated when the caller echoes them back.
    expect(updated?.exclude.filter((p) => p === ".git/**")).toHaveLength(1)
  })

  it("returns undefined when patching a corpus that does not exist", async () => {
    expect(await updateWikiCorpus("nope", { displayName: "x" })).toBeUndefined()
  })
})

describe("deletion semantics", () => {
  it("deleting a corpus removes only its configuration, never its content", async () => {
    const corpus = await createWikiCorpus({ displayName: "a", rootPath: "/a" })
    await getDb().wikiArticles.put(makeArticle("art-1", corpus.id))

    await deleteWikiCorpus(corpus.id)

    expect(await getWikiCorpus(corpus.id)).toBeUndefined()
    // Indexed content survives: unregistering a repo is not a request to
    // destroy what was already paid for.
    expect(await getDb().wikiArticles.get("art-1")).toBeDefined()
  })

  it("refuses to delete the built-in corpus", async () => {
    await expect(deleteWikiCorpus(SELF_CORPUS_ID)).rejects.toThrow(/cannot be deleted/)
  })

  it("purge removes every indexed row for the corpus and leaves others alone", async () => {
    const db = getDb()
    await db.wikiArticles.bulkPut([makeArticle("keep", "other"), makeArticle("drop", "target")])
    await db.wikiSections.bulkPut([
      makeSection("s-keep", "keep", "other"),
      makeSection("s-drop", "drop", "target"),
    ])
    await db.wikiBuildJobs.put({
      id: "build-1",
      corpusId: "target",
      mode: "full",
      status: "cancelled",
      cursor: { completedModules: [], processedFiles: 0 },
      queuedAt: 1,
    })
    await db.wikiSectionsStaging.put({
      ...makeSection("st-1", "drop", "target"),
      buildId: "build-1",
    })
    await db.wikiCorpusManifest.put({
      corpusId: "target",
      scope: "user-repo",
      fileHashes: {},
      lastBuildAt: 1,
      articleCount: 1,
      generatorVersion: "v1",
      manifestHash: "deadbeef",
    })

    const result = await purgeWikiCorpusContent("target")

    expect(result.articles).toBe(1)
    expect(await db.wikiArticles.get("drop")).toBeUndefined()
    expect(await db.wikiArticles.get("keep")).toBeDefined()
    expect(await db.wikiSections.get("s-drop")).toBeUndefined()
    expect(await db.wikiSections.get("s-keep")).toBeDefined()
    expect(await db.wikiSectionsStaging.get("st-1")).toBeUndefined()
    expect(await db.wikiBuildJobs.get("build-1")).toBeUndefined()
    expect(await db.wikiCorpusManifest.get("target")).toBeUndefined()
  })
})

function makeArticle(id: string, corpusId: string) {
  return {
    id,
    corpusId,
    slug: id,
    title: id,
    module: "lib/x",
    scope: "user-repo" as const,
    pageRank: 0,
    summary: "",
    sectionIds: [],
    sourceRefs: [],
    contentMd: "",
    embedding: [],
    generatedAt: 1,
    generatorVersion: "v1",
    fileHashes: {},
  }
}

function makeSection(id: string, articleId: string, corpusId: string) {
  return {
    id,
    corpusId,
    articleId,
    sectionIndex: 0,
    headingPath: ["intro"],
    bodyMd: "body",
    sourceRefs: [],
  }
}
