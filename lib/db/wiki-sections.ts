/**
 * CRUD layer for the `wikiSections` Dexie table (v17).
 *
 * One article fans out into N sections; each section is a heading-rooted
 * Markdown subtree. Storing sections separately lets the orchestrator do
 * partial regeneration (re-write one section without touching the rest) and
 * gives `rag_search` a finer retrieval unit when a query hits one heading
 * within an article.
 *
 * Cascade-delete is owned by `lib/db/wiki-articles.ts:deleteWikiArticle` —
 * this module only exposes pure section reads/writes.
 */

import type { WikiSection } from "@/types/wiki"
import { getDb } from "./schema"

function newId(): string {
  return "wks_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export type WikiSectionDraft = Omit<WikiSection, "id"> & Partial<Pick<WikiSection, "id">>

export async function createWikiSection(draft: WikiSectionDraft): Promise<WikiSection> {
  const row: WikiSection = {
    id: draft.id ?? newId(),
    corpusId: draft.corpusId,
    articleId: draft.articleId,
    sectionIndex: draft.sectionIndex,
    headingPath: draft.headingPath,
    bodyMd: draft.bodyMd,
    sourceRefs: draft.sourceRefs,
  }
  await getDb().wikiSections.add(row)
  return row
}

export async function bulkCreateWikiSections(drafts: WikiSectionDraft[]): Promise<WikiSection[]> {
  if (drafts.length === 0) return []
  const rows: WikiSection[] = drafts.map((draft) => ({
    id: draft.id ?? newId(),
    corpusId: draft.corpusId,
    articleId: draft.articleId,
    sectionIndex: draft.sectionIndex,
    headingPath: draft.headingPath,
    bodyMd: draft.bodyMd,
    sourceRefs: draft.sourceRefs,
  }))
  await getDb().wikiSections.bulkAdd(rows)
  return rows
}

export async function getWikiSection(id: string): Promise<WikiSection | undefined> {
  return getDb().wikiSections.get(id)
}

/** Returns sections for an article in `sectionIndex` order. */
export async function listWikiSectionsByArticle(articleId: string): Promise<WikiSection[]> {
  return getDb().wikiSections.where("articleId").equals(articleId).sortBy("sectionIndex")
}

export async function updateWikiSection(
  id: string,
  patch: Partial<Omit<WikiSection, "id" | "articleId">>
): Promise<WikiSection | undefined> {
  await getDb().wikiSections.update(id, patch as Partial<WikiSection>)
  return getDb().wikiSections.get(id)
}

export async function deleteWikiSection(id: string): Promise<void> {
  await getDb().wikiSections.delete(id)
}

/** Used by the orchestrator's partial-regeneration path. */
export async function deleteWikiSectionsByArticle(articleId: string): Promise<number> {
  return getDb().wikiSections.where("articleId").equals(articleId).delete()
}
