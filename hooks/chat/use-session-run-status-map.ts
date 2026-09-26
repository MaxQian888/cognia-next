"use client"

/**
 * Live turn state for the conversation lists: every session whose status is
 * not `idle`, keyed by id.
 *
 * One store read for a whole list instead of a selector per row — the rows are
 * memoized, and a per-row subscription would pull the chat store's module
 * graph into every surface that renders one. `useShallow` keeps the record's
 * identity while no session changes state, so a streamed token (which moves a
 * slice's `messages`, not its `status`) re-renders nothing.
 *
 * The rows draw it as their run indicator, and the lists derive the `running`
 * quick filter from it, so the glyph and the filter can never disagree.
 */

import { useMemo } from "react"
import { useShallow } from "zustand/react/shallow"

import { useChatStore } from "@/stores/chat"
import type { ChatStatus } from "@/stores/chat/chat-store"

type ActiveStatus = Exclude<ChatStatus, "idle">

export function useSessionRunStatusMap(): ReadonlyMap<string, ActiveStatus> {
  const record = useChatStore(
    useShallow((s) => {
      const out: Record<string, ActiveStatus> = {}
      for (const [id, slice] of Object.entries(s.sessions ?? {})) {
        const status = slice?.status
        if (status && status !== "idle") out[id] = status
      }
      return out
    })
  )
  return useMemo(() => new Map(Object.entries(record)), [record])
}
