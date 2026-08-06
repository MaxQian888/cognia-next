/**
 * Command output folding state manager.
 *
 * Tracks which command blocks (identified by session id + command index)
 * are currently collapsed in the terminal gutter. The state is transient
 * (not persisted) — a page reload unfolds everything.
 *
 * Command boundaries come from OSC 633 integration events that the
 * terminal already captures. Each command boundary has a start line and
 * an end line (or unbounded if still running). Folding hides the output
 * between command-start and the next prompt-start.
 */

/** Unique key for a foldable command block. */
export interface FoldKey {
  sessionId: string
  /** 0-based index into the session's command history. */
  commandIndex: number
}

/** Serialize a FoldKey to a string for Set/Map usage. */
export function foldKeyStr(key: FoldKey): string {
  return `${key.sessionId}:${key.commandIndex}`
}

/** Parse a serialized fold key. Returns null on invalid input. */
export function parseFoldKey(str: string): FoldKey | null {
  const colonIdx = str.indexOf(":")
  if (colonIdx <= 0) return null
  const sessionId = str.slice(0, colonIdx)
  const commandIndex = Number(str.slice(colonIdx + 1))
  if (!Number.isFinite(commandIndex) || commandIndex < 0) return null
  return { sessionId, commandIndex }
}

/**
 * Manage fold state for multiple sessions. Pure in-memory state — no
 * persistence, no side effects.
 */
export class OutputFoldState {
  private folded = new Set<string>()

  /** Check if a command block is currently folded. */
  isFolded(key: FoldKey): boolean {
    return this.folded.has(foldKeyStr(key))
  }

  /** Fold (collapse) a command's output. */
  fold(key: FoldKey): void {
    this.folded.add(foldKeyStr(key))
  }

  /** Unfold (expand) a command's output. */
  unfold(key: FoldKey): void {
    this.folded.delete(foldKeyStr(key))
  }

  /** Toggle fold state. Returns the new state (true = folded). */
  toggle(key: FoldKey): boolean {
    const str = foldKeyStr(key)
    if (this.folded.has(str)) {
      this.folded.delete(str)
      return false
    }
    this.folded.add(str)
    return true
  }

  /** Get all folded keys for a given session. */
  foldedForSession(sessionId: string): FoldKey[] {
    const result: FoldKey[] = []
    for (const str of this.folded) {
      const key = parseFoldKey(str)
      if (key && key.sessionId === sessionId) result.push(key)
    }
    return result
  }

  /** Count of folded blocks for a session. */
  foldedCount(sessionId: string): number {
    let count = 0
    for (const str of this.folded) {
      if (str.startsWith(sessionId + ":")) count++
    }
    return count
  }

  /** Unfold all blocks for a session (e.g. on session close). */
  unfoldAll(sessionId: string): void {
    for (const str of [...this.folded]) {
      if (str.startsWith(sessionId + ":")) this.folded.delete(str)
    }
  }

  /** Clear all fold state. */
  reset(): void {
    this.folded.clear()
  }

  /** Total number of folded blocks across all sessions. */
  get size(): number {
    return this.folded.size
  }
}
