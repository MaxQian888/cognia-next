/**
 * How ⌘K answers "which workspace am I searching".
 *
 * # Why the default changed
 *
 * `workspace` defaulted to `all`, and only two of the nineteen providers ever
 * read it. On a machine with several workspaces that meant every search leaked
 * the others: conversations, memories and issues from a hobby repo landed in
 * the middle of a work search with nothing to say they were from somewhere
 * else. `current` is the honest default — the user is in a workspace, and that
 * is the context of almost every lookup — with `workspace:all` one token away.
 *
 * # Filter versus demote
 *
 * Entities BELONG to a workspace: a conversation, a memory, an issue. Out of
 * scope, they are noise, and filtering them out is what the user asked for.
 *
 * Definitions do not. Skills, templates and workflows are defined once for the
 * machine, and a workspace only expresses a preference about them
 * (`lib/workspace/capability-overlay.ts`). Hiding a skill because the current
 * workspace switched it off produces the worst possible search result — "I know
 * I have this and it is not there" — so they are ranked below the in-scope hits
 * instead, and stay findable.
 *
 * Global surfaces (settings, navigation, devices, people) have no workspace at
 * all and are untouched by either rule.
 */

import type { GlobalSearchContext, ParsedGlobalSearchQuery } from "./types"

/** How much of its score an out-of-scope definition keeps. */
export const DEMOTED_SCORE_FACTOR = 0.45

/**
 * The workspace to restrict to, or `null` for "every workspace".
 *
 * `null` also when the query IS scoped but no workspace is active — there is
 * nothing to scope to, and returning an id-less filter would silently match
 * nothing.
 */
export function scopedWorkspaceId(
  query: Pick<ParsedGlobalSearchQuery, "filters">,
  ctx: Pick<GlobalSearchContext, "activeProjectId">
): string | null {
  // `undefined` is the un-typed query, which now means "current" — see the
  // parser, which normalizes it so surfaces can render the chip.
  if (query.filters?.workspace === "all") return null
  return ctx.activeProjectId ?? null
}

/**
 * The common `belongs` predicate: a row that names its workspace.
 *
 * A row with NO workspace is shared, not foreign. Hiding those would lose every
 * legacy row written before the column existed, which is the failure mode that
 * makes a scoped search feel broken rather than focused.
 */
export function byProjectId<T>(
  projectIdOf: (row: T) => string | null | undefined
): (row: T, ctx: unknown, scopeId: string) => boolean {
  return (row, _ctx, scopeId) => {
    const owner = projectIdOf(row)
    return !owner || owner === scopeId
  }
}
