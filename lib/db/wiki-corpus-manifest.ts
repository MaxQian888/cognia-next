/**
 * CRUD layer for the `wikiCorpusManifest` Dexie table (v142).
 *
 * One row per corpus: the Merkle map (filePath → sha256 at last successful
 * build) plus aggregate build metadata. Supersedes the scope-keyed
 * `wikiManifest` — a `scope` primary key cannot express "many user repos", and
 * Dexie cannot repoint a primary key in place, so v142 copied the legacy rows
 * into this table rather than migrating in place. `lib/db/wiki-manifest.ts` is
 * now read-only legacy; new code belongs here.
 *
 * `diffManifest` is deliberately NOT re-implemented here — it is a pure
 * function over `{ fileHashes }` and is reused from `./wiki-manifest`.
 */

import type { WikiCorpusManifest, WikiScope } from "@/types/wiki"
import { SELF_CORPUS_ID } from "@/types/wiki"
import { getDb } from "./schema"
import { hashFileHashes } from "@/lib/wiki/manifest-hash"

export { diffManifest } from "./wiki-manifest"

export async function getWikiCorpusManifest(
  corpusId: string
): Promise<WikiCorpusManifest | undefined> {
  return getDb().wikiCorpusManifest.get(corpusId)
}

/**
 * Upsert a manifest, recomputing `manifestHash` from the supplied hashes.
 *
 * The hash is never taken from the caller: a stale or hand-supplied value would
 * let a full-rebuild confirmation token keep matching after the repo changed,
 * which is exactly the failure the token exists to prevent.
 */
export async function upsertWikiCorpusManifest(
  manifest: Omit<WikiCorpusManifest, "manifestHash">
): Promise<WikiCorpusManifest> {
  const row: WikiCorpusManifest = {
    ...manifest,
    manifestHash: hashFileHashes(manifest.fileHashes),
  }
  await getDb().wikiCorpusManifest.put(row)
  return row
}

export async function deleteWikiCorpusManifest(corpusId: string): Promise<void> {
  await getDb().wikiCorpusManifest.delete(corpusId)
}

export async function listWikiCorpusManifests(): Promise<WikiCorpusManifest[]> {
  return getDb().wikiCorpusManifest.toArray()
}

/** Manifests for one scope — e.g. every user repo. */
export async function listWikiCorpusManifestsByScope(
  scope: WikiScope
): Promise<WikiCorpusManifest[]> {
  return getDb().wikiCorpusManifest.where("scope").equals(scope).toArray()
}

/**
 * Confirmation token for a full rebuild.
 *
 * Binds the user's "yes, spend this" to the corpus contents they were quoted
 * for. `verifyRebuildConfirmation` re-reads the manifest at execution time and
 * refuses if the hash moved, so a repo that changed between the estimate and
 * the confirm forces a fresh estimate instead of a silent rebuild at an
 * unquoted cost.
 */
export function buildRebuildConfirmationToken(corpusId: string, manifestHash: string): string {
  return `${corpusId}:${manifestHash}`
}

export type RebuildConfirmationResult =
  { ok: true } | { ok: false; reason: "no-manifest" | "corpus-mismatch" | "manifest-changed" }

/**
 * Check a confirmation token against the corpus's *current* manifest.
 *
 * A corpus with no manifest yet has never been built, so there is nothing a
 * stale token could be hiding — but it still fails closed (`no-manifest`)
 * rather than passing, because a token for an unbuilt corpus was minted against
 * something that no longer exists.
 */
export async function verifyRebuildConfirmation(
  corpusId: string,
  token: string
): Promise<RebuildConfirmationResult> {
  const manifest = await getWikiCorpusManifest(corpusId)
  if (!manifest) return { ok: false, reason: "no-manifest" }

  const separator = token.lastIndexOf(":")
  if (separator === -1) return { ok: false, reason: "corpus-mismatch" }
  const tokenCorpus = token.slice(0, separator)
  const tokenHash = token.slice(separator + 1)

  if (tokenCorpus !== corpusId) return { ok: false, reason: "corpus-mismatch" }
  if (tokenHash !== manifest.manifestHash) return { ok: false, reason: "manifest-changed" }
  return { ok: true }
}

/**
 * The manifest for Cognia's own tree. Convenience for the many call sites that
 * only ever mean the built-in corpus.
 */
export async function getSelfCorpusManifest(): Promise<WikiCorpusManifest | undefined> {
  return getWikiCorpusManifest(SELF_CORPUS_ID)
}
