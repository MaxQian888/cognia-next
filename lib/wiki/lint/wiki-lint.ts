/**
 * Wiki Lint — a pure, no-AI health check over the compiled wiki.
 *
 * Two structural defects the CrossRefAgent can't self-detect (it only *adds*
 * `[[slug]]` links, never audits them):
 *
 *   • **Broken links** — an article body contains `[[slug]]` pointing at a slug
 *     no article owns (reuses {@link findDeadLinks} from the cross-ref agent).
 *   • **Orphans** — an article that no *other* article links to. Self-references
 *     don't count; the index page is not a persisted `WikiArticle`, so its
 *     links can't rescue an orphan (which keeps the check honest).
 */

import { findDeadLinks } from "@/lib/wiki/agents/cross-ref-agent"
import type { WikiArticle, WikiLintResult, WikiScope } from "@/types/wiki"

/** Collect the distinct `[[slug]]` link targets referenced in a body. */
export function collectReferencedSlugs(body: string): string[] {
  const re = /\[\[([\w-]+)\]\]/g
  const out = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = re.exec(body)) !== null) out.add(match[1])
  return Array.from(out)
}

/**
 * Lint a scope's articles. Pure — `now` is injected so the result is
 * deterministic in tests.
 */
export function lintWikiArticles(
  scope: WikiScope,
  articles: readonly WikiArticle[],
  now: number
): WikiLintResult {
  const allSlugs = articles.map((a) => a.slug)

  // Build the set of slugs that receive an inbound link from a *different*
  // article.
  const inbound = new Set<string>()
  for (const article of articles) {
    for (const slug of collectReferencedSlugs(article.contentMd)) {
      if (slug !== article.slug) inbound.add(slug)
    }
  }

  const brokenLinks: WikiLintResult["brokenLinks"] = []
  const orphans: WikiLintResult["orphans"] = []
  for (const article of articles) {
    const dead = findDeadLinks(article.contentMd, allSlugs)
    if (dead.length > 0) {
      brokenLinks.push({ slug: article.slug, title: article.title, deadLinks: dead })
    }
    if (!inbound.has(article.slug)) {
      orphans.push({ slug: article.slug, title: article.title })
    }
  }

  return {
    scope,
    lastRunAt: now,
    articleCount: articles.length,
    brokenLinks,
    orphans,
  }
}
