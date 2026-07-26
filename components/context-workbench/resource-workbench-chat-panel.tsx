"use client"

import { lazy, Suspense, useCallback, useEffect, useRef, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import type { SendContent } from "@cognia/agent-config-types"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import { useChatScope } from "@/components/chat/chat-scope-provider"
import { useClaudeChat } from "@/hooks/chat/use-claude-chat"
import { getDb } from "@/lib/db/schema"
import { listMessages } from "@/lib/db/messages"
import { useChatStore } from "@/stores/chat"
import { useContextWorkbench } from "./context-workbench"
import { useSingleExport } from "@/hooks/data/use-single-export"
import { Button } from "@/components/ui/button"
import { DownloadIcon } from "lucide-react"

const ChatPane = lazy(() =>
  import("@/components/chat/chat-view").then((module) => ({
    default: module.ChatPane,
  }))
)

function withSelectionCoordinates(resourceContext: string, selection: unknown): string {
  return selection
    ? `[Current selection coordinates]\n${JSON.stringify(selection)}\n\n${resourceContext}`
    : resourceContext
}

export function ResourceWorkbenchChatPanel({
  getResourceContext,
  pendingPrompt,
  onPendingPromptConsumed,
  selectionHeader,
}: {
  getResourceContext?: () => string | Promise<string>
  pendingPrompt?: string | null
  onPendingPromptConsumed?: () => void
  /**
   * Host content above the conversation — the artifact surface puts its
   * "comment on the current selection" composer here. It used to be a separate
   * panel in the same activity group, which the rail could never reach.
   */
  selectionHeader?: ReactNode
}) {
  const t = useTranslations("contextWorkbench")
  const { sessionId } = useChatScope()
  const { resource } = useContextWorkbench()
  const claude = useClaudeChat()
  const exportSession = useSingleExport()
  const session = useLiveQuery(() => getDb().sessions.get(sessionId), [sessionId]) ?? null
  const reloadNonce = useChatStore((state) => state.sessions[sessionId]?.messagesReloadNonce ?? 0)

  useEffect(() => {
    let cancelled = false
    listMessages(sessionId)
      .then((messages) => {
        if (!cancelled) useChatStore.getState().setSessionMessages(sessionId, messages)
      })
      .catch((error) => {
        if (!cancelled) {
          useChatStore
            .getState()
            .setSessionMessagesLoadError(
              sessionId,
              error instanceof Error ? error.message : String(error)
            )
        }
      })
    return () => {
      cancelled = true
    }
  }, [reloadNonce, sessionId])

  const resolveResourceContext = useCallback(async () => {
    return withSelectionCoordinates(
      (await getResourceContext?.()) ?? "",
      "selection" in resource ? resource.selection : undefined
    )
  }, [getResourceContext, resource])

  const withArtifactTarget = useCallback(
    async <T,>(operation: () => Promise<T>): Promise<T> => {
      let artifactTargetPending = false
      if (resource.kind === "artifact") {
        useChatStore.getState().setPendingArtifactEditTarget(sessionId, {
          artifactId: resource.artifactId,
          requestId: crypto.randomUUID(),
        })
        artifactTargetPending = true
      }
      try {
        return await operation()
      } catch (error) {
        if (artifactTargetPending) {
          useChatStore.getState().setPendingArtifactEditTarget(sessionId, null)
        }
        throw error
      }
    },
    [resource, sessionId]
  )

  const send = useCallback(
    async (content: SendContent, manifest?: readonly AttachmentManifestEntry[]) =>
      withArtifactTarget(async () => {
        const resourceContext = await resolveResourceContext()
        return claude.send(content, undefined, {
          sessionId,
          resourceContext,
          attachmentManifest: manifest,
        })
      }),
    [claude, resolveResourceContext, sessionId, withArtifactTarget]
  )

  const regenerate = useCallback(
    async () =>
      withArtifactTarget(async () => {
        const resourceContext = await resolveResourceContext()
        return claude.regenerate(sessionId, resourceContext)
      }),
    [claude, resolveResourceContext, sessionId, withArtifactTarget]
  )

  const editAndResend = useCallback(
    async (messageId: string, content: SendContent) =>
      withArtifactTarget(async () => {
        const resourceContext = await resolveResourceContext()
        return claude.editAndResend(messageId, content, sessionId, resourceContext)
      }),
    [claude, resolveResourceContext, sessionId, withArtifactTarget]
  )
  const submittedPromptRef = useRef<string | null>(null)

  useEffect(() => {
    if (!pendingPrompt || submittedPromptRef.current === pendingPrompt) return
    submittedPromptRef.current = pendingPrompt
    void send(pendingPrompt)
      .then(() => onPendingPromptConsumed?.())
      .catch(() => {
        submittedPromptRef.current = null
      })
  }, [onPendingPromptConsumed, pendingPrompt, send])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-end border-b px-2">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={!session || exportSession.busy}
          aria-label={t("exportResourceSession")}
          onClick={() => session && void exportSession.run({ format: "markdown", session })}
        >
          <DownloadIcon className="size-4" />
        </Button>
      </div>
      {selectionHeader ? (
        <div className="shrink-0 border-b" data-testid="resource-chat-selection-header">
          {selectionHeader}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
              {t("aiLoading")}
            </div>
          }
        >
          <ChatPane
            activeSession={session}
            sessionId={sessionId}
            onSend={send}
            onStop={() => claude.stop(sessionId)}
            onRegenerate={regenerate}
            onEditResend={editAndResend}
            onCreate={() => undefined}
            onUseSample={(text) => void send(text)}
            onOpenSettings={() => undefined}
            showHeader={false}
          />
        </Suspense>
      </div>
    </div>
  )
}
