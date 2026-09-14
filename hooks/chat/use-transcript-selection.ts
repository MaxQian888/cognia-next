"use client"

/**
 * Selection mode for one transcript: whether it is on, and which messages are
 * ticked.
 *
 * The ticks are `useRangeSelection`, the sidebar's file-manager selection, with
 * one change of meaning: a click here always ADDS or REMOVES (the Ctrl gesture),
 * because in a mode whose whole purpose is picking several, a plain click that
 * replaced the selection would throw away everything picked so far. Shift still
 * extends a range from the last tick, additively.
 *
 * Owned by the list that draws the transcript, because the order ranges are cut
 * in is that list's order. A message's overflow menu, several components down,
 * reaches it through {@link TranscriptSelectionHostContext}, which only a list
 * that mounts the mode provides — so a read-only transcript that renders the
 * same message component (a remote session, the SDK session viewer) offers no
 * "Select" that would open nothing. Switching conversations ends the mode: a
 * selection is about the messages on screen.
 */

import { createContext, useCallback, useContext, useState } from "react"

import { useRangeSelection } from "@/hooks/ui/use-range-selection"

export interface UseTranscriptSelectionInput {
  /** The conversation this transcript shows. A change ends the mode. */
  sessionId: string | null | undefined
  /** Every message that can be ticked, in transcript order. */
  selectableIds: readonly string[]
}

export interface TranscriptSelection {
  active: boolean
  selected: ReadonlySet<string>
  isSelectable: (id: string) => boolean
  /** Tick or untick `id`, entering the mode if it was off. Shift extends a range. */
  toggle: (id: string, gesture?: { shiftKey?: boolean }) => void
  /**
   * Enter the mode with `id` ticked. Unlike a toggle, a message that is already
   * ticked stays ticked, and one that cannot be ticked just opens the mode.
   */
  start: (id: string) => void
  /** Tick every selectable message. */
  selectAll: () => void
  /** Untick everything but stay in the mode. */
  clear: () => void
  /** Leave the mode and forget the ticks. */
  exit: () => void
}

export function useTranscriptSelection({
  sessionId,
  selectableIds,
}: UseTranscriptSelectionInput): TranscriptSelection {
  const range = useRangeSelection(selectableIds)
  const { handleClick, clear: clearRange, isSelected } = range
  const [active, setActive] = useState(false)
  const [boundSession, setBoundSession] = useState(sessionId)

  // A different conversation: the ticks belonged to the old one. Adjusted while
  // rendering rather than in an effect, so the new transcript never paints with
  // the old conversation's selection bar over it.
  if (boundSession !== sessionId) {
    setBoundSession(sessionId)
    setActive(false)
    clearRange()
  }

  const isSelectable = useCallback((id: string) => selectableIds.includes(id), [selectableIds])

  const toggle = useCallback(
    (id: string, gesture?: { shiftKey?: boolean }) => {
      // Unticking the only ticked message is putting the selection down — the
      // same gesture ends a contextual selection in every mobile list. Staying
      // in an empty mode made people hunt for the ✕. "Clear" on the bar is the
      // deliberate way to empty the set and keep picking.
      if (!gesture?.shiftKey && active && range.selected.size === 1 && isSelected(id)) {
        setActive(false)
        clearRange()
        return
      }
      setActive(true)
      handleClick(id, { ctrlKey: true, metaKey: false, shiftKey: Boolean(gesture?.shiftKey) })
    },
    [active, clearRange, handleClick, isSelected, range.selected.size]
  )

  const start = useCallback(
    (id: string) => {
      setActive(true)
      if (isSelectable(id) && !isSelected(id)) {
        handleClick(id, { ctrlKey: true, metaKey: false, shiftKey: false })
      }
    },
    [handleClick, isSelectable, isSelected]
  )

  const exit = useCallback(() => {
    setActive(false)
    clearRange()
  }, [clearRange])

  return {
    active,
    selected: range.selected,
    isSelectable,
    toggle,
    start,
    selectAll: range.selectAll,
    clear: clearRange,
    exit,
  }
}

/** What a message needs from the transcript it sits in to open selection mode. */
export interface TranscriptSelectionHost {
  /** Open selection mode with this message ticked. */
  start: (messageId: string) => void
}

/**
 * Provided by a transcript that mounts selection mode; absent everywhere else.
 * Its value must be identity-stable: every message row reads it, and a new
 * object per streamed frame would re-render all of them.
 */
export const TranscriptSelectionHostContext = createContext<TranscriptSelectionHost | null>(null)

/** The selection host for the transcript this component is in, or null when there is none. */
export function useTranscriptSelectionHost(): TranscriptSelectionHost | null {
  return useContext(TranscriptSelectionHostContext)
}
