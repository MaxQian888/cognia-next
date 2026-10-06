"use client"

/**
 * Tells every message in a transcript whether several agents speak in it
 * (ADR-0218), so `MessageShell` shows the speaker line on each assistant turn
 * only then. The lists that own the transcript compute the answer
 * (`lib/chat/transcript-agents.ts`: from full messages, or from the turn
 * previews' `agentKey` in the timeline) and provide it here. A message
 * rendered outside any list (a share view, a plugin surface) reads `false`
 * and keeps the quiet default.
 */

import { createContext, useContext, type ReactNode } from "react"

const TranscriptAgentsContext = createContext(false)

export function TranscriptAgentsProvider({
  multiAgent,
  children,
}: {
  /** A boolean, so consumers re-render only when the answer itself flips. */
  multiAgent: boolean
  children: ReactNode
}) {
  return (
    <TranscriptAgentsContext.Provider value={multiAgent}>
      {children}
    </TranscriptAgentsContext.Provider>
  )
}

export function useTranscriptHasMultipleAgents(): boolean {
  return useContext(TranscriptAgentsContext)
}
