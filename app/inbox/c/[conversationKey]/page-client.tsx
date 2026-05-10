"use client"

/**
 * Client component for /inbox/c/[conversationKey].
 * Separated so the parent page.tsx can export generateStaticParams
 * without being a "use client" module.
 */

import { Suspense, use } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { notFound } from "next/navigation"
import { getDb } from "@/lib/db/schema"
import type { ChatSession } from "@/lib/claude/types"
import { InboxShell } from "@/components/inbox/inbox-shell"
import { ConversationHeader } from "@/components/inbox/conversation-header"
import { DraftBanner } from "@/components/inbox/draft-banner"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import type { ConnectorMode } from "@/types/connectors/policy"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"

interface PageProps {
  params: Promise<{ conversationKey: string }>
}

export function ConversationPageClient({ params }: PageProps) {
  const { conversationKey: encodedKey } = use(params)
  const conversationKey = decodeURIComponent(encodedKey)

  return (
    <Suspense>
      <ConversationPageInner conversationKey={conversationKey} />
    </Suspense>
  )
}

function ConversationPageInner({ conversationKey }: { conversationKey: string }) {
  const session = useLiveQuery<ChatSession | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb()
            .sessions.filter((s) => s.platformBinding?.conversationKey === conversationKey)
            .first(),
    [conversationKey]
  )

  // session === undefined means the query is still loading.
  if (session === undefined) {
    return (
      <InboxShell view="conversation" conversationKey={conversationKey}>
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      </InboxShell>
    )
  }

  // session === null means no matching session was found.
  if (session === null) {
    notFound()
  }

  const platform = session.platformBinding!.platform as PlatformKind
  const adapterId = session.platformBinding!.adapterId
  const currentMode: ConnectorMode = "auto"

  return (
    <InboxShell view="conversation" adapterId={adapterId} conversationKey={conversationKey}>
      <div className="flex flex-col h-full" data-testid="conversation-detail">
        <ConversationHeader
          conversationKey={conversationKey}
          sessionId={session.id}
          title={session.title}
          platform={platform}
          currentMode={currentMode}
          policy={defaultPrivateChatPolicy()}
        />
        <DraftBanner conversationKey={conversationKey} />
        <div className="flex-1 overflow-auto p-4 text-sm text-muted-foreground">
          {/* The full ChatPane integration requires DesktopChatWorkspace's hook wiring. */}
          {/* Phase 1: render the session id as a placeholder; Phase 2 wires ChatPane. */}
          <p>Session: {session.id}</p>
          <p>Conversation: {conversationKey}</p>
        </div>
      </div>
    </InboxShell>
  )
}
