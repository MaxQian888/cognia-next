/**
 * CRUD layer for `wikiBuildJobs` + the staging tables (v142) — cancellable,
 * resumable, staging-backed wiki rebuilds (ADR-0008 Phase 3).
 *
 * ## The invariant this module exists to hold
 *
 * **A rebuild never deletes the live corpus to make room for itself.** Generated
 * articles cost real money and minutes of wall clock; a rebuild that clears the
 * corpus up front and then fails at 80% has destroyed something the user cannot
 * cheaply get back. So every article a build produces is written to
 * `wikiArticlesStaging` keyed by `buildId`, and the live tables are replaced
 * only in {@link promoteBuild} — one Dexie transaction, after the build has
 * already succeeded. A cancelled or failed build is a range delete on staging
 * and the live corpus was never touched.
 *
 * ## Cancellation is cooperative
 *
 * `cancelling` and `cancelled` are different states on purpose. Nothing can
 * interrupt an in-flight LLM call, so requesting a cancel sets `cancelling` and
 * the runner checks it at the next scan / call / persist boundary, then settles
 * to `cancelled`. A UI that collapsed the two would claim the job stopped while
 * it was still spending money.
 */

import type {
  WikiBuildCostEstimate,
  WikiBuildCursor,
  WikiBuildJob,
  WikiBuildJobStatus,
  WikiBuildMode,
  WikiStagedArticle,
  WikiStagedSection,
} from "@/types/wiki"
import { getDb } from "./schema"
import { hashFileHashes } from "@/lib/wiki/manifest-hash"

/** Statuses from which no further transition is legal. */
export const TERMINAL_BUILD_STATUSES: readonly WikiBuildJobStatus[] = [
  "cancelled",
  "completed",
  "failed",
] as const

/**
 * Legal transitions. Anything absent is rejected — a build that jumps straight
 * from `queued` to `completed` skipped the staging write, and the promote that
 * should have happened never did.
 */
const ALLOWED_TRANSITIONS: Record<WikiBuildJobStatus, readonly WikiBuildJobStatus[]> = {
  queued: ["running", "cancelled", "failed"],
  running: ["cancelling", "paused", "completed", "failed"],
  // A paused job resumes from its persisted cursor.
  paused: ["running", "cancelling", "cancelled", "failed"],
  cancelling: ["cancelled", "failed"],
  cancelled: [],
  completed: [],
  failed: [],
}

export class WikiBuildTransitionError extends Error {
  constructor(
    readonly jobId: string,
    readonly from: WikiBuildJobStatus | "missing",
    readonly to: WikiBuildJobStatus
  ) {
    super(`wiki build ${jobId}: cannot transition ${from} → ${to}`)
    this.name = "WikiBuildTransitionError"
  }
}

