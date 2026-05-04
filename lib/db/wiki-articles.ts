/**
 * CRUD layer for the `wikiArticles` Dexie table (v17).
 *
 * Wiki articles are produced by `lib/wiki/orchestrator.ts` and consumed by the
 * MCP bridge handlers in `lib/external-bridge/handlers/wiki.ts`. The slug is
 * the canonical lookup key for `wiki_read`; `[scope+module]` powers the
 * `wiki_search` filter; `pageRank` is a tie-breaker for hybrid ranking.
 *
 * The article body lives entirely in the row (`contentMd`); per-section bodies
 * are duplicated into `wikiSections` for partial-reload hot paths and
 * section-grained citations.
 */

import type { WikiArticle, WikiScope } from "@/types/wiki"
import { getDb } from "./schema"

function newId(): string {
  return "wka_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export type WikiArticleDraft = Omit<WikiArticle, "id" | "generatedAt"> &
  Partial<Pick<WikiArticle, "id" | "generatedAt">>

export async function createWikiArticle(draft: WikiArticleDraft): Promise<WikiArticle> {
  const row: WikiArticle = {
    id: draft.id ?? newId(),
    slug: draft.slug,
    title: draft.title,
    module: draft.module,
    scope: draft.scope,
    pageRank: draft.pageRank,
    summary: draft.summary,
    sectionIds: draft.sectionIds,
    sourceRefs: draft.sourceRefs,
    contentMd: draft.contentMd,
    embedding: draft.embedding,
    generatedAt: draft.generatedAt ?? Date.now(),
    generatorVersion: draft.generatorVersion,
    fileHashes: draft.fileHashes,
  }
  await getDb().wikiArticles.add(row)
  return row
}

export async function bulkCreateWikiArticles(drafts: WikiArticleDraft[]): Promise<WikiArticle[]> {
  if (drafts.length === 0) return []
  const now = Date.now()
  const rows: WikiArticle[] = drafts.map((draft) => ({
    id: draft.id ?? newId(),
    slug: draft.slug,
    title: draft.title,
    module: draft.module,
    scope: draft.scope,
    pageRank: draft.pageRank,
    summary: draft.summary,
    sectionIds: draft.sectionIds,
    sourceRefs: draft.sourceRefs,
    contentMd: draft.contentMd,
    embedding: draft.embedding,
    generatedAt: draft.generatedAt ?? now,
    generatorVersion: draft.generatorVersion,
    fileHashes: draft.fileHashes,
  }))
  await getDb().wikiArticles.bulkAdd(rows)
  return rows
}

export async function getWikiArticle(id: string): Promise<WikiArticle | undefined> {
  return getDb().wikiArticles.get(id)
}

export async function getWikiArticleBySlug(slug: string): Promise<WikiArticle | undefined> {
  return getDb().wikiArticles.where("slug").equals(slug).first()
}

export async function listWikiArticlesByScope(scope: WikiScope): Promise<WikiArticle[]> {
  return getDb().wikiArticles.where("scope").equals(scope).reverse().sortBy("pageRank")
}

export async function listWikiArticlesByScopeAndModule(
  scope: WikiScope,
  module: string
): Promise<WikiArticle[]> {
  return getDb().wikiArticles.where(["scope", "module"]).equals([scope, module]).toArray()
}

export async function listAllWikiArticles(): Promise<WikiArticle[]> {
  return getDb().wikiArticles.toArray()
}

export async function countWikiArticlesByScope(scope: WikiScope): Promise<number> {
  return getDb().wikiArticles.where("scope").equals(scope).count()
}

export async function updateWikiArticle(
  id: string,
  patch: Partial<Omit<WikiArticle, "id">>
): Promise<WikiArticle | undefined> {
  await getDb().wikiArticles.update(id, patch as Partial<WikiArticle>)
  return getDb().wikiArticles.get(id)
}

export async function deleteWikiArticle(id: string): Promise<void> {
  // Cascade-delete the article's sections so the wikiSections table doesn't
  // accumulate orphans. The orchestrator never inserts a section without an
  // article, so this is the only delete path that needs to fan out.
  const db = getDb()
  await db.transaction("rw", db.wikiArticles, db.wikiSections, async () => {
    await db.wikiSections.where("articleId").equals(id).delete()
    await db.wikiArticles.delete(id)
  })
}

/**
 * Delete every article (and its sections) belonging to a scope. Used when the
 * orchestrator detects a `generatorVersion` change — every article from the
 * previous version is invalidated atomically.
 */
export async function deleteAllWikiArticlesForScope(scope: WikiScope): Promise<number> {
  const db = getDb()
  let deleted = 0
  await db.transaction("rw", db.wikiArticles, db.wikiSections, async () => {
    const ids = await db.wikiArticles.where("scope").equals(scope).primaryKeys()
    if (ids.length === 0) return
    await db.wikiSections
      .where("articleId")
      .anyOf(ids as string[])
      .delete()
    deleted = await db.wikiArticles.bulkDelete(ids as string[]).then(() => ids.length)
  })
  return deleted
}

/**
 * Delete articles whose `generatorVersion` does NOT match `currentVersion`.
 * Drives the "regenerate on version bump" path during orchestrator init.
 */
export async function deleteStaleWikiArticles(
  scope: WikiScope,
  currentVersion: string
): Promise<number> {
  const db = getDb()
  let deleted = 0
  await db.transaction("rw", db.wikiArticles, db.wikiSections, async () => {
    const stale = await db.wikiArticles
      .where("scope")
      .equals(scope)
      .filter((a) => a.generatorVersion !== currentVersion)
      .toArray()
    if (stale.length === 0) return
    const staleIds = stale.map((a) => a.id)
    await db.wikiSections.where("articleId").anyOf(staleIds).delete()
    await db.wikiArticles.bulkDelete(staleIds)
    deleted = staleIds.length
  })
  return deleted
}
