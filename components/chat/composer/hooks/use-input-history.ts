// Shell-style ↑/↓ recall of previously sent messages for the chat composer.
// ↑ from the very start of the input walks back through history (newest first):
// this conversation's own lines, then — like a shell's shared history — the
// lines sent in every other conversation, newest first and de-duplicated. ↓
// walks forward and, past the newest entry, restores the draft that was
// stashed when recall began. Typing exits recall mode. History is persisted
// per session in Dexie (`lib/db/chat-input-history`); the composer with no
// conversation yet files under `HOME_COMPOSER_HISTORY_KEY`, so a first message
// is not lost to recall.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  HOME_COMPOSER_HISTORY_KEY,
  listInputHistory,
  listRecentInputHistory,
  recordInput,
} from "@/lib/db/chat-input-history"

export type RecallDirection = "up" | "down"

export interface RecallOptions {
  /** Current textarea value (stashed when recall begins). */
  value: string
  /** True when the caret is at the absolute start (selectionStart/End === 0). */
  caretAtStart: boolean
}

export interface UseInputHistory {
  /**
   * Handle an arrow key. Returns the value the caller should set (and
   * preventDefault for), or null to let the default arrow behavior happen.
   */
  recall: (dir: RecallDirection, opts: RecallOptions) => string | null
  /** Note a user edit (typing) — exits recall mode so ↑ starts fresh. */
  noteEdit: () => void
  /** Persist a sent message and optimistically prepend it to history. */
  record: (text: string) => void
  /** Number of history entries currently loaded for the session. */
  size: number
  /**
   * Lines from OTHER conversations that ↑ continues into once this one's run
   * out, newest first, minus any already in {@link entries}.
   */
  crossSessionEntries: readonly string[]
  /**
   * The loaded entries, NEWEST FIRST. Exposed so the inline-completion engine
   * (`hooks/chat/use-composer-ghost-text.ts`) can complete from the same
   * per-session history ↑/↓ recalls, instead of keeping a second copy.
   */
  entries: readonly string[]
}

export function useInputHistory(sessionId: string | null): UseInputHistory {
  const bucket = sessionId ?? HOME_COMPOSER_HISTORY_KEY
  const [entries, setEntries] = useState<string[]>([])
  const [otherEntries, setOtherEntries] = useState<string[]>([])
  // -1 = not navigating; otherwise index into `entries` (0 = newest).
  const cursorRef = useRef(-1)
  const stashRef = useRef<string | null>(null)
  // Set by record() so a late-resolving mount load can't clobber an entry the
  // user just sent (load vs optimistic-prepend race).
  const dirtyRef = useRef(false)

  useEffect(() => {
    cursorRef.current = -1
    stashRef.current = null
    dirtyRef.current = false
    let cancelled = false
    void listInputHistory(bucket)
      .then((list) => {
        if (!cancelled && !dirtyRef.current) setEntries(list)
      })
      .catch(() => {
        // IndexedDB unavailable (SSR / restricted env) — recall just stays empty.
        if (!cancelled && !dirtyRef.current) setEntries([])
      })
    void listRecentInputHistory(undefined, { excludeSessionId: bucket })
      .then((list) => {
        if (!cancelled) setOtherEntries(list)
      })
      .catch(() => {
        if (!cancelled) setOtherEntries([])
      })
    return () => {
      cancelled = true
    }
  }, [bucket])

  // Other conversations' lines, minus any this one already holds: walking on
  // past its own history should never offer the same line twice.
  const crossSessionEntries = useMemo(() => {
    const own = new Set(entries)
    return otherEntries.filter((text) => !own.has(text))
  }, [entries, otherEntries])
  const walk = useMemo(() => [...entries, ...crossSessionEntries], [entries, crossSessionEntries])

  const recall = useCallback(
    (dir: RecallDirection, opts: RecallOptions): string | null => {
      const cursor = cursorRef.current
      if (dir === "up") {
        if (cursor === -1) {
          if (!opts.caretAtStart || walk.length === 0) return null
          stashRef.current = opts.value
          cursorRef.current = 0
          return walk[0]
        }
        cursorRef.current = Math.min(cursor + 1, walk.length - 1)
        return walk[cursorRef.current]
      }
      // down
      if (cursor === -1) return null
      if (cursor === 0) {
        cursorRef.current = -1
        const stashed = stashRef.current ?? ""
        stashRef.current = null
        return stashed
      }
      cursorRef.current = cursor - 1
      return walk[cursorRef.current]
    },
    [walk]
  )

  const noteEdit = useCallback(() => {
    cursorRef.current = -1
    stashRef.current = null
  }, [])

  const record = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      cursorRef.current = -1
      stashRef.current = null
      if (!trimmed) return
      dirtyRef.current = true
      setEntries((prev) => (prev[0] === trimmed ? prev : [trimmed, ...prev]))
      void recordInput(bucket, trimmed).catch(() => {})
    },
    [bucket]
  )

  return { recall, noteEdit, record, size: entries.length, entries, crossSessionEntries }
}
