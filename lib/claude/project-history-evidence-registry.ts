/**
 * Per-session registry of the history evidence a turn actually read.
 *
 * Mined claims reach the message fold through `opts.projectContinuityContext`,
 * because `resolveSendOptions` runs before the turn and can stash them on the
 * send record. A `project_history_search` hit has no such slot: it is produced
 * mid-turn, by a tool call, long after the options were built. This registry is
 * that missing slot — the tool deposits what it returned, keyed by the calling
 * session, and the fold picks it up when the turn lands.
 *
 * Same shape as `agents/dispatch-context-registry.ts`, and for the same reason:
 * the `plugin_tool_exec` wire carries `{sessionId, toolUseId, name, args}` and
 * nothing else, so anything a host tool needs to hand back out of band has to
 * travel through a renderer-side map keyed by session id.
 *
 * ## Draining is not optional
 *
 * {@link drainProjectHistoryEvidence} CLEARS what it returns. Without that,
 * turn N's evidence would be attached to turn N+1's message too, and the chips
 * would claim the model consulted sources it never opened — a citation that is
 * worse than no citation, because it looks verified.
 *
 * Entries hold the UNFENCED text. The fenced copy is what went to the model;
 * the chip renders to a human, and `<untrusted_content>` in a UI card is noise.
 */

/** One thing a turn read out of the workspace's history. */
export interface ProjectHistoryEvidence {
  /** Stable within a turn: the messageId, or the resultId for a tool output. */
  id: string
  kind: "message" | "result"
  sessionId: string
  messageId: string
  /** Conversation title, or the tool + what it was about. */
  title: string
  /** Unfenced excerpt, for the chip's second line. */
  snippet: string
  createdAt: number
}

/**
 * Cap per session.
 *
 * A turn may call the tool several times, and each call can surface two full
 * legs. Beyond this the chip row stops being a citation list and becomes a log,
 * so the OLDEST entries are dropped — the most recent search is the one whose
 * evidence the answer actually rests on.
 */
export const MAX_HISTORY_EVIDENCE_PER_SESSION = 24

const registry = new Map<string, ProjectHistoryEvidence[]>()

/** Record what one `project_history_search` call returned. */
export function recordProjectHistoryEvidence(
  sessionId: string,
  evidence: readonly ProjectHistoryEvidence[]
): void {
  if (!sessionId || evidence.length === 0) return
  const existing = registry.get(sessionId) ?? []
  const byId = new Map(existing.map((entry) => [entry.id, entry]))
  for (const entry of evidence) byId.set(entry.id, entry)
  const merged = [...byId.values()]
  registry.set(
    sessionId,
    merged.length > MAX_HISTORY_EVIDENCE_PER_SESSION
      ? merged.slice(merged.length - MAX_HISTORY_EVIDENCE_PER_SESSION)
      : merged
  )
}

/** Take a session's evidence AND clear it. Called once per turn by the fold. */
export function drainProjectHistoryEvidence(sessionId: string): ProjectHistoryEvidence[] {
  if (!sessionId) return []
  const entries = registry.get(sessionId)
  if (!entries || entries.length === 0) return []
  registry.delete(sessionId)
  return entries
}

/**
 * Drop a session's evidence without reading it.
 *
 * For an aborted turn: the search ran, the answer never landed, and holding the
 * hits would attach them to whatever the user sends next.
 */
export function clearProjectHistoryEvidence(sessionId: string): void {
  registry.delete(sessionId)
}

/** Test-only: wipe the registry between cases. */
export function __clearAllProjectHistoryEvidenceForTesting(): void {
  registry.clear()
}
