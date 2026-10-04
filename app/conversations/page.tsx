"use client"

import { Suspense } from "react"

import { ConversationManager } from "@/components/conversations/conversation-manager"

/**
 * `/conversations` — the conversation manager (ADR-0213).
 *
 * `ConversationManager` reads `useSearchParams()` for the `?tab=archived` deep
 * link. The static export pre-renders this page server-side, where that hook
 * throws unless a Suspense boundary lets it bail out to client rendering.
 */
export default function ConversationsPage() {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <Suspense fallback={null}>
        <ConversationManager />
      </Suspense>
    </div>
  )
}
