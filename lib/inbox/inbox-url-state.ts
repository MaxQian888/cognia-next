/**
 * The Inbox's URL-held view state: how the list is grouped, which
 * conversation the triage pane previews, and which list filters are on.
 *
 * Why the URL and not component state: every Inbox route mounts a fresh
 * `InboxShell`, so state held in React dies on each scope change (`/inbox/all`
 * → `/inbox/adapter?…`). A preview that lives in `?preview=` survives that
 * remount, can be deep-linked from a toast or ⌘K, and comes back when the user
 * opens the full chat and presses Back.
 *
 * The parse / serialize pair is pure so the hook that drives the router
 * (`hooks/inbox/use-inbox-url-state.ts`) stays a thin adapter, and so the
 * legacy `?view=` spelling can be pinned by tests without rendering anything.
 */

/** How the conversation list is sectioned. */
export type InboxGrouping = "status" | "adapter" | "platform"

export const INBOX_GROUPINGS = [
  "status",
  "adapter",
  "platform",
] as const satisfies readonly InboxGrouping[]

/** The grouping a route uses when neither the URL nor a stored choice names one. */
export const DEFAULT_INBOX_GROUPING: InboxGrouping = "status"

/** The list filters (AND-combined) the filter menu can switch on. */
export type InboxListFilter = "unread" | "pinned" | "pending" | "snoozed"

export const INBOX_LIST_FILTERS = [
  "unread",
  "pinned",
  "pending",
  "snoozed",
] as const satisfies readonly InboxListFilter[]

/**
 * The sidebar toggle used to write `?view=by-adapter|by-platform|unified` and
 * nothing read it. Links and bookmarks carrying those values still exist, so
 * they keep meaning the grouping they always claimed to pick.
 */
const LEGACY_VIEW_TO_GROUPING: Readonly<Record<string, InboxGrouping>> = {
  "by-adapter": "adapter",
  "by-platform": "platform",
  unified: "status",
}

/** The reverse map, for surfaces (the plugin sidebar slot) that still speak `view`. */
export const GROUPING_TO_LEGACY_VIEW: Readonly<Record<InboxGrouping, string>> = {
  status: "unified",
  adapter: "by-adapter",
  platform: "by-platform",
}

export const INBOX_URL_PARAMS = {
  group: "group",
  legacyView: "view",
  preview: "preview",
  filters: "f",
} as const

/** What the URL says. `group` is `null` when the URL does not choose one. */
export interface InboxUrlState {
  group: InboxGrouping | null
  preview: string | null
  filters: InboxListFilter[]
}

/** The read side of `URLSearchParams`, which `ReadonlyURLSearchParams` also satisfies. */
export interface SearchParamsReader {
  get(name: string): string | null
}

export function isInboxGrouping(value: unknown): value is InboxGrouping {
  return typeof value === "string" && (INBOX_GROUPINGS as readonly string[]).includes(value)
}

export function isInboxListFilter(value: unknown): value is InboxListFilter {
  return typeof value === "string" && (INBOX_LIST_FILTERS as readonly string[]).includes(value)
}

/**
 * Normalize a filter list: unknown tokens dropped, duplicates removed, and the
 * survivors in canonical order, so `f=pinned,unread` and `f=unread,pinned` are
 * one state and one URL.
 */
export function normalizeInboxFilters(values: Iterable<string>): InboxListFilter[] {
  // The guard is the one definition of "a filter the menu knows"; reusing it
  // keeps a URL token and a menu toggle from disagreeing about validity.
  const wanted = new Set<InboxListFilter>()
  for (const value of values) {
    const token = value.trim()
    if (isInboxListFilter(token)) wanted.add(token)
  }
  // Re-walk the canonical list (not the set) so the output order never
  // depends on the order the tokens arrived in.
  return INBOX_LIST_FILTERS.filter((filter) => wanted.has(filter))
}

export function parseInboxUrlState(params: SearchParamsReader): InboxUrlState {
  const rawGroup = params.get(INBOX_URL_PARAMS.group)
  let group: InboxGrouping | null = isInboxGrouping(rawGroup) ? rawGroup : null
  if (!group) {
    const legacy = params.get(INBOX_URL_PARAMS.legacyView)
    group = legacy ? (LEGACY_VIEW_TO_GROUPING[legacy] ?? null) : null
  }

  const rawPreview = params.get(INBOX_URL_PARAMS.preview)?.trim() ?? ""
  const rawFilters = params.get(INBOX_URL_PARAMS.filters) ?? ""

  return {
    group,
    preview: rawPreview.length > 0 ? rawPreview : null,
    filters: rawFilters ? normalizeInboxFilters(rawFilters.split(",")) : [],
  }
}

/**
 * The grouping actually in force: the URL's, else the user's stored choice,
 * else {@link DEFAULT_INBOX_GROUPING}.
 */
export function resolveInboxGrouping(
  state: Pick<InboxUrlState, "group">,
  stored?: InboxGrouping | null
): InboxGrouping {
  return state.group ?? stored ?? DEFAULT_INBOX_GROUPING
}

export type InboxUrlPatch = Partial<{
  group: InboxGrouping | null
  preview: string | null
  filters: readonly InboxListFilter[]
}>

/**
 * Apply `patch` to `current` and return the query string (no leading `?`).
 *
 * Every param the Inbox does not own (`adapterId`, `kind`, anything a future
 * route adds) is carried through untouched: the scoped routes read their scope
 * from the same query string, and dropping it would silently widen the list.
 * Writing a grouping retires the legacy `view` param so the two can never
 * disagree in one URL.
 */
export function serializeInboxUrlState(
  current: { toString(): string },
  patch: InboxUrlPatch
): string {
  const next = new URLSearchParams(current.toString())

  if ("group" in patch) {
    next.delete(INBOX_URL_PARAMS.legacyView)
    if (patch.group) next.set(INBOX_URL_PARAMS.group, patch.group)
    else next.delete(INBOX_URL_PARAMS.group)
  }

  if ("preview" in patch) {
    const preview = patch.preview?.trim()
    if (preview) next.set(INBOX_URL_PARAMS.preview, preview)
    else next.delete(INBOX_URL_PARAMS.preview)
  }

  if ("filters" in patch) {
    const filters = normalizeInboxFilters(patch.filters ?? [])
    if (filters.length > 0) next.set(INBOX_URL_PARAMS.filters, filters.join(","))
    else next.delete(INBOX_URL_PARAMS.filters)
  }

  return next.toString()
}

/** `pathname` plus the serialized query, with no dangling `?` when it is empty. */
export function buildInboxUrl(pathname: string, query: string): string {
  return query ? `${pathname}?${query}` : pathname
}
