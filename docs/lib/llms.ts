/**
 * LLM-facing plain-Markdown surface for the docs site.
 *
 * Three routes consume this module:
 *   - `/llms.txt`               — the llms.txt index (built by fumadocs' own
 *                                 `llms()` page-tree renderer, not hand-rolled)
 *   - `/{lang}/llms-full.txt`   — every page of one locale, concatenated
 *   - `/md/{lang}/{...slug}.md` — one page's Markdown twin
 *
 * The `.md` suffix on the per-page route is load-bearing: a static export
 * writes route handlers to disk at their pathname, and Cloudflare Pages
 * content-types by file extension. Without the suffix the file has no
 * extension and gets served as a download instead of readable text.
 *
 * Pure formatting lives in `lib/llms-format.ts` — see the note there.
 */

import { llms, type InferPageType } from "fumadocs-core/source"

import { source } from "@/lib/source"
import { absoluteUrl } from "@/lib/site"
import { LLMS_FULL_SEPARATOR, renderPageMarkdown, toMarkdownSlug } from "@/lib/llms-format"

export type DocsPage = InferPageType<typeof source>

async function pageToMarkdown(page: DocsPage): Promise<string> {
  return renderPageMarkdown({
    title: page.data.title,
    description: page.data.description,
    url: absoluteUrl(page.url),
    // Requires `postprocess.includeProcessedMarkdown` on the docs collection
    // (source.config.ts) — without it this call throws at build time.
    content: await page.data.getText("processed"),
  })
}

export async function getPageMarkdown(lang: string, slugs: string[]): Promise<string | null> {
  const page = source.getPage(slugs, lang)
  return page ? pageToMarkdown(page) : null
}

/** Static params for every page's Markdown twin, across every locale. */
export function markdownRouteParams(): { lang: string; slug: string[] }[] {
  return source.getLanguages().flatMap(({ language, pages }) =>
    pages.map((page) => ({
      lang: language,
      slug: toMarkdownSlug(page.slugs),
    }))
  )
}

/**
 * `/llms.txt` — a link index of every page, per locale. `llms()` walks the
 * page tree, so the output inherits the sidebar's grouping and ordering
 * instead of a flat alphabetical dump.
 */
export function renderLlmsIndex(languages: string[]): string {
  const index = llms(source)
  return languages.map((language) => index.index(language)).join("\n\n")
}

/** `/{lang}/llms-full.txt` — the whole locale as one Markdown document. */
export async function renderLlmsFullText(lang: string): Promise<string> {
  const rendered = await Promise.all(source.getPages(lang).map(pageToMarkdown))
  return rendered.join(LLMS_FULL_SEPARATOR)
}
