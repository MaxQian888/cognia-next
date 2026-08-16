// Tree helpers for Pi session files (ADR-0119 / ADR-0062 fidelity rules).
//
// A `~/.pi/agent/sessions/--<cwd>--/<ts>_<uuid>.jsonl` file is a TREE, not a
// list: every entry after the header carries an 8-char `id` and a `parentId`,
// and `/fork`, `/clone` and `/tree` all branch in place rather than writing a
// new file. Read in file order, an abandoned branch interleaves into the
// conversation.
//
// The structural work is shared with `claude-code-dag.ts` — the active-leaf
// walk there already handles the two things that are easy to get wrong (a
// cycle guard so a corrupt file cannot hang the importer, and degradation to
// file order when no entry carries an id). That helper is reused via a view
// object rather than reimplemented; only the parts Pi needs and Claude does
// not — enumerating EVERY leaf, because Pi's alternate branches import as
// nested conversations — live here.

import { linearizeActiveLeaf, type DagNode } from "./claude-code-dag"

/** The structural fields a Pi session entry contributes to the tree. */
export interface PiEntryNode {
  id?: string
  parentId?: string | null
  timestamp?: string
}

/** A Pi entry projected onto the shared DAG shape, carrying the entry along. */
interface PiNodeView<T> extends DagNode {
  entry: T
}

function toViews<T extends PiEntryNode>(entries: T[]): PiNodeView<T>[] {
  return entries.map((entry) => ({
    uuid: entry.id,
    parentUuid: entry.parentId ?? null,
    timestamp: entry.timestamp,
    entry,
  }))
}

/**
 * The chain ending at the newest leaf — Pi's "current position in the tree".
 *
 * Delegates to the shared linearizer so the cycle guard and the no-id
 * fallback stay in one place.
 */
export function piActiveChain<T extends PiEntryNode>(entries: T[]): T[] {
  return linearizeActiveLeaf(toViews(entries)).map((view) => view.entry)
}

/**
 * Every leaf id in the tree, excluding the active one, newest first.
 *
 * A leaf is an entry no other entry claims as its parent. These are the
 * abandoned or alternate branches that import as nested conversations — losing
 * them would silently discard work the user can still see in Pi's `/tree`.
 */
export function piAlternateLeafIds<T extends PiEntryNode>(entries: T[]): string[] {
  const byId = new Map<string, T>()
  for (const entry of entries) if (entry.id) byId.set(entry.id, entry)

  const claimed = new Set<string>()
  for (const entry of entries) {
    if (entry.parentId && byId.has(entry.parentId)) claimed.add(entry.parentId)
  }

  const active = piActiveChain(entries)
  const activeLeafId = active.length > 0 ? active[active.length - 1].id : undefined

  return entries
    .filter((entry) => entry.id && !claimed.has(entry.id) && entry.id !== activeLeafId)
    .sort((a, b) => parseTs(b.timestamp) - parseTs(a.timestamp))
    .map((entry) => entry.id!)
}

/**
 * Root→leaf chain for one specific leaf.
 *
 * Carries its own visited guard: a corrupt file with a parent cycle must not
 * hang the importer, and this path does not go through the shared linearizer
 * (which only ever walks the newest leaf).
 */
export function piChainToLeaf<T extends PiEntryNode>(entries: T[], leafId: string): T[] {
  const byId = new Map<string, T>()
  for (const entry of entries) if (entry.id) byId.set(entry.id, entry)

  const chain: T[] = []
  const seen = new Set<string>()
  let cursor: string | undefined = leafId

  while (cursor && byId.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor)
    const entry: T = byId.get(cursor)!
    chain.push(entry)
    cursor = entry.parentId ?? undefined
  }

  return chain.reverse()
}

function parseTs(timestamp: string | undefined): number {
  if (!timestamp) return 0
  const parsed = Date.parse(timestamp)
  return Number.isNaN(parsed) ? 0 : parsed
}
