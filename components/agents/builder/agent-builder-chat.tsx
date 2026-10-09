"use client"

/**
 * The builder conversation (ADR-0220): the main chat pane, unchanged, bound to
 * the builder session — the workflow copilot's pattern. Sends go through the
 * one chat runtime, where `resolveSendOptions` adds the builder tools and
 * protocol because the session's kind is `"agent-builder"`.
 */

import { useCallback, useEffect, useMemo } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { FileSearchIcon, GitPullRequestIcon, NotebookPenIcon } from "lucide-react"
import type { ChatSession, SendContent } from "@cognia/agent-config-types"
import type { ChatTemplateRun } from "@/lib/chat/template/run"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import type { ComposerTurnMetadata } from "@/components/chat/composer"
import type { StarterSample } from "@/components/chat/empty-state"
import { ChatPane } from "@/components/chat/chat-view"
import { ChatScopeProvider } from "@/components/chat/chat-scope-provider"
import { useClaudeChat } from "@/hooks/chat/use-claude-chat"
import { useChatStore } from "@/stores/chat"
import { listMessages } from "@/lib/db/messages"
import { turnMetadataSendOptions } from "@/lib/chat/turn-metadata"

export function buildAgentBuilderStarters(t: (key: string) => string): StarterSample[] {
  return [
    {
      key: "pr-review",
      icon: GitPullRequestIcon,
      title: t("starters.reviewTitle"),
      prompt: t("starters.reviewPrompt"),
    },
    {
      key: "research",
      icon: FileSearchIcon,
      title: t("starters.researchTitle"),
      prompt: t("starters.researchPrompt"),
    },
    {
      key: "planning",
      icon: NotebookPenIcon,
      title: t("starters.planTitle"),
      prompt: t("starters.planPrompt"),
    },
  ]
}

export function AgentBuilderChat({
  session,
  onOpenSettings,
}: {
  session: ChatSession
  onOpenSettings?: (tab?: string) => void
}) {
  const t = useTranslations("agentsConsole.builder")
  const claude = useClaudeChat()
  const sessionId = session.id
  const reloadNonce = useChatStore((s) => s.sessions[sessionId]?.messagesReloadNonce ?? 0)

  // `/agents` does not mount the main shell's session hydration, so load this
  // conversation's history here, as the workflow editor's chat tab does.
  useEffect(() => {
    let cancelled = false
    listMessages(sessionId)
      .then((messages) => {
        if (!cancelled) useChatStore.getState().setSessionMessages(sessionId, messages)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          useChatStore
            .getState()
            .setSessionMessagesLoadError(
              sessionId,
              err instanceof Error ? err.message : String(err)
            )
        }
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, reloadNonce])

  const handleSend = useCallback(
    async (
      content: SendContent,
      manifest?: readonly AttachmentManifestEntry[],
      templateRun?: ChatTemplateRun | null,
      turnMetadata?: ComposerTurnMetadata
    ) => {
      try {
        await claude.send(content, undefined, {
          sessionId,
          attachmentManifest: manifest,
          ...(templateRun ? { templateRun } : {}),
          ...turnMetadataSendOptions(turnMetadata),
        })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    },
    [claude, sessionId]
  )

  const emptyState = useMemo(
    () => ({
      title: t("emptyTitle"),
      subtitle: t("emptySubtitle"),
      samplesHeading: t("starters.heading"),
      samples: buildAgentBuilderStarters(t),
    }),
    [t]
  )

  return (
    <ChatScopeProvider sessionId={sessionId}>
      <div className="flex h-full min-h-0 w-full flex-col" data-testid="agent-builder-chat">
        <ChatPane
          activeSession={session}
          sessionId={sessionId}
          onSend={handleSend}
          onStop={() => claude.stop(sessionId)}
          onRegenerate={() => claude.regenerate(sessionId)}
          onEditResend={(messageId, content) => claude.editAndResend(messageId, content, sessionId)}
          onCreate={() => undefined}
          onUseSample={(text) => void handleSend(text)}
          onOpenSettings={(tab) => onOpenSettings?.(tab)}
          showHeader={false}
          emptyState={emptyState}
        />
      </div>
    </ChatScopeProvider>
  )
}
