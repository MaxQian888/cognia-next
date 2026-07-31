"use client"

/**
 * Per-message memory lookups backing the in-chat memory chips.
 *
 * - `useLearnedMemories` — what did this assistant reply teach the long-term
 *   store? Reactive over the v122 `sourceMessageId` index, so rows appear when
 *   the async post-turn extraction job lands and update live after 撤销/edit.
 * - `useRecalledMemories` — resolve the memory ids persisted on the message's
 *   SourcesPart (`origin: "memory"`) back to live rows. A row may have been
 *   deleted since the turn ran; callers fall back to the persisted snippet.
 */

import { useLiveQuery } from "dexie-react-hooks"

import { getMemory, listMemoriesBySourceMessageId } from "@/lib/db/memories"
import type { Memory } from "@/types/memory/memory"

/**
 * Memories learned from the given assistant message, newest first. Includes
 * invalidated rows so the chip can render an "undone" state after 撤销.
 * Returns `[]` while loading or when `messageId` is absent.
 */
export function useLearnedMemories(messageId: string | undefined): Memory[] {
  return (
    useLiveQuery(
      () => (messageId ? listMemoriesBySourceMessageId(messageId) : Promise.resolve([])),
      [messageId]
    ) ?? []
  )
}

export interface RecalledMemoryRef {
  id: string
  /** Absent when the row has been hard-deleted since the turn ran. */
  memory?: Memory
}

/**
 * Resolve recalled-memory ids (from the message's SourcesPart) to live rows,
 * preserving order. Reactive so edits/deletions in the memory console reflect
 * into an open chip popover.
 */
export function useRecalledMemories(ids: readonly string[]): RecalledMemoryRef[] {
  return (
    useLiveQuery(async () => {
      if (ids.length === 0) return []
      const rows = await Promise.all(ids.map((id) => getMemory(id)))
      return ids.map((id, index) => ({ id, memory: rows[index] }))
      // Key on content: the ids array is rebuilt per render by the caller.
    }, [ids.join("|")]) ?? []
  )
}