export function canTransition(from: WikiBuildJobStatus, to: WikiBuildJobStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

function newBuildId(): string {
  return "wkb_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export const EMPTY_CURSOR: WikiBuildCursor = { completedModules: [], processedFiles: 0 }

export async function createWikiBuildJob(input: {
  corpusId: string
  mode: WikiBuildMode
  estimate?: WikiBuildCostEstimate
  id?: string
  now?: number
}): Promise<WikiBuildJob> {
  const now = input.now ?? Date.now()
  const job: WikiBuildJob = {
    id: input.id ?? newBuildId(),
    corpusId: input.corpusId,
    mode: input.mode,
    status: "queued",
    cursor: { ...EMPTY_CURSOR, completedModules: [] },
    ...(input.estimate ? { estimate: input.estimate } : {}),
    queuedAt: now,
  }
  await getDb().wikiBuildJobs.add(job)
  return job
}

export async function getWikiBuildJob(id: string): Promise<WikiBuildJob | undefined> {
  return getDb().wikiBuildJobs.get(id)
}

/** Build history for a corpus, newest first. */
export async function listWikiBuildJobs(corpusId: string, limit = 50): Promise<WikiBuildJob[]> {
  const rows = await getDb()
    .wikiBuildJobs.where("[corpusId+queuedAt]")
    .between([corpusId, -Infinity], [corpusId, Infinity])
    .toArray()
  return rows.reverse().slice(0, limit)
}

/**
 * The one non-terminal job for a corpus, if any. Used to refuse a second
 * concurrent rebuild of the same corpus — two builds racing to promote would
 * interleave their staging swaps.
 */
export async function findActiveWikiBuildJob(corpusId: string): Promise<WikiBuildJob | undefined> {
  const rows = await getDb().wikiBuildJobs.where("corpusId").equals(corpusId).toArray()
  return rows.find((j) => !TERMINAL_BUILD_STATUSES.includes(j.status))
}

/**
 * Move a job to a new status, enforcing {@link ALLOWED_TRANSITIONS}.
 *
 * @throws {WikiBuildTransitionError} on a missing job or an illegal transition.
 */
export async function transitionWikiBuildJob(
  id: string,
  to: WikiBuildJobStatus,
  patch: { cursor?: WikiBuildCursor; error?: string; now?: number } = {}
): Promise<WikiBuildJob> {
  const db = getDb()
  const now = patch.now ?? Date.now()
  return db.transaction("rw", db.wikiBuildJobs, async () => {
    const job = await db.wikiBuildJobs.get(id)
    if (!job) throw new WikiBuildTransitionError(id, "missing", to)
    if (!canTransition(job.status, to)) {
      throw new WikiBuildTransitionError(id, job.status, to)
    }
    const next: WikiBuildJob = {
      ...job,
      status: to,
      ...(patch.cursor ? { cursor: patch.cursor } : {}),
      ...(patch.error !== undefined ? { error: patch.error.slice(0, 4000) } : {}),
      ...(to === "running" && job.startedAt === undefined ? { startedAt: now } : {}),
      ...(TERMINAL_BUILD_STATUSES.includes(to) ? { finishedAt: now } : {}),
    }
    await db.wikiBuildJobs.put(next)
    return next
  })
}

/**
 * Persist the resume point. Called at each module boundary, so a job killed
 * mid-corpus re-does at most one module's LLM work on resume instead of all of
 * it.
 */
export async function saveWikiBuildCursor(id: string, cursor: WikiBuildCursor): Promise<void> {
  await getDb().wikiBuildJobs.update(id, { cursor })
}

/** True once a cancel has been requested. The runner polls this at each boundary. */
export async function isCancellationRequested(id: string): Promise<boolean> {
  const job = await getDb().wikiBuildJobs.get(id)
  if (!job) return true // A vanished job is not worth continuing to pay for.
  return job.status === "cancelling" || job.status === "cancelled"
}

// ─────────────────────────────────────────────────────────────────────────────
// Staging
// ─────────────────────────────────────────────────────────────────────────────

export async function stageBuildArticles(
  articles: WikiStagedArticle[],
  sections: WikiStagedSection[]
): Promise<void> {
  if (articles.length === 0 && sections.length === 0) return
  const db = getDb()
  await db.transaction("rw", db.wikiArticlesStaging, db.wikiSectionsStaging, async () => {
    if (articles.length > 0) await db.wikiArticlesStaging.bulkPut(articles)
    if (sections.length > 0) await db.wikiSectionsStaging.bulkPut(sections)
  })
}

/** Drop every staged row for a build. Used on cancel, failure, and post-promote. */
export async function discardBuildStaging(buildId: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.wikiArticlesStaging, db.wikiSectionsStaging, async () => {
    await db.wikiArticlesStaging.where("buildId").equals(buildId).delete()
    await db.wikiSectionsStaging.where("buildId").equals(buildId).delete()
  })
}

export interface PromoteResult {
  articlesPromoted: number
  articlesReplaced: number
}

/**
 * Atomically swap a completed build's staged output in as the corpus's live
 * content, and mark the job `completed`.
 *
 * Everything happens in one Dexie transaction: read staging, delete the live
 * rows for that corpus, insert the promoted rows, rewrite the manifest, flip
 * the job. If any step throws, Dexie aborts and the previous corpus is still
 * exactly where it was — which is the entire reason staging exists.
 *
 * For `mode: "incremental"` the live rows are *merged*, not replaced: an
 * incremental build only regenerates the modules whose files changed, so
 * deleting the untouched ones would silently shrink the corpus.
 *
 * @throws {WikiBuildTransitionError} if the job is missing or not `running`.
 */
export async function promoteBuild(
  buildId: string,
  fileHashes: Record<string, string>,
  options: { generatorVersion?: string; now?: number } = {}
): Promise<PromoteResult> {
  const db = getDb()
  const now = options.now ?? Date.now()
  // Array form: Dexie's positional overload tops out at 5 tables.
  return db.transaction(
    "rw",
    [
      db.wikiBuildJobs,
      db.wikiArticles,
      db.wikiSections,
      db.wikiArticlesStaging,
      db.wikiSectionsStaging,
      db.wikiCorpusManifest,
    ],
    async () => {
      const job = await db.wikiBuildJobs.get(buildId)
      if (!job) throw new WikiBuildTransitionError(buildId, "missing", "completed")
      if (!canTransition(job.status, "completed")) {
        throw new WikiBuildTransitionError(buildId, job.status, "completed")
      }

      const staged = await db.wikiArticlesStaging.where("buildId").equals(buildId).toArray()
      const stagedSections = await db.wikiSectionsStaging.where("buildId").equals(buildId).toArray()

      let articlesReplaced = 0
      if (job.mode === "full") {
        // Full rebuild: the staged set IS the corpus.
        const liveIds = await db.wikiArticles.where("corpusId").equals(job.corpusId).primaryKeys()
        articlesReplaced = liveIds.length
        await db.wikiArticles.where("corpusId").equals(job.corpusId).delete()
        await db.wikiSections.where("corpusId").equals(job.corpusId).delete()
      } else {
        // Incremental: replace only the slugs this build regenerated, and drop
        // their old sections so a shrunk article does not keep orphan bodies.
        for (const article of staged) {
          const existing = await db.wikiArticles
            .where("[corpusId+slug]")
            .equals([job.corpusId, article.slug])
            .first()
          if (!existing) continue
          articlesReplaced++
          await db.wikiSections.where("articleId").equals(existing.id).delete()
          await db.wikiArticles.delete(existing.id)
        }
      }

      // Strip `buildId` — it is a staging-only column and has no meaning on a
      // live row.
      await db.wikiArticles.bulkPut(staged.map(({ buildId: _buildId, ...row }) => row))
      await db.wikiSections.bulkPut(stagedSections.map(({ buildId: _buildId, ...row }) => row))

      const articleCount = await db.wikiArticles.where("corpusId").equals(job.corpusId).count()
      const previous = await db.wikiCorpusManifest.get(job.corpusId)
      await db.wikiCorpusManifest.put({
        corpusId: job.corpusId,
        scope: previous?.scope ?? (job.corpusId === "cognia-self" ? "cognia-self" : "user-repo"),
        fileHashes,
        lastBuildAt: now,
        articleCount,
        generatorVersion: options.generatorVersion ?? previous?.generatorVersion ?? "",
        manifestHash: hashFileHashes(fileHashes),
      })

      await db.wikiArticlesStaging.where("buildId").equals(buildId).delete()
      await db.wikiSectionsStaging.where("buildId").equals(buildId).delete()
      await db.wikiBuildJobs.put({ ...job, status: "completed", finishedAt: now })

      return { articlesPromoted: staged.length, articlesReplaced }
    }
  )
}
