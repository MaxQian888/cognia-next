"use client"

/**
 * /inbox/c?key=… — single conversation view.
 *
 * Static route reading the conversation key from the query string (replaces the
 * old `/inbox/c/[conversationKey]` dynamic route, unservable for runtime keys
 * under `output: "export"`). `URLSearchParams.get` returns the already-decoded
 * value, so no manual decodeURIComponent here.
 */

import { Suspense, useEffect } from "react"
import { notFound, useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import type { ChatSession } from "@cognia/agent-config-types"
import { InboxShell } from "@/components/inbox/inbox-shell"
import { ConversationHeader } from "@/components/inbox/conversation-header"
import { PageLoading } from "@/components/ui/loading-states"
import { ChatPane } from "@/components/chat/chat-view"
import { ArtifactWorkspaceDock } from "@/components/artifacts/artifact-workspace-dock"
import { useClaudeChat, useSessions, useTeamChat } from "@/hooks/chat"
import { useResolvedConnectorMode } from "@/components/chat/use-resolved-connector-mode"
import { useActiveConversationStore } from "@/stores/inbox/active-conversation-store"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"

function ConversationInner() {
  const conversationKey = useSearchParams().get("key") ?? ""
  if (!conversationKey) {
    notFound()
  }
  return <ConversationDetail conversationKey={conversationKey} />
}

function ConversationDetail({ conversationKey }: { conversationKey: string }) {
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

  // Expose the viewed conversation so the connector inbound bridge can suppress
  // an OS notification for the conversation already on screen (focus-aware).
  useEffect(() => {
    const store = useActiveConversationStore.getState()
    store.setActiveConversation(conversationKey)
    return () => store.clearIf(conversationKey)
  }, [conversationKey])

  // session === undefined means the query is still loading.
  if (session === undefined) {
    return (
      <InboxShell view="conversation" conversationKey={conversationKey}>
        <PageLoading title={t("loading")} />
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
  const handleSend = (
    content: Parameters<typeof send>[0],
    manifest?: readonly AttachmentManifestEntry[]
  ) =>
    isTeamSession
      ? teamChat.send(content, { attachmentManifest: manifest })
      : directChat.send(content, undefined, { attachmentManifest: manifest })
  const stop = isTeamSession ? teamChat.stop : directChat.stop
  const regenerate = isTeamSession ? teamChat.regenerate : directChat.regenerate
  const editAndResend = isTeamSession ? teamChat.editAndResend : directChat.editAndResend

  const openSettings = (tab?: string) => {
    router.push(tab ? `/settings?section=${tab}` : "/settings")
  }

  return (
    <InboxShell view="conversation" adapterId={adapterId} conversationKey={conversationKey}>
      {/* `min-h-0` lets the dock below shrink instead of overflowing the pane;
          `min-w-0` keeps a wide message from widening the whole column.
          Notices are no longer mounted here — `InboxShell` owns the single
          `InboxNoticeArea` for every Inbox route. */}
      <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid="conversation-detail">
        <ConversationHeader
          conversationKey={conversationKey}
          sessionId={session.id}
          title={session.title}
          platform={platform}
          currentMode={currentMode}
          policy={defaultPrivateChatPolicy()}
          characterId={session.characterId}
        />
        <ArtifactWorkspaceDock>
          <ChatPane
            showHeader={false}
            activeSession={session}
            onSend={handleSend}
            onStop={stop}
            onRegenerate={regenerate}
            onEditResend={editAndResend}
            onCreate={() => {}}
            onUseSample={(text) => void send(text)}
            onOpenSettings={openSettings}
          />
        </ArtifactWorkspaceDock>
      </div>
    </InboxShell>
  )
}

export default function ConversationPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ConversationInner />
    </Suspense>
  )
}
