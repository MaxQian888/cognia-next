/**
 * Telling apart scheduled items that share a display name.
 *
 * Two `demo-heartbeat` tasks ("Paused 18 hours ago" / "Paused Jul 13, 2026")
 * rendered identically. The scheduler list and the ⌘K palette both answer it
 * the same way: only when a name is shared, show the item's kind and its
 * stable source id next to it. One module so the two surfaces cannot drift
 * into different rules for "shared" or different identity strings.
 */

/** Names carried by more than one item. Exact, case-sensitive match. */
export function duplicateNames(items: Iterable<{ name: string }>): ReadonlySet<string> {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.name, (counts.get(item.name) ?? 0) + 1)
  const shared = new Set<string>()
  for (const [name, count] of counts) if (count > 1) shared.add(name)
  return shared
}

/**
 * The identity line for a same-named item: its (already localized) kind label
 * and its stable source id, e.g. "App · 3f9c…". The id is shown verbatim: it is
 * the one thing guaranteed to differ.
 */
export function scheduledIdentityLabel(kindLabel: string, sourceId: string): string {
  return `${kindLabel} · ${sourceId}`
}
