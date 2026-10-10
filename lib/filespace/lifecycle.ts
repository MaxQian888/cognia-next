/**
 * Conversation lifecycle into live file shares (ADR-0222 §10).
 *
 * The file-share host suspends a conversation's grants while it is archived,
 * resumes them when it is restored and revokes them when it is deleted, from
 * the conversation state carried by each pushed or pulled mount table. Left
 * to the minute refresh, a deleted conversation would keep serving for up to
 * a minute, so the writers that change that state announce it here and the
 * host sync pushes the affected tables at once.
 *
 * `SESSION_DELETED` on the plugin bus has no subscribers and an archive emits
 * nothing, so this is a direct call from each writer rather than a bus
 * subscription:
 *
 * - `deleteSessionsWithTeardown` (local deletes, the Host applying a paired
 *   client's delete, emptying the archive, the headless brain);
 * - `setSessionsArchived` for the conversations it writes locally (archive,
 *   restore, auto-archive);
 * - the Host-state service after it commits a paired client's archive.
 *
 * The sink is the running host-sync controller (the desktop initializer or
 * the headless runtime). Where none runs — a paired client, a browser, a
 * locked account — an announcement does nothing: that device hosts no grants.
 */

export type FileSpaceLifecycleSink = (sessionIds: readonly string[]) => Promise<void>

let sink: FileSpaceLifecycleSink | null = null

/** Install the sink; returns the function that removes it (if still installed). */
export function registerFileSpaceLifecycleSink(next: FileSpaceLifecycleSink): () => void {
  sink = next
  return () => {
    if (sink === next) sink = null
  }
}

/**
 * Tell the host these conversations changed state. Fire-and-forget: the
 * writer's own outcome never depends on the file-share host, which also
 * catches up on its next refresh.
 */
export function announceFileSpaceSessionsChanged(sessionIds: readonly string[]): void {
  const current = sink
  const ids = [...new Set(sessionIds)]
  if (!current || ids.length === 0) return
  void current(ids).catch(() => undefined)
}
