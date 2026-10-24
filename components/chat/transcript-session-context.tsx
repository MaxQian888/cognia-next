"use client"

/**
 * The conversation a transcript list renders.
 *
 * A message built during a live turn carries no `metadata.sessionId` until it
 * is reloaded from the database, and the focused (`activeSessionId`) session
 * is not necessarily the one a split pane, side chat or builder transcript
 * shows. A part that must act on its own conversation, such as an A2UI surface
 * whose buttons answer back (ADR-0240), reads this instead of guessing.
 */

import { createContext, useContext, type ReactNode } from "react"

const TranscriptSessionContext = createContext<string | null>(null)

export function TranscriptSessionProvider({
  sessionId,
  children,
}: {
  sessionId: string | null | undefined
  children: ReactNode
}) {
  return (
    <TranscriptSessionContext.Provider value={sessionId ?? null}>
      {children}
    </TranscriptSessionContext.Provider>
  )
}

/** The session of the nearest transcript list, or null outside one. */
export function useTranscriptSessionId(): string | null {
  return useContext(TranscriptSessionContext)
}
