/**
 * `/search <text>` — scrollback search over the committed transcript cells.
 *
 * The Ink `<Static>` transcript can't be scrolled in place, so search is a
 * "find + peek": the pure {@link searchCells} matcher (in `format/`) runs over
 * `ctx.state.cells`, and the hits are rendered into the scrollable document
 * pager. Pure handler — no App/overlay-kind changes — so it unit-tests under the
 * `.ts` coverage gate.
 */
import { searchCells } from "../format/scrollback-search"
import type { CommandDescriptor, CommandEffect, CommandContext } from "./types"

/** Render the search hits into a markdown document for the pager. */
export function buildSearchDocument(query: string, hits: ReturnType<typeof searchCells>): string {
  const lines: string[] = [
    `# Search: ${query}`,
    "",
    `${hits.length} match${hits.length === 1 ? "" : "es"}`,
    "",
  ]
  for (const hit of hits) {
    lines.push(`- **${hit.kind}** · ${hit.excerpt}`)
  }
  return lines.join("\n")
}

/** Pure `/search` handler. */
export function searchHandler(ctx: CommandContext): CommandEffect {
  const query = ctx.args.trim()
  if (!query) {
    return { kind: "notice", message: "Usage: /search <text>" }
  }
  const hits = searchCells(ctx.state.cells, query)
  if (hits.length === 0) {
    return { kind: "notice", message: `No matches for "${query}".` }
  }
  return {
    kind: "openOverlay",
    overlay: {
      kind: "document",
      title: `Search: ${query} (${hits.length})`,
      body: buildSearchDocument(query, hits),
      format: "markdown",
    },
  }
}

export const SEARCH_COMMANDS: CommandDescriptor[] = [
  {
    name: "search",
    aliases: ["find"],
    description: "search the transcript and open matches in the pager",
    category: "system",
    argumentHint: "<text>",
    handler: searchHandler,
  },
]
