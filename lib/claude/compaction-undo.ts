// In-memory registry of pre-compaction snapshots, keyed by the compact-boundary
// message id. Backs the "Undo compaction" action.
//
// Why in-memory (not Dexie): a compaction can only be undone while the sidecar
// session that holds the conversation is still alive — after a restart the
// in-process conversation is gone, so a persisted snapshot would have nothing to
// restore into. Keeping snapshots in memory naturally scopes undo to the live
// session and avoids persisting a full conversation copy per boundary (which
// would double message storage). After a reload the registry is empty → the
// undo button is hidden, matching the live-session-only contract.

/** A recorded pre-compaction snapshot (mirrors the data on CompressionHistoryEntry). */
export interface CompactionUndoEntry {
  /** The compact-boundary message id. */
  token: string
  /** Strategy that produced the compaction (for display). */
  strategy?: string
  /** Token counts before / after, for the history record. */
  tokensBefore?: number
  tokensAfter?: number
  /** Epoch ms the snapshot was captured. */
  createdAt: number
  /** Sidecar-format pre-compaction conversation (NOT renderer UIMessages). */
  snapshot: unknown[]
}

const registry = new Map<string, CompactionUndoEntry>()

export function registerUndoSnapshot(entry: CompactionUndoEntry): void {
  registry.set(entry.token, entry)
}

export function getUndoSnapshot(token: string): CompactionUndoEntry | undefined {
  return registry.get(token)
}

export function hasUndoSnapshot(token: string): boolean {
  return registry.has(token)
}

export function clearUndoSnapshot(token: string): void {
  registry.delete(token)
}

/** Drop every snapshot for a session's boundary ids (used on session teardown). */
export function clearUndoSnapshots(tokens: Iterable<string>): void {
  for (const t of tokens) registry.delete(t)
}

export function __resetUndoRegistryForTesting(): void {
  registry.clear()
}
