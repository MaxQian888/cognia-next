"use client"

/**
 * Client component for /inbox/c/[conversationKey].
 * Separated so the parent page.tsx can export generateStaticParams
 * without being a "use client" module.
 */

import { Suspense, use, useEffect } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { notFound } from "next/navigation"
import { getDb } from "@/lib/db/schema"
import type { ChatSession } from "@/lib/claude/types"
import { InboxShell } from "@/components/inbox/inbox-shell"
import { ConversationHeader } from "@/components/inbox/conversation-header"
import { DraftBanner } from "@/components/inbox/draft-banner"
import { ChatPane } from "@/components/chat/chat-view"
import { useClaudeChat, useSessions, useTeamChat } from "@/hooks/chat"
import { useResolvedConnectorMode } from "@/components/chat/use-resolved-connector-mode"
import type { PlatformKind } from "@/types/connectors/platform-kind"
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
  const t = useTranslations("inbox.conversation")
  const router = useRouter()
  const session = useLiveQuery<ChatSession | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb()
            .sessions.filter((s) => s.platformBinding?.conversationKey === conversationKey)
            .first(),
    [conversationKey]
  )

  // Bind the resolved connector mode via the three-layer lookup (adapter →
  // character platformDefaults → conversation override). The hook returns
  // null for non-platform sessions; we fall back to "auto" to keep
  // ConversationHeader's prop contract.
  const resolvedMode = useResolvedConnectorMode(session ?? null)

  // Mount the chat IPC + team-chat once per route. Both subscribers are
  // mirrored here for parity with `DesktopChatWorkspace`; only the one
  // matching the session kind is wired into the ChatPane below.
  const directChat = useClaudeChat()
  const teamChat = useTeamChat()
  const { select } = useSessions()

  // When the session resolves, make it the globally-active session so
  // useClaudeChat/useTeamChat dispatch into the right Zustand slice.
  useEffect(() => {
    if (session?.id) {
      select(session.id)
    }
  }, [session?.id, select])

  // session === undefined means the query is still loading.
  if (session === undefined) {
    return (
      <InboxShell view="conversation" conversationKey={conversationKey}>
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("loading")}
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
  const isTeamSession = session.kind === "team" && Boolean(session.teamId)
  const currentMode = resolvedMode ?? "auto"

  const send = isTeamSession ? teamChat.send : directChat.send
  const stop = isTeamSession ? teamChat.stop : directChat.stop
  const regenerate = isTeamSession ? teamChat.regenerate : directChat.regenerate
  const editAndResend = isTeamSession ? teamChat.editAndResend : directChat.editAndResend

  const openSettings = (tab?: string) => {
    router.push(tab ? `/settings?section=${tab}` : "/settings")
  }

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
          characterId={session.characterId}
        />
        <DraftBanner conversationKey={conversationKey} />
        <ChatPane
          showHeader={false}
          activeSession={session}
          onSend={send}
          onStop={stop}
          onRegenerate={regenerate}
          onEditResend={editAndResend}
          onCreate={() => {}}
          onUseSample={(text) => void send(text)}
          onOpenSettings={openSettings}
        />
      </div>
    </InboxShell>
  )
}
