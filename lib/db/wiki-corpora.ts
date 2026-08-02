/**
 * CRUD layer for the `wikiCorpora` Dexie table (v142) — the registry of
 * indexable source trees (ADR-0008 Phase 3).
 *
 * Before v142 there was exactly one corpus, Cognia's own tree, and it was
 * identified by the `WikiScope` string `"cognia-self"`. A user can now register
 * their own repos, so a corpus needs an identity of its own: `cognia-self` stays
 * as a reserved id, and every user repo gets a generated one.
 *
 * `rootPath` is a **security boundary**, not a convenience default. The file
 * walker resolves every candidate path and refuses anything that does not stay
 * under this prefix; `normalizeRootPath` here is what that check compares
 * against, so it has to be the same normalization in every caller.
 */

import type { WikiCorpus, WikiCorpusKind, WikiSymlinkPolicy } from "@/types/wiki"
import { SELF_CORPUS_ID } from "@/types/wiki"
import { getDb } from "./schema"

/** 2 MiB. A source file larger than this is skipped whole. */
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * Directories never walked, whatever the user's `include` says. `.git` holds
 * full object history (including content deleted from the working tree), and
 * the rest are build output — expensive to read and worthless to index.
 */
export const ALWAYS_EXCLUDED = [
  ".git/**",
  "node_modules/**",
  "target/**",
  "dist/**",
  "out/**",
  ".next/**",
] as const

/** Thrown when a corpus definition would be unsafe or ill-formed. */
export class WikiCorpusValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WikiCorpusValidationError"
  }
}

function newCorpusId(): string {
  return "wkc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

/**
 * Canonicalize a repo root: POSIX separators, no trailing slash, no `.`/`..`
 * segments left unresolved.
 *
 * Rejects relative paths and any residual `..`. A root the walker cannot
 * compare literally is a root it cannot enforce, so this throws rather than
 * guessing — the caller gets the path from the Tauri directory picker, which
 * always yields an absolute one.
 */
export function normalizeRootPath(input: string): string {
  const raw = (input ?? "").trim()
  if (raw.length === 0) throw new WikiCorpusValidationError("rootPath must not be empty")

  const slashed = raw.replace(/\\/g, "/")
  const isWindowsAbsolute = /^[a-zA-Z]:\//.test(slashed)
  if (!slashed.startsWith("/") && !isWindowsAbsolute) {
    throw new WikiCorpusValidationError(`rootPath must be absolute: ${input}`)
  }

  const segments = slashed.split("/")
  const prefix = isWindowsAbsolute ? segments.shift()! : ""
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      // Escaping above the root the user picked is never intended here.
      if (resolved.length === 0) {
        throw new WikiCorpusValidationError(`rootPath escapes the filesystem root: ${input}`)
      }
      resolved.pop()
      continue
    }
    resolved.push(segment)
  }

  const body = resolved.join("/")
  if (isWindowsAbsolute) return `${prefix}/${body}`
  return `/${body}`
}

/**
 * True when `candidate` resolves to something inside `root`.
 *
 * The trailing-separator comparison is what stops `/repo-secrets` from passing
 * a `/repo` check — a bare `startsWith` would accept it.
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeRootPath(root)
  let normalizedCandidate: string
  try {
    normalizedCandidate = normalizeRootPath(candidate)
  } catch {
    // A relative or malformed candidate can never be proven inside the root.
    return false
  }
  if (normalizedCandidate === normalizedRoot) return true
  const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`
  return normalizedCandidate.startsWith(prefix)
}

export interface WikiCorpusDraft {
  id?: string
  kind?: WikiCorpusKind
  displayName: string
  rootPath: string
  include?: string[]
  exclude?: string[]
  maxFileBytes?: number
  symlinkPolicy?: WikiSymlinkPolicy
  enabled?: boolean
}

/**
 * Register a user repo.
 *
 * Refuses `SELF_CORPUS_ID` — the built-in tree is not user-creatable, and
 * letting a caller claim that id would repoint every pre-v142 article backfilled
 * onto it at a directory of the caller's choosing.
 */
