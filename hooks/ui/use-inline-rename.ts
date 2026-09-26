"use client"

/**
 * The inline rename field every conversation-list surface uses: the desktop
 * row, the desktop folder header and the mobile drawer row.
 *
 * One implementation of the three rules they each had to get right:
 *
 * - Enter commits, except while an IME is composing (`isImeComposing`): the
 *   Enter that picks a Chinese or Japanese candidate is not "save", and
 *   committing there stored half-typed titles.
 * - A field settles once. Enter commits and the blur that follows would
 *   commit again; Escape cancels and the blur would then commit the draft.
 * - Escape belongs to the field: it cancels and stops there, so the list
 *   (clears its selection) or the drawer (closes) does not act on it too.
 *
 * A commit with nothing to save — blank, or unchanged — is a cancel.
 *
 * `active` re-arms the field: each time it turns true the draft restarts from
 * `initial`, the settle guard resets, and the input is focused with its text
 * selected so the first keystroke replaces it.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type RefObject,
} from "react"

import { isImeComposing } from "@/lib/ui/ime"

export interface UseInlineRenameOptions {
  /** Whether the field is showing. Defaults to `true` (a field mounted only while renaming). */
  active?: boolean
  /** The current name — the draft's starting point and the "unchanged" test. */
  initial: string
  /** A trimmed, non-empty, changed name. */
  onCommit: (next: string) => void
  /** Escape, or a commit with nothing to save. */
  onCancel: () => void
}

export interface InlineRenameInputProps {
  ref: RefObject<HTMLInputElement | null>
  value: string
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  onBlur: () => void
}

export interface UseInlineRename {
  draft: string
  /** Spread onto the `<input>` / `<Input>`. */
  inputProps: InlineRenameInputProps
  commit: () => void
  cancel: () => void
}

export function useInlineRename({
  active = true,
  initial,
  onCommit,
  onCancel,
}: UseInlineRenameOptions): UseInlineRename {
  const [draft, setDraft] = useState(initial)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const settledRef = useRef(false)
  const [wasActive, setWasActive] = useState(active)

  // Re-arm during render when the field opens, so its first frame already
  // shows the current name. A rename landing from elsewhere while the field
  // is open leaves the user's draft alone.
  if (wasActive !== active) {
    setWasActive(active)
    if (active) setDraft(initial)
  }

  useEffect(() => {
    if (!active) return
    settledRef.current = false
    const input = inputRef.current
    if (!input) return
    input.focus({ preventScroll: true })
    input.select()
  }, [active])

  const commit = useCallback(() => {
    if (settledRef.current) return
    settledRef.current = true
    const next = draft.trim()
    if (next && next !== initial) onCommit(next)
    else onCancel()
  }, [draft, initial, onCommit, onCancel])

  const cancel = useCallback(() => {
    if (settledRef.current) return
    settledRef.current = true
    setDraft(initial)
    onCancel()
  }, [initial, onCancel])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter" && !isImeComposing(event)) {
        event.preventDefault()
        commit()
      } else if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        cancel()
      }
    },
    [commit, cancel]
  )

  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    []
  )

  return {
    draft,
    inputProps: { ref: inputRef, value: draft, onChange, onKeyDown, onBlur: commit },
    commit,
    cancel,
  }
}
