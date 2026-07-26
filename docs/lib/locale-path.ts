/**
 * Locale recovery from a URL path.
 *
 * The 404 page is the one route that cannot know its locale from route params:
 * a static export has no server-side routing for unknown paths, so Cloudflare
 * Pages serves the single `out/404.html` for every miss — `/zh/docs/typo` and
 * `/en/docs/typo` land on the same file. Reading the path back is what lets
 * that one file answer in the language the reader was already browsing.
 *
 * Import-free so it stays testable from the repo's Jest runner (see the note
 * in `lib/llms-format.ts`).
 */

export function localeFromPathname(
  pathname: string,
  languages: readonly string[],
  fallback: string
): string {
  const first = pathname.split("/").find(Boolean)
  return first && languages.includes(first) ? first : fallback
}