export async function createWikiCorpus(draft: WikiCorpusDraft): Promise<WikiCorpus> {
  const id = draft.id ?? newCorpusId()
  if (id === SELF_CORPUS_ID) {
    throw new WikiCorpusValidationError(`${SELF_CORPUS_ID} is reserved for the built-in corpus`)
  }
  const displayName = draft.displayName.trim()
  if (displayName.length === 0) {
    throw new WikiCorpusValidationError("displayName must not be empty")
  }

  const now = Date.now()
  const row: WikiCorpus = {
    id,
    kind: draft.kind ?? "user-repo",
    displayName,
    rootPath: normalizeRootPath(draft.rootPath),
    include: draft.include ?? [],
    exclude: [...ALWAYS_EXCLUDED, ...(draft.exclude ?? [])],
    maxFileBytes: draft.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    // Not following symlinks is the safe default: following one is how a walk
    // leaves `rootPath`.
    symlinkPolicy: draft.symlinkPolicy ?? "skip",
    enabled: draft.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().wikiCorpora.add(row)
  return row
}

export async function getWikiCorpus(id: string): Promise<WikiCorpus | undefined> {
  return getDb().wikiCorpora.get(id)
}

/**
 * Deterministic list order: oldest first, ties broken by id.
 *
 * `createdAt` is millisecond-resolution, so two corpora registered in the same
 * tick — which happens whenever the UI creates several at once, and constantly
 * in tests — would otherwise have no defined order and the settings list would
 * reshuffle between reads. The id tie-break makes the order stable without
 * pretending sub-millisecond insertion order is recoverable.
 */
function byCreatedAtThenId(a: WikiCorpus, b: WikiCorpus): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id)
}

/** Every registered corpus, oldest first. Does not synthesize the self corpus. */
export async function listWikiCorpora(): Promise<WikiCorpus[]> {
  const rows = await getDb().wikiCorpora.toArray()
  return rows.sort(byCreatedAtThenId)
}

/** Corpora a refresh or a search may touch. Same ordering as {@link listWikiCorpora}. */
export async function listEnabledWikiCorpora(): Promise<WikiCorpus[]> {
  const rows = await getDb().wikiCorpora.toArray()
  return rows.filter((c) => c.enabled).sort(byCreatedAtThenId)
}

/**
 * Patch a corpus. `id`, `kind`, and `createdAt` are immutable — changing the id
 * would orphan every article, and changing the kind would let a user repo claim
 * built-in provenance.
 */
export async function updateWikiCorpus(
  id: string,
  patch: Partial<Omit<WikiCorpus, "id" | "kind" | "createdAt">>
): Promise<WikiCorpus | undefined> {
  const db = getDb()
  return db.transaction("rw", db.wikiCorpora, async () => {
    const row = await db.wikiCorpora.get(id)
    if (!row) return undefined
    const next: WikiCorpus = {
      ...row,
      ...patch,
      ...(patch.rootPath !== undefined ? { rootPath: normalizeRootPath(patch.rootPath) } : {}),
      ...(patch.exclude !== undefined
        ? { exclude: [...ALWAYS_EXCLUDED, ...patch.exclude.filter((p) => !isAlwaysExcluded(p))] }
        : {}),
      updatedAt: Date.now(),
    }
    await db.wikiCorpora.put(next)
    return next
  })
}

function isAlwaysExcluded(pattern: string): boolean {
  return (ALWAYS_EXCLUDED as readonly string[]).includes(pattern)
}

/**
 * Remove the corpus *configuration* only.
 *
 * Deliberately does not touch indexed content or anything on disk. Deleting a
 * repo entry is a common, reversible-feeling action; cascading into the user's
 * files — or even into their accepted, materialized knowledge — is not what
 * that click means. Corpus content teardown is a separate, separately-confirmed
 * operation (`purgeWikiCorpusContent`).
 */
export async function deleteWikiCorpus(id: string): Promise<void> {
  if (id === SELF_CORPUS_ID) {
    throw new WikiCorpusValidationError("the built-in corpus cannot be deleted")
  }
  await getDb().wikiCorpora.delete(id)
}

/**
 * Delete every indexed row belonging to a corpus: articles, sections, staging,
 * build jobs, and the manifest. Never touches files on disk.
 *
 * Separate from {@link deleteWikiCorpus} and separately confirmed in the UI,
 * because this one is not reversible without a full (paid) rebuild.
 */
export async function purgeWikiCorpusContent(corpusId: string): Promise<{ articles: number }> {
  const db = getDb()
  // Array form: Dexie's positional overload tops out at 5 tables.
  return db.transaction(
    "rw",
    [
      db.wikiArticles,
      db.wikiSections,
      db.wikiArticlesStaging,
      db.wikiSectionsStaging,
      db.wikiBuildJobs,
      db.wikiCorpusManifest,
    ],
    async () => {
      const articles = await db.wikiArticles.where("corpusId").equals(corpusId).delete()
      await db.wikiSections.where("corpusId").equals(corpusId).delete()
      await db.wikiArticlesStaging.where("corpusId").equals(corpusId).delete()
      // Staged sections carry no corpusId index of their own; they are reached
      // through their build.
      const buildIds = await db.wikiBuildJobs.where("corpusId").equals(corpusId).primaryKeys()
      for (const buildId of buildIds) {
        await db.wikiSectionsStaging
          .where("buildId")
          .equals(buildId as string)
          .delete()
      }
      await db.wikiBuildJobs.where("corpusId").equals(corpusId).delete()
      await db.wikiCorpusManifest.delete(corpusId)
      return { articles }
    }
  )
}
