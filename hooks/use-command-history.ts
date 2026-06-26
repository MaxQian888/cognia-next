"use client"

// Generic shell-style ↑/↓ command-history recall for plain <Input>/<Textarea>
// surfaces that are NOT the main chat composer (which keeps its own
// session-persisted history via `components/chat/composer/hooks/use-input-history`).
//
// Engagement mirrors a terminal / readline:
//   ↑ recalls the previous entry when the caret is on the FIRST line
//   ↓ walks forward and, past the newest, restores the live draft stashed
//     when recall began
//
// The first/last-line gate is the key to not conflicting with a multi-line
// textarea's own caret movement: for a single-line <Input> "first/last line"
// is always true, so ↑/↓ recall directly (the canonical command-input feel);
// for a multi-line <Textarea> the arrows only hijack at the text edges and let
// normal line navigation happen in the middle.
//
// Entries are de-duplicated (most-recent wins, moved to front) and, when a
// `persistKey` is supplied, mirrored to localStorage (capped) so history
// survives reloads across the browser / Tauri / Capacitor webviews. All
// storage access is guarded — quota errors or a disabled store degrade to
// in-memory only.

import { useCallback, useEffect, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"

export type RecallDirection = "up" | "down"

export interface CommandHistoryRecallOptions {
  /** Current input value (stashed when recall begins). */
  value: string
  /** Caret offset (selectionStart). Drives the first/last-line gate. */
  caret: number
  /**
   * Whether the selection is collapsed (no active range). Recall stays
   * disabled while text is selected so ↑/↓ can extend/clear a selection
   * normally. Defaults to `true` (treated as collapsed) when omitted.
   */
  collapsed?: boolean
}

export interface UseCommandHistory {
  /**
   * Handle an arrow key. Returns the value the caller should apply (and
   * `preventDefault` for), or `null` to let the default arrow behavior run.
   */
  recall: (dir: RecallDirection, opts: CommandHistoryRecallOptions) => string | null
  /** Note a user edit (typing) — exits recall mode so the next ↑ starts fresh. */
  noteEdit: () => void
  /** Persist a submitted entry and prepend it to history. */
  record: (text: string) => void
  /** Number of history entries currently retained. */
  size: number
}

export interface UseCommandHistoryConfig {
  /** localStorage key for cross-reload persistence. Omit for in-memory only. */
  persistKey?: string
  /** Max entries retained (newest kept). Default 50. */
  limit?: number
}

const DEFAULT_LIMIT = 50

/** True when no newline precedes the caret (caret sits on the first visual line). */
function onFirstLine(value: string, caret: number): boolean {
  return value.lastIndexOf("\n", caret - 1) === -1
}

/** True when no newline follows the caret (caret sits on the last visual line). */
function onLastLine(value: string, caret: number): boolean {
  return value.indexOf("\n", caret) === -1
}

function loadPersisted(key: string | undefined, limit: number): string[] {
  if (!key || typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === "string").slice(0, limit)
  } catch {
    return []
  }
}

function savePersisted(key: string | undefined, entries: string[]): void {
  if (!key || typeof window === "undefined") return
  try {
    window.localStorage.setItem(key, JSON.stringify(entries))
  } catch {
    // Quota exceeded / storage disabled — history is best-effort.
  }
}

export function useCommandHistory(config: UseCommandHistoryConfig = {}): UseCommandHistory {
  const { persistKey, limit = DEFAULT_LIMIT } = config
  // entries[0] = newest.
  const [entries, setEntries] = useState<string[]>(() => loadPersisted(persistKey, limit))
  // -1 = not navigating; otherwise index into `entries`.
  const cursorRef = useRef(-1)
  // The live draft stashed when navigation began; restored on ↓ past newest.
  const stashRef = useRef<string | null>(null)

  // Reload (and reset navigation) when the persistence key changes — e.g.
  // switching git repo, remote session, etc. localStorage reads are
  // synchronous, so there's no late-resolve race to guard against.
  const didMount = useRef(false)
  useEffect(() => {
    // Skip the first run: the useState initializer already loaded the initial
    // key, so re-loading on mount would be a redundant re-render.
    if (!didMount.current) {
      didMount.current = true
      return
    }
    cursorRef.current = -1
    stashRef.current = null
    // Synchronous re-load on key change is intentional (localStorage is sync,
    // so there's no async seam to defer through, unlike the session-history hook).

    setEntries(loadPersisted(persistKey, limit))
  }, [persistKey, limit])

  const recall = useCallback(
    (dir: RecallDirection, opts: CommandHistoryRecallOptions): string | null => {
      if (opts.collapsed === false) return null
      const cursor = cursorRef.current
      if (dir === "up") {
        // Only step history from the first line; elsewhere let the caret move
        // up within a (multi-line) value.
        if (!onFirstLine(opts.value, opts.caret)) return null
        if (cursor === -1) {
          if (entries.length === 0) return null
          stashRef.current = opts.value
          cursorRef.current = 0
          return entries[0]
        }
        cursorRef.current = Math.min(cursor + 1, entries.length - 1)
        return entries[cursorRef.current]
      }
      // down
      if (cursor === -1) return null
      // Only step forward from the last line; elsewhere let the caret move down.
      if (!onLastLine(opts.value, opts.caret)) return null
      if (cursor === 0) {
        cursorRef.current = -1
        const stashed = stashRef.current ?? ""
        stashRef.current = null
        return stashed
      }
      cursorRef.current = cursor - 1
      return entries[cursorRef.current]
    },
    [entries]
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
      setEntries((prev) => {
        if (prev[0] === trimmed) return prev
        const next = [trimmed, ...prev.filter((e) => e !== trimmed)].slice(0, limit)
        savePersisted(persistKey, next)
        return next
      })
    },
    [persistKey, limit]
  )

  return { recall, noteEdit, record, size: entries.length }
}

/**
 * Wire ↑/↓ command-history recall into an `<input>`/`<textarea>` keydown
 * handler. Returns `true` when the keystroke was consumed (history navigated);
 * the caller should `return` early. Returns `false` to let the keystroke fall
 * through to the rest of the handler (submit, line movement, etc.).
 *
 * Reads the live DOM value/selection off the event target, so the caller does
 * not have to thread the controlled value in. After applying a recalled value
 * it restores focus and parks the caret at the end on the next frame (a
 * controlled re-render would otherwise reset the selection).
 */
export function handleHistoryArrowKey(
  e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  history: UseCommandHistory,
  setValue: (value: string) => void
): boolean {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return false
  // Don't fight the IME candidate window mid-composition.
  if (e.nativeEvent.isComposing) return false
  const el = e.currentTarget
  const caret = el.selectionStart ?? el.value.length
  const next = history.recall(e.key === "ArrowUp" ? "up" : "down", {
    value: el.value,
    caret,
    collapsed: el.selectionStart === el.selectionEnd,
  })
  if (next === null) return false
  e.preventDefault()
  setValue(next)
  // The captured `el` is the live DOM node (only the synthetic event's
  // currentTarget is nulled after dispatch), so it stays valid in the frame.
  requestAnimationFrame(() => {
    try {
      el.setSelectionRange(next.length, next.length)
      el.focus()
    } catch {
      // Element detached between frames — nothing to focus.
    }
  })
  return true
}
