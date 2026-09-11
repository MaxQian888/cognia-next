/**
 * `/search <text>` — scrollback search over the committed transcript cells.
 *
 * The Ink `<Static>` transcript can't be scrolled in place, so search is a
 * "find + peek": the pure {@link searchCells} matcher (in `format/`) runs over
 * `ctx.state.cells`, and the hits are rendered into the scrollable document
 * pager. Pure handler — no App/overlay-kind changes — so it unit-tests under the
 * `.ts` coverage gate.
 */
import { createCliTranslator, type CliLocale } from "../i18n"
import { searchCells } from "../format/scrollback-search"
import type { CommandDescriptor, CommandEffect, CommandContext } from "./types"

/** Render literal excerpts and source locations for the pager. */
export function buildSearchDocument(
  query: string,
  hits: ReturnType<typeof searchCells>,
  locale?: CliLocale
): string {
  const t = createCliTranslator(locale, "cliUiCommands")
  const lines = [
    t("searchTitle", { query }),
    "",
    t(hits.length === 1 ? "searchMatch" : "searchMatches", { count: hits.length }),
    "",
  ]
  for (const hit of hits) {
    lines.push(
      `${t(`searchKind_${hit.kind}`)} · ${t("searchLocation", { id: hit.cellId, line: hit.lineIndex + 1 })}`,
      hit.excerpt,
      ""
    )
  }
  return lines.join("\n")
}

/** Pure `/search` handler. */
export function searchHandler(ctx: CommandContext): CommandEffect {
  const t = createCliTranslator(ctx.config.locale, "cliUiCommands")
  const query = ctx.args.trim()
  if (!query) {
    return {
      kind: "openForm",
      form: {
        title: t("searchForm"),
        commandName: "search",
        specs: [
          {
            name: "query",
            label: t("searchQuery"),
            type: "string",
            required: true,
            style: "positional",
          },
        ],
      },
    }
  }
  const hits = searchCells(ctx.state.cells, query)
  if (hits.length === 0) {
    return { kind: "notice", message: t("searchNoMatches", { query }) }
  }
  return {
    kind: "openOverlay",
    overlay: {
      kind: "document",
      title: `${t("searchTitle", { query })} (${hits.length})`,
      body: buildSearchDocument(query, hits, ctx.config.locale),
      format: "text",
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
