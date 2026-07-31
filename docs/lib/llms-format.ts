/**
 * Pure formatting for the LLM-facing Markdown surface.
 *
 * Deliberately import-free: the root Jest config maps `@/` to the app root,
 * not to `docs/`, so anything reaching for `@/lib/source` is untestable from
 * the repo test runner. The source-backed glue lives in `lib/llms.ts`.
 */

/** Slug used for the locale index page, which fumadocs exposes as `[]`. */
const INDEX_SLUG = "index"

const MD_EXT = ".md"

/** Doc slugs → the `.md` route's slugs (last segment carries the extension). */
export function toMarkdownSlug(slugs: string[]): string[] {
  const parts = slugs.length > 0 ? slugs : [INDEX_SLUG]
  return [...parts.slice(0, -1), `${parts[parts.length - 1]}${MD_EXT}`]
}

/** The `.md` route's slugs → doc slugs, or null when it isn't a Markdown twin. */
export function fromMarkdownSlug(slug: string[] | undefined): string[] | null {
  if (!slug || slug.length === 0) return null

  const last = slug[slug.length - 1]
  if (!last.endsWith(MD_EXT)) return null

  const stem = last.slice(0, -MD_EXT.length)
  if (!stem) return null

  const parts = [...slug.slice(0, -1), stem]
  // `index.md` is the locale root, which fumadocs addresses with empty slugs.
  return parts.length === 1 && parts[0] === INDEX_SLUG ? [] : parts
}

/** Public href of a page's Markdown twin. */
export function markdownHref(lang: string, slugs: string[]): string {
  return `/md/${lang}/${toMarkdownSlug(slugs).join("/")}`
}

export type RenderPageMarkdownInput = {
  title: string
  description?: string
  /** Canonical URL of the human-readable page. */
  url: string
  content: string
}

/**
 * One page as standalone Markdown. The frontmatter keeps the result
 * round-trippable — an agent that fetches several pages can still tell them
 * apart after concatenation.
 */
export function renderPageMarkdown({
  title,
  description,
  url,
  content,
}: RenderPageMarkdownInput): string {
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(title)}`,
    ...(description ? [`description: ${JSON.stringify(description)}`] : []),
    `url: ${JSON.stringify(url)}`,
    "---",
  ].join("\n")

  return `${frontmatter}\n\n${content.trim()}\n`
}

/** Separator between pages in the concatenated `llms-full.txt`. */
export const LLMS_FULL_SEPARATOR = "\n---\n\n"
