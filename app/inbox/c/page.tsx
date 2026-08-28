"use client"

/**
 * /inbox/c?key=…[&messageId=…] — single conversation view.
 *
 * Static route reading the conversation key from the query string (replaces the
 * old `/inbox/c/[conversationKey]` dynamic route, unservable for runtime keys
 * under `output: "export"`). `URLSearchParams.get` returns the already-decoded
 * value, so no manual decodeURIComponent here. An optional `messageId` lands
 * the pane on one message once the session's history hydrates — the ⌘K message
 * hits and cross-links point here for IM conversations.
 */

import { Suspense, useEffect } from "react"
import { notFound, useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { getDb } from "@/lib/db/schema"
import { jumpToSessionMessage } from "@/lib/chat/cross-session-jump"
import type { ChatSession } from "@cognia/agent-config-types"
import { InboxShell } from "@/components/inbox/inbox-shell"
import { ConversationHeader } from "@/components/inbox/conversation-header"
import { useResolvedBinding } from "@/hooks/connectors/use-resolved-binding"
import { HistoryLoadEarlier } from "@/components/inbox/history-load-earlier"
import { PageLoading } from "@/components/ui/loading-states"
import { ChatPane } from "@/components/chat/chat-view"
import { ArtifactWorkspaceDock } from "@/components/artifacts/artifact-workspace-dock"
import { useClaudeChat, useSessions, useTeamChat } from "@/hooks/chat"
import { useResolvedConnectorMode } from "@/components/chat/use-resolved-connector-mode"
import { useAdapterInstance } from "@/hooks/connectors/use-adapter-instance"
import { useActiveConversationStore } from "@/stores/inbox/active-conversation-store"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import {
  effectiveCapabilities,
  effectiveCapabilitiesForRow,
} from "@/lib/connectors/effective-capabilities"
import { capabilityAvailability } from "@/lib/connectors/capability-availability"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import type { ComposerTurnMetadata } from "@/components/chat/composer"

function ConversationInner() {
  const params = useSearchParams()
  const conversationKey = params.get("key") ?? ""
  const messageId = params.get("messageId") ?? undefined
  if (!conversationKey) {
    notFound()
  }
  return <ConversationDetail conversationKey={conversationKey} messageId={messageId} />
}

function ConversationDetail({
  conversationKey,
  messageId,
}: {
  conversationKey: string
  /** Land on this message after the session hydrates (`&messageId=`). */
  messageId?: string
}) {
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

  // The header's policy read-out used to be handed `defaultPrivateChatPolicy()`
  // — a literal, not this bot's policy — so it described a bot nobody had
  // configured. Resolved live through the same three layers the bus uses;
  // `undefined` until the adapter row loads, which the read-out says out loud
  // rather than papering over with a default.
  const resolvedBinding = useResolvedBinding(
    session?.platformBinding
      ? { adapterId: session.platformBinding.adapterId, conversationKey }
      : null
  )

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

  // Deep link to one message: wait for the (now active) session's history via
  // the cross-session primitive, then jump. Fires once per (session, message).
  useEffect(() => {
    if (!session?.id || !messageId) return
    let cancelled = false
    void jumpToSessionMessage(session.id, messageId, { align: "center" }).then((landed) => {
      if (!landed && !cancelled) toast.error(t("jumpFailed"))
    })
    return () => {
      cancelled = true
    }
  }, [session?.id, messageId, t])

  // The bot row behind this conversation. "Load earlier" is gated on what THIS
  // instance can do, not on what the platform's adapter implements — a Slack
  // grant without a `*:history` scope has no history to fetch and the button
  // would only produce a `missing_scope` toast. The bar is still MOUNTED when
  // it cannot: an absent bar reads the same as an empty backlog.
  const adapterRow = useAdapterInstance(session?.platformBinding?.adapterId)

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
  // Until the row resolves, answer from the platform table — the same fallback
  // the model's tool manifest uses, so the button never contradicts the tools.
  const historyAccess = capabilityAvailability(
    adapterRow ? effectiveCapabilitiesForRow(adapterRow) : effectiveCapabilities({ platform }),
    "history.fetch"
  )
  const isTeamSession = session.kind === "team" && Boolean(session.teamId)
  const currentMode = resolvedMode ?? "auto"

  const send = isTeamSession ? teamChat.send : directChat.send
  const handleSend = (
    content: Parameters<typeof send>[0],
    manifest?: readonly AttachmentManifestEntry[],
    _templateRun?: unknown,
    turnMetadata?: ComposerTurnMetadata
  ) =>
    isTeamSession
      ? teamChat.send(content, {
          attachmentManifest: manifest,
          ...(turnMetadata?.webSearchContext
            ? { webSearchContext: turnMetadata.webSearchContext }
            : {}),
        })
      : directChat.send(content, undefined, {
          attachmentManifest: manifest,
          ...(turnMetadata?.webSearchContext
            ? { webSearchContext: turnMetadata.webSearchContext }
            : {}),
        })
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
          policy={resolvedBinding?.trigger}
          characterId={session.characterId}
        />
        <HistoryLoadEarlier
          conversationKey={conversationKey}
          adapterId={adapterId}
          unavailable={historyAccess.available ? undefined : historyAccess}
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
