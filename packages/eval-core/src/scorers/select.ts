/**
 * Select a subset of scorers by id for a configured run. An empty id list
 * means "all scorers" (the default). Order follows the input `all` array, not
 * the id list, so reports keep a stable scorer ordering.
 */

import type { Scorer } from "../domain/eval"

export function selectScorers(all: Scorer[], ids: string[]): Scorer[] {
  if (!ids || ids.length === 0) return all
  const wanted = new Set(ids)
  return all.filter((s) => wanted.has(s.id))
}
