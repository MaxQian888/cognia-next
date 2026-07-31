/**
 * Wiki Lint runner — loads a scope's articles from Dexie, runs the pure
 * {@link lintWikiArticles} pass, and persists the singleton result row.
 *
 * Unlike `rebuild-runner.ts` this needs no filesystem or LLM — it reads only
 * Dexie — so it runs in web mode too (it just finds zero articles when no
 * rebuild has populated the wiki).
 */

import { listWikiArticlesByScope } from "@/lib/db/wiki-articles"
import { upsertWikiLintResult } from "@/lib/db/wiki-lint-results"
import { lintWikiArticles } from "./wiki-lint"
import type { WikiLintResult, WikiScope } from "@/types/wiki"

export async function runWikiLint(scope: WikiScope = "cognia-self"): Promise<WikiLintResult> {
  const articles = await listWikiArticlesByScope(scope)
  const result = lintWikiArticles(scope, articles, Date.now())
  await upsertWikiLintResult(result)
  return result
}
