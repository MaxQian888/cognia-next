/**
 * CRUD layer for the `wikiLintResults` Dexie table (v95).
 *
 * One singleton row per scope (PK `&scope`), mirroring `wikiManifest`. Written
 * by `lib/wiki/lint/lint-runner.ts`; read by the settings lint card via
 * `useLiveQuery`.
 */

import type { WikiLintResult, WikiScope } from "@/types/wiki"
import { getDb } from "./schema"

export async function getWikiLintResult(scope: WikiScope): Promise<WikiLintResult | undefined> {
  return getDb().wikiLintResults.get(scope)
}

export async function upsertWikiLintResult(row: WikiLintResult): Promise<void> {
  await getDb().wikiLintResults.put(row)
}

export async function listAllWikiLintResults(): Promise<WikiLintResult[]> {
  return getDb().wikiLintResults.toArray()
}

export async function deleteWikiLintResult(scope: WikiScope): Promise<void> {
  await getDb().wikiLintResults.delete(scope)
}
