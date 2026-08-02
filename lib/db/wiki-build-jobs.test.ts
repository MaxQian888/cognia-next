/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import {
  EMPTY_CURSOR,
  TERMINAL_BUILD_STATUSES,
  WikiBuildTransitionError,
  canTransition,
  createWikiBuildJob,
  discardBuildStaging,
  findActiveWikiBuildJob,
  getWikiBuildJob,
  isCancellationRequested,
  listWikiBuildJobs,
  promoteBuild,
  saveWikiBuildCursor,
  stageBuildArticles,
  transitionWikiBuildJob,
} from "./wiki-build-jobs"
import type { WikiStagedArticle, WikiStagedSection } from "@/types/wiki"
import { getDb } from "./schema"

const CORPUS = "corpus-a"

beforeEach(async () => {
  const db = getDb()
  await db.wikiBuildJobs.clear()
  await db.wikiArticles.clear()
  await db.wikiSections.clear()
  await db.wikiArticlesStaging.clear()
  await db.wikiSectionsStaging.clear()
  await db.wikiCorpusManifest.clear()
}, 30_000)

function stagedArticle(
  buildId: string,
  slug: string,
  overrides: Partial<WikiStagedArticle> = {}
): WikiStagedArticle {
  return {
    id: `${buildId}-${slug}`,
    buildId,
    corpusId: CORPUS,
    slug,
    title: slug,
    module: `lib/${slug}`,
    scope: "user-repo",
    pageRank: 0.5,
    summary: `summary for ${slug}`,
    sectionIds: [],
    sourceRefs: [],
    contentMd: `# ${slug}`,
    embedding: [],
    generatedAt: 1,
    generatorVersion: "v2",
    fileHashes: {},
    ...overrides,
  }
}

function stagedSection(buildId: string, articleId: string, id: string): WikiStagedSection {
  return {
    id,
    buildId,
    corpusId: CORPUS,
    articleId,
    sectionIndex: 0,
    headingPath: ["intro"],
    bodyMd: "body",
    sourceRefs: [],
  }
}

async function seedLiveArticle(id: string, slug: string) {
  const db = getDb()
  await db.wikiArticles.put({ ...stagedArticle("live", slug, { id }), buildId: undefined } as never)
  await db.wikiSections.put({
    id: `${id}-sec`,
    corpusId: CORPUS,
    articleId: id,
    sectionIndex: 0,
    headingPath: ["old"],
    bodyMd: "old body",
    sourceRefs: [],
  })
}

describe("build job state machine", () => {
  it("permits only the declared transitions", () => {
    expect(canTransition("queued", "running")).toBe(true)
    expect(canTransition("running", "cancelling")).toBe(true)
    expect(canTransition("cancelling", "cancelled")).toBe(true)
    expect(canTransition("paused", "running")).toBe(true)

    // A build that jumps straight to completed skipped its staging write.
    expect(canTransition("queued", "completed")).toBe(false)
    // Terminal means terminal.
    for (const terminal of TERMINAL_BUILD_STATUSES) {
      expect(canTransition(terminal, "running")).toBe(false)
    }
  })

  it("stamps startedAt once and finishedAt on a terminal transition", async () => {
    const job = await createWikiBuildJob({ corpusId: CORPUS, mode: "full", now: 100 })
    expect(job.cursor).toEqual(EMPTY_CURSOR)

    const running = await transitionWikiBuildJob(job.id, "running", { now: 200 })
    expect(running.startedAt).toBe(200)
    expect(running.finishedAt).toBeUndefined()

    const failed = await transitionWikiBuildJob(job.id, "failed", { now: 300, error: "boom" })
    expect(failed.startedAt).toBe(200)
    expect(failed.finishedAt).toBe(300)
    expect(failed.error).toBe("boom")
  })

  it("throws on an illegal transition and on a missing job", async () => {
    const job = await createWikiBuildJob({ corpusId: CORPUS, mode: "full" })
    await expect(transitionWikiBuildJob(job.id, "completed")).rejects.toThrow(
      WikiBuildTransitionError
    )
    await expect(transitionWikiBuildJob("ghost", "running")).rejects.toThrow(/missing → running/)
  })

  it("treats cancelling and cancelled as distinct, both cancel-requested", async () => {
    const job = await createWikiBuildJob({ corpusId: CORPUS, mode: "full" })
    await transitionWikiBuildJob(job.id, "running")
    expect(await isCancellationRequested(job.id)).toBe(false)

    // Cancellation is cooperative: the job is still running here.
    await transitionWikiBuildJob(job.id, "cancelling")
    expect((await getWikiBuildJob(job.id))?.status).toBe("cancelling")
    expect(await isCancellationRequested(job.id)).toBe(true)

    await transitionWikiBuildJob(job.id, "cancelled")
    expect(await isCancellationRequested(job.id)).toBe(true)
  })

  it("treats a vanished job as cancelled rather than continuing to spend", async () => {
    expect(await isCancellationRequested("never-existed")).toBe(true)
  })

  it("persists a resume cursor", async () => {
    const job = await createWikiBuildJob({ corpusId: CORPUS, mode: "incremental" })
    await saveWikiBuildCursor(job.id, {
      completedModules: ["lib/a"],
      processedFiles: 12,
      nextModule: "lib/b",
    })

    const reloaded = await getWikiBuildJob(job.id)
    expect(reloaded?.cursor).toEqual({
      completedModules: ["lib/a"],
      processedFiles: 12,
      nextModule: "lib/b",
    })
  })

  it("finds the single non-terminal job and lists history newest-first", async () => {
    const old = await createWikiBuildJob({ corpusId: CORPUS, mode: "full", now: 100 })
    await transitionWikiBuildJob(old.id, "running")
    await transitionWikiBuildJob(old.id, "failed")
    const active = await createWikiBuildJob({ corpusId: CORPUS, mode: "full", now: 200 })

    expect((await findActiveWikiBuildJob(CORPUS))?.id).toBe(active.id)
    expect((await listWikiBuildJobs(CORPUS)).map((j) => j.id)).toEqual([active.id, old.id])
    expect(await findActiveWikiBuildJob("other-corpus")).toBeUndefined()
  })
})

