"use client"

/** Compatibility entry point. Every IM session opens in the shared chat workspace. */
import { Suspense, useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Button } from "@/components/ui/button"
import { StateCard } from "@/components/inbox/state/state-card"
import { PageLoading } from "@/components/ui/loading-states"
import { useSessions } from "@/hooks/chat/use-sessions"
import { focusSession } from "@/hooks/global-search/use-global-search-actions"
import { resolveConversationLinkSession } from "@/lib/connectors/session-bindings"
import { buildSessionHref } from "@/lib/chat/message-permalink"

function ConversationInner() {
  const params = useSearchParams()
  const conversationKey = params.get("key") ?? ""
  const sessionId = params.get("sessionId") ?? undefined
  const messageId = params.get("messageId") ?? undefined
  const t = useTranslations("inbox.conversation")
  const router = useRouter()
  const { select } = useSessions()
  const session = useLiveQuery(
    async () =>
      (await resolveConversationLinkSession(conversationKey, { sessionId, messageId })) ?? null,
    [conversationKey, sessionId, messageId]
  )

  useEffect(() => {
    if (!conversationKey || !session) return
    focusSession(session, session.id, select)
    router.replace(`/${buildSessionHref(session.id, messageId)}`)
  }, [conversationKey, session, messageId, router, select])

  if (!conversationKey || session === null) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center p-4"
        data-testid="inbox-conversation-unavailable"
      >
        {/* `flex-none`: Empty is `flex-1` by default, and in this column it
            took every spare pixel, leaving the way out pinned to the bottom
            of a desktop window, far from the message it answers. */}
        <StateCard.Empty
          className="flex-none"
          title={t("unavailableTitle")}
          description={t("unavailableDescription")}
        />
        <Button variant="outline" onClick={() => router.replace("/")}>
          {t("openConversations")}
        </Button>
      </div>
    )
  }
  return <PageLoading title={t("loading")} />
}

export default function ConversationPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ConversationInner />
    </Suspense>
  )
}
