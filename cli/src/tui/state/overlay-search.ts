/**
 * Per-overlay typeahead filtering for the reducer-owned searchable overlays
 * (generic `select`, `sessions`, `inspect`, and the `/menu` command palette).
 * Each helper projects a row to the same haystack the renderer shows, so the
 * reducer's length/index math and the on-screen filtered list stay in lockstep
 * (a mismatch would let the highlight range over hidden rows). Pure.
 */
import { filterRowsByQuery } from "../components/select-list-state"
import type { ProviderOption } from "../commands/provider-options"
import type { InspectItem, QuickActionRow, SelectItem, SessionSummary } from "./types"

/**
 * Lists at or above this length get a 🔎 search row; shorter ones stay plain to
 * avoid chrome noise on a handful of rows.
 */
export const SEARCHABLE_MIN = 8

export const filterSelectItems = (items: SelectItem[], query: string): SelectItem[] =>
  filterRowsByQuery(items, query, (it) => `${it.label} ${it.hint ?? ""}`)

export const filterSessionItems = (items: SessionSummary[], query: string): SessionSummary[] =>
  filterRowsByQuery(items, query, (s) => s.title)

export const filterInspectItems = (items: InspectItem[], query: string): InspectItem[] =>
  filterRowsByQuery(items, query, (it) => `${it.label} ${it.summary ?? ""}`)

export const filterQuickActions = (rows: QuickActionRow[], query: string): QuickActionRow[] =>
  filterRowsByQuery(rows, query, (r) => `${r.label} ${r.hint ?? ""}`)

/** Match the `/provider` picker on both the display name and the catalog id, so
 * "claude" finds Anthropic and "or" finds OpenRouter. */
export const filterProviderOptions = (options: ProviderOption[], query: string): ProviderOption[] =>
  filterRowsByQuery(options, query, (p) => `${p.name} ${p.id}`)
