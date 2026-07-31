/**
 * Fetch a page's Markdown twin and put it on the clipboard.
 *
 * Split out from the button so the failure modes are testable: the twin is a
 * separate static file (`/md/{lang}/**.md`), so it can 404 independently of
 * the page the reader is on, and `navigator.clipboard` is unavailable on
 * insecure origins. Both must degrade to a visible "failed" rather than an
 * unhandled rejection.
 *
 * Import-free so it stays testable from the repo's Jest runner (see the note
 * in `lib/llms-format.ts`).
 */

export type CopyResult = "copied" | "failed"

export type CopyMarkdownDeps = {
  fetch: (input: string) => Promise<{ ok: boolean; text: () => Promise<string> }>
  writeText: (value: string) => Promise<void>
}

export async function copyMarkdown(href: string, deps: CopyMarkdownDeps): Promise<CopyResult> {
  try {
    const response = await deps.fetch(href)
    if (!response.ok) return "failed"

    const markdown = await response.text()
    if (!markdown.trim()) return "failed"

    await deps.writeText(markdown)
    return "copied"
  } catch {
    return "failed"
  }
}
