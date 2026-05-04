/**
 * Prompt builders for the wiki sub-agents.
 *
 * Kept in one file so the entire system-prompt surface is reviewable on a
 * single screen — we want the wiki's voice to stay consistent across
 * `ModuleArticleAgent` and `IndexPageAgent`.
 */

import type { CodeChunk, ModuleStat } from "./types"

/**
 * Shared "voice" preamble — defines the audience (LLM coding agents), the
 * format (concise structured Markdown), and the no-go list (no marketing
 * fluff, no commentary on the prompt).
 */
export const WIKI_SYSTEM_VOICE =
  "You are documenting a TypeScript codebase for downstream LLM coding agents (Claude Code, Cursor, Cline). " +
  "Your output goes directly into a wiki those agents will RAG-retrieve to understand the code. " +
  "Write in concise, structural Markdown — short headings, bullet lists for enumerations, code references " +
  "as `path/to/file.ts:line`. No marketing language, no apologies, no meta-commentary about your task. " +
  "Every claim must be grounded in the source provided; do not invent helpers, types, or APIs that aren't shown."

/**
 * Build the user prompt for `ModuleArticleAgent`. Caller passes the
 * module's identifier + the in-budget chunks. Output is plain Markdown
 * (no fenced JSON), structured as: H1 title, summary paragraph, then
 * `## What it does` / `## Public API` / `## Internals` / `## Related`
 * sections — the agent may add or omit sections as the source warrants.
 */
export function moduleArticlePrompt(input: {
  module: string
  stat: ModuleStat
  chunks: readonly CodeChunk[]
}): string {
  const lines: string[] = []
  lines.push(`Module: \`${input.module}\``)
  lines.push("")
  lines.push(`Files in this module (${input.stat.filePaths.length}):`)
  for (const path of input.stat.filePaths) lines.push(`  - ${path}`)
  lines.push("")
  lines.push("Source chunks (top-ranked by PageRank):")
  for (const chunk of input.chunks) {
    lines.push("")
    lines.push(`### ${chunk.filePath}:${chunk.lineStart}-${chunk.lineEnd}`)
    lines.push("```ts")
    lines.push(chunk.content)
    lines.push("```")
  }
  lines.push("")
  lines.push("Write a wiki article for this module. Use this Markdown skeleton:")
  lines.push("")
  lines.push("```")
  lines.push(`# ${input.module} — <one-line purpose>`)
  lines.push("")
  lines.push("<1-2 sentence summary; what the module does and who uses it>")
  lines.push("")
  lines.push("## What it does")
  lines.push("- <bullet>")
  lines.push("")
  lines.push("## Public API")
  lines.push("- `exportName(args): RetType` — purpose. (`path:line`)")
  lines.push("")
  lines.push("## Internals")
  lines.push("<short prose explaining how it's implemented>")
  lines.push("")
  lines.push("## Related")
  lines.push("- `lib/other/module` — relationship")
  lines.push("```")
  lines.push("")
  lines.push("Cite every claim with a `path:line` reference. Skip sections that don't apply.")
  return lines.join("\n")
}

/**
 * Build the user prompt for `IndexPageAgent`. Caller passes the article
 * summaries; output is one Markdown page with a one-line description per
 * module + a link to the article slug.
 */
export function indexPagePrompt(input: {
  articles: readonly { slug: string; module: string; summary: string; pageRank: number }[]
}): string {
  const lines: string[] = []
  lines.push("You are writing the top-level index of a Cognia code wiki.")
  lines.push("")
  lines.push(`Articles available (${input.articles.length}, ordered by pageRank):`)
  for (const a of input.articles) {
    lines.push(
      `  - [[${a.slug}]] (\`${a.module}\`) — ${a.summary.replace(/\s+/g, " ").slice(0, 200)}`
    )
  }
  lines.push("")
  lines.push("Output a Markdown page with this skeleton:")
  lines.push("")
  lines.push("```")
  lines.push("# Cognia code wiki")
  lines.push("")
  lines.push("<1-paragraph orientation: what this codebase is, how it's organized>")
  lines.push("")
  lines.push("## Top-level subsystems")
  lines.push("")
  lines.push("- **`lib/twin/`** — <one line>. See [[lib-twin]].")
  lines.push("- **`lib/wiki/`** — <one line>. See [[lib-wiki]].")
  lines.push("```")
  lines.push("")
  lines.push(
    "Group related modules under H2 headings (e.g. all `lib/twin/*` together). Use the [[slug]] link " +
      "syntax — the wiki renderer resolves these to article URLs."
  )
  return lines.join("\n")
}
