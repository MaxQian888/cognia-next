/**
 * Narrow an untrusted `?panel=` deep-link value to a known panel id.
 *
 * Gateway and External Bridge each shipped their own copy of this three-line
 * function plus its `PANEL_IDS` set. It is not the duplication that matters so
 * much as what a divergent copy would mean: this is the boundary where a URL
 * from anywhere becomes an id the section indexes panels by.
 */
export function resolvePanelId<Id extends string>(
  raw: string | null | undefined,
  known: ReadonlySet<string>,
  fallback: Id
): Id {
  return raw && known.has(raw) ? (raw as Id) : fallback
}

/** The id set `resolvePanelId` checks against, built from a nav's flat items. */
export function panelIdSet(items: readonly { id: string }[]): ReadonlySet<string> {
  return new Set(items.map((item) => item.id))
}