describe("staging", () => {
  it("stages and discards by build id without touching the live corpus", async () => {
    await seedLiveArticle("live-1", "kept")
    await stageBuildArticles(
      [stagedArticle("b1", "new")],
      [stagedSection("b1", "b1-new", "b1-sec")]
    )

    expect(await getDb().wikiArticlesStaging.count()).toBe(1)

    await discardBuildStaging("b1")

    expect(await getDb().wikiArticlesStaging.count()).toBe(0)
    expect(await getDb().wikiSectionsStaging.count()).toBe(0)
    // The whole point: a discarded build leaves the previous corpus intact.
    expect(await getDb().wikiArticles.get("live-1")).toBeDefined()
  })

  it("is a no-op for an empty stage", async () => {
    await expect(stageBuildArticles([], [])).resolves.toBeUndefined()
  })
})

describe("promoteBuild", () => {
  it("full rebuild replaces the corpus and strips the staging-only buildId", async () => {
    await seedLiveArticle("live-1", "old-slug")
    const job = await createWikiBuildJob({ corpusId: CORPUS, mode: "full" })
    await transitionWikiBuildJob(job.id, "running")
    await stageBuildArticles(
      [stagedArticle(job.id, "fresh")],
      [stagedSection(job.id, `${job.id}-fresh`, `${job.id}-sec`)]
    )

    const result = await promoteBuild(job.id, { "lib/a.ts": "sha" }, { generatorVersion: "v2" })

    expect(result).toEqual({ articlesPromoted: 1, articlesReplaced: 1 })
    const live = await getDb().wikiArticles.where("corpusId").equals(CORPUS).toArray()
    expect(live.map((a) => a.slug)).toEqual(["fresh"])
    // `buildId` is a staging column; it must not leak onto a live row.
    expect(live[0]).not.toHaveProperty("buildId")
    expect(await getDb().wikiArticles.get("live-1")).toBeUndefined()
  })

  it("clears staging and marks the job completed", async () => {
    const job = await createWikiBuildJob({ corpusId: CORPUS, mode: "full" })
    await transitionWikiBuildJob(job.id, "running")
    await stageBuildArticles([stagedArticle(job.id, "a")], [])

    await promoteBuild(job.id, {}, { now: 999 })

    expect(await getDb().wikiArticlesStaging.count()).toBe(0)
    const done = await getWikiBuildJob(job.id)
    expect(done?.status).toBe("completed")
    expect(done?.finishedAt).toBe(999)
  })

  it("incremental promote replaces only regenerated slugs and keeps the rest", async () => {
    await seedLiveArticle("live-keep", "untouched")
    await seedLiveArticle("live-replace", "regenerated")
    const job = await createWikiBuildJob({ corpusId: CORPUS, mode: "incremental" })
    await transitionWikiBuildJob(job.id, "running")
    await stageBuildArticles([stagedArticle(job.id, "regenerated")], [])

    const result = await promoteBuild(job.id, {})

    expect(result).toEqual({ articlesPromoted: 1, articlesReplaced: 1 })
    const slugs = (await getDb().wikiArticles.where("corpusId").equals(CORPUS).toArray())
      .map((a) => a.slug)
      .sort()
    // An incremental build must not shrink the corpus to what it regenerated.
    expect(slugs).toEqual(["regenerated", "untouched"])
    // The replaced article's stale sections are gone, not orphaned.
    expect(await getDb().wikiSections.where("articleId").equals("live-replace").count()).toBe(0)
    expect(await getDb().wikiSections.where("articleId").equals("live-keep").count()).toBe(1)
  })

  it("writes a manifest whose hash is derived from the promoted file hashes", async () => {
    const job = await createWikiBuildJob({ corpusId: CORPUS, mode: "full" })
    await transitionWikiBuildJob(job.id, "running")
    await stageBuildArticles([stagedArticle(job.id, "a")], [])

    await promoteBuild(job.id, { "lib/a.ts": "sha-a" }, { generatorVersion: "v3", now: 42 })

    const manifest = await getDb().wikiCorpusManifest.get(CORPUS)
    expect(manifest).toMatchObject({
      corpusId: CORPUS,
      lastBuildAt: 42,
      articleCount: 1,
      generatorVersion: "v3",
      fileHashes: { "lib/a.ts": "sha-a" },
    })
    expect(manifest?.manifestHash).toMatch(/^[0-9a-f]{8}$/)
  })

  it("refuses to promote a job that is not running, leaving the corpus untouched", async () => {
    await seedLiveArticle("live-1", "old")
    const job = await createWikiBuildJob({ corpusId: CORPUS, mode: "full" })
    await stageBuildArticles([stagedArticle(job.id, "fresh")], [])

    await expect(promoteBuild(job.id, {})).rejects.toThrow(WikiBuildTransitionError)

    expect(await getDb().wikiArticles.get("live-1")).toBeDefined()
    expect(await getDb().wikiArticlesStaging.count()).toBe(1)
  })

  it("refuses to promote a missing job", async () => {
    await expect(promoteBuild("ghost", {})).rejects.toThrow(/missing → completed/)
  })

  it("incremental promote of a brand-new slug replaces nothing", async () => {
    const job = await createWikiBuildJob({ corpusId: CORPUS, mode: "incremental" })
    await transitionWikiBuildJob(job.id, "running")
    await stageBuildArticles([stagedArticle(job.id, "brand-new")], [])

    expect(await promoteBuild(job.id, {})).toEqual({ articlesPromoted: 1, articlesReplaced: 0 })
  })

  it("carries the previous manifest's scope and generator version forward", async () => {
    await getDb().wikiCorpusManifest.put({
      corpusId: CORPUS,
      scope: "cognia-self",
      fileHashes: {},
      lastBuildAt: 1,
      articleCount: 0,
      generatorVersion: "v-previous",
      manifestHash: "00000000",
    })
    const job = await createWikiBuildJob({ corpusId: CORPUS, mode: "full" })
    await transitionWikiBuildJob(job.id, "running")

    // No `generatorVersion` override: the prior value must survive rather than
    // being blanked out by the promote.
    await promoteBuild(job.id, {})

    expect(await getDb().wikiCorpusManifest.get(CORPUS)).toMatchObject({
      scope: "cognia-self",
      generatorVersion: "v-previous",
    })
  })

  it("derives a scope for a first-ever build of each corpus kind", async () => {
    const userRepo = await createWikiBuildJob({ corpusId: CORPUS, mode: "full" })
    await transitionWikiBuildJob(userRepo.id, "running")
    await promoteBuild(userRepo.id, {})

    const self = await createWikiBuildJob({ corpusId: "cognia-self", mode: "full" })
    await transitionWikiBuildJob(self.id, "running")
    await promoteBuild(self.id, {})

    expect((await getDb().wikiCorpusManifest.get(CORPUS))?.scope).toBe("user-repo")
    expect((await getDb().wikiCorpusManifest.get("cognia-self"))?.scope).toBe("cognia-self")
    // With no prior manifest and no override, the generator version is blank
    // rather than undefined — the column is not optional.
    expect((await getDb().wikiCorpusManifest.get(CORPUS))?.generatorVersion).toBe("")
  })
})

describe("defaults", () => {
  it("generates an id and timestamps when the caller omits them", async () => {
    const before = Date.now()
    const job = await createWikiBuildJob({ corpusId: CORPUS, mode: "full" })

    expect(job.id).toMatch(/^wkb_/)
    expect(job.queuedAt).toBeGreaterThanOrEqual(before)
    expect(job.estimate).toBeUndefined()

    const running = await transitionWikiBuildJob(job.id, "running")
    expect(running.startedAt).toBeGreaterThanOrEqual(before)
    // No error patch supplied — the field must stay absent, not become "".
    expect(running.error).toBeUndefined()
  })

  it("retains a supplied cost estimate on the job", async () => {
    const estimate = {
      fileCount: 10,
      byteCount: 2048,
      estimatedInputTokens: 1000,
      estimatedOutputTokens: 250,
      // Unknown price: the UI must say so rather than invent a number.
      estimatedCostUsd: null,
      modelId: "some-unpriced-model",
      manifestHash: "abcd1234",
      computedAt: 5,
    }
    const job = await createWikiBuildJob({ corpusId: CORPUS, mode: "full", estimate })

    expect((await getWikiBuildJob(job.id))?.estimate).toEqual(estimate)
  })
})
