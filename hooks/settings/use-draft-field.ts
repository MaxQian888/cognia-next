"use client"

/**
 * Draft-buffered text field bound to a persisted setting.
 *
 * Provider credential inputs used to be controlled straight from the settings
 * store: every keystroke ran `setProviderConfig` → a full settings-singleton
 * read-modify-write in Dexie → a store-wide `set`. Besides the write storm,
 * a controlled input whose value only updates after an async round-trip is
 * reset by React between keystrokes, so fast typing on a slow device dropped
 * characters.
 *
 * This keeps the keystrokes local and commits on the trailing edge:
 *   - `value` updates synchronously on `onChange`;
 *   - the committed setter runs after `debounceMs` of idle typing, on blur,
 *     on Enter (`onKeyDown`), and on unmount if a draft is still pending;
 *   - the draft re-hydrates when `identity` changes (a different provider is
 *     being edited) or when the committed value changes underneath a
 *     non-dirty field (import/export, another tab) — but never while the user
 *     has unsaved keystrokes, so an unrelated settings write cannot clobber
 *     what they are typing (same contract as `useDirtyDraft`).
 *
 * State is adjusted during render for the identity/committed transitions
 * (React 19 derive-state pattern; `react-hooks/set-state-in-effect` is
 * enforced in this repo).
 */

import { useCallback, useEffect, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"

export interface UseDraftFieldOptions {
  /**
   * Which thing is being edited (e.g. the provider id). Changing it discards
   * the draft and re-reads `committed`.
   */
  identity: string
  /** Idle time before a draft is committed. Defaults to 400 ms; `0` = sync. */
  debounceMs?: number
}

export interface DraftField {
  /** Current text — what the input renders. */
  value: string
  /** True while the draft differs from the last committed value. */
  isDirty: boolean
  /** Bind to the input's onChange (accepts the new string). */
  onChange: (next: string) => void
  /** Bind to the input's onBlur — commits immediately. */
  onBlur: () => void
  /** Bind to the input's onKeyDown — Enter commits immediately. */
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void
  /** Commit any pending draft now. */
  flush: () => void
}

interface DraftState {
  identity: string
  committed: string
  value: string
}

export function useDraftField(
  committed: string,
  commit: (value: string) => void,
  options: UseDraftFieldOptions
): DraftField {
  const { identity, debounceMs = 400 } = options
  const [state, setState] = useState<DraftState>({ identity, committed, value: committed })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The pending draft remembers which identity it belongs to, so a timer that
  // fires after the subject changed is dropped instead of writing provider A's
  // half-typed key into provider B.
  const pendingRef = useRef<{ identity: string; value: string } | null>(null)
  const identityRef = useRef(identity)
  const commitRef = useRef(commit)
  useEffect(() => {
    commitRef.current = commit
  }, [commit])
  useEffect(() => {
    identityRef.current = identity
    // Subject changed: any draft for the previous subject is abandoned.
    if (pendingRef.current && pendingRef.current.identity !== identity) {
      pendingRef.current = null
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [identity])

  // Identity changed → different subject, throw the draft away.
  if (state.identity !== identity) {
    setState({ identity, committed, value: committed })
  } else if (state.committed !== committed) {
    // Upstream moved. Adopt it only when the field is not dirty (or the
    // upstream now equals what we were about to write); a live draft wins.
    const dirty = state.value !== state.committed
    if (!dirty || committed === state.value) {
      setState({ identity, committed, value: dirty ? state.value : committed })
    } else {
      setState({ identity, committed, value: state.value })
    }
  }

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const flush = useCallback(() => {
    clearTimer()
    const pending = pendingRef.current
    pendingRef.current = null
    if (pending === null || pending.identity !== identityRef.current) return
    commitRef.current(pending.value)
    // Mark the draft as committed so a matching upstream echo is not treated
    // as an external change.
    setState((prev) =>
      prev.value === pending.value ? { ...prev, committed: pending.value } : prev
    )
  }, [])

  const onChange = useCallback(
    (next: string) => {
      setState((prev) => ({ ...prev, value: next }))
      pendingRef.current = { identity: identityRef.current, value: next }
      clearTimer()
      if (debounceMs <= 0) {
        flush()
        return
      }
      timerRef.current = setTimeout(flush, debounceMs)
    },
    [debounceMs, flush]
  )

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key === "Enter") flush()
    },
    [flush]
  )

  // Unmount with a pending draft: commit it rather than lose it.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      const pending = pendingRef.current
      pendingRef.current = null
      if (pending !== null && pending.identity === identityRef.current) {
        commitRef.current(pending.value)
      }
    }
  }, [])

  return {
    value: state.value,
    isDirty: state.value !== state.committed,
    onChange,
    onBlur: flush,
    onKeyDown,
    flush,
  }
}
