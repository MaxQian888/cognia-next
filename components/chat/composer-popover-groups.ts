// Pure grouping helpers for the slash-command popover's EMPTY-query view:
// Pinned → Recent → per-category groups, each command appearing exactly once.
// Kept framework-free so the ordering can be unit-tested without rendering.

import type { SlashCommand } from "@/lib/slash-commands/builtin"

/** Group tag carried by a slash item so the popover paints a section header. */
export type SlashGroup = "pinned" | "recent" | `cat:${string}`

export interface GroupedCommand {
  command: SlashCommand
  group: SlashGroup
}

/** Preferred category order; unknown categories follow alphabetically, "other" last. */
const CATEGORY_ORDER = ["chat", "system", "template", "diagnostics", "goal", "help"]

/**
 * Order commands for the empty-query picker: pinned first (in pin order), then
 * recently used (newest first, minus pinned), then everything else grouped by
 * `category`. A command shows once — pinned/recent are not repeated in their
 * category group. `recent`/`pinned` names that no longer resolve are skipped.
 */
export function orderedCommandsForEmptyQuery(
  commands: readonly SlashCommand[],
  recent: readonly string[],
  pinned: readonly string[]
): GroupedCommand[] {
  const byName = new Map(commands.map((c) => [c.name, c]))
  const used = new Set<string>()
  const out: GroupedCommand[] = []

  const take = (name: string, group: SlashGroup): void => {
    const command = byName.get(name)
    if (command && !used.has(name)) {
      out.push({ command, group })
      used.add(name)
    }
  }

  for (const name of pinned) take(name, "pinned")
  for (const name of recent) take(name, "recent")

  // Remaining commands grouped by category, preserving input order within a group.
  const cats = new Map<string, SlashCommand[]>()
  for (const c of commands) {
    if (used.has(c.name)) continue
    const cat = c.category || "other"
    const bucket = cats.get(cat)
    if (bucket) bucket.push(c)
    else cats.set(cat, [c])
  }

  const known = CATEGORY_ORDER.filter((c) => cats.has(c))
  const extra = [...cats.keys()].filter((c) => !CATEGORY_ORDER.includes(c) && c !== "other").sort()
  const orderedCats = [...known, ...extra, ...(cats.has("other") ? ["other"] : [])]

  for (const cat of orderedCats) {
    for (const c of cats.get(cat) ?? []) out.push({ command: c, group: `cat:${cat}` })
  }
  return out
}

/** Capitalize the first letter — fallback label for an untranslated category. */
function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1)
}

/**
 * Resolve a section header label for a slash group. Pinned/Recent and the known
 * categories come from i18n; an unknown category falls back to its capitalized
 * raw name. `t` is the `chat.composer.popover` translator; `safeLookup` returns
 * the fallback when a key is missing.
 */
export function slashGroupLabel(
  group: SlashGroup,
  t: (key: string, params?: Record<string, string | number | Date>) => string,
  safeLookup: (
    t: (key: string, params?: Record<string, string | number | Date>) => string,
    key: string,
    fallback: string
  ) => string
): string {
  if (group === "pinned") return safeLookup(t, "pinnedSection", "Pinned")
  if (group === "recent") return safeLookup(t, "recentSection", "Recent")
  const cat = group.slice(4)
  return safeLookup(t, `categories.${cat}`, capitalize(cat))
}
