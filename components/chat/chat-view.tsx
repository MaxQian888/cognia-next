"use client"

import { useCallback, type Ref } from "react"
import { useTranslations } from "next-intl"
import { Composer, type ComposerHandle } from "./composer"
import { ChatHeader } from "./chat-header"
import { CharacterMissingBanner } from "./character-missing-banner"
import { EmptyChatState } from "./empty-state"
import { InlineError } from "./inline-error"
import { MessageList } from "./message-list"
import { ExternalAgentSessionPanel } from "@/components/agent/external-agent-session-panel"
import { useChatStore } from "@/stores/chat"
import type { Character, ChatSession, SendContent } from "@/lib/claude/types"
import { toast } from "sonner"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"

interface ChatPaneProps {
  activeSession: ChatSession | null
  onSend: (content: SendContent) => Promise<void>
  onStop: () => Promise<void>
  onRegenerate: () => Promise<void>
  onEditResend: (messageId: string, newContent: SendContent) => Promise<void>
  onCreate: () => void
  onUseSample: (text: string) => void
  onOpenSettings: (tab?: string) => void
  /**
   * Imperative handle on the Composer. The desktop shell uses it to insert
   * `@CharacterName` mentions when the user clicks a row in the team
   * member-list rail.
   */
  composerRef?: Ref<ComposerHandle>
  /** When provided, opens the mobile inline @-mention popover on `@`. */
  mobileMentionMembers?: readonly Character[]
  /**
   * When false, the internal `<ChatHeader>` is omitted. The Inbox detail
   * panel uses this so its own `<ConversationHeader>` (mode + policy +
   * character chip) is the only header, avoiding duplicate chrome.
   * Defaults to true.
   */
  showHeader?: boolean
}

/**
 * The "main pane" content of the desktop shell — header, message list,
 * composer, error/empty states. Owned by `<DesktopChatWorkspace>`, which
 * provides the cross-cutting hooks and dialogs.
 *
 * Kept lean on purpose: every cross-cutting concern (settings, approvals,
 * command palette, title bar) belongs in the shell.
 */
export function ChatPane({
  activeSession,
  onSend,
  onStop,
  onRegenerate,
  onEditResend,
  onCreate,
  onUseSample,
  onOpenSettings,
  composerRef,
  mobileMentionMembers,
  showHeader = true,
}: ChatPaneProps) {
  const tCopy = useTranslations("chat.copy")
  const messages = useChatStore((s) => s.messages)
  const status = useChatStore((s) => s.status)
  const errorMessage = useChatStore((s) => s.errorMessage)

  const handleCopySuccess = useCallback(() => {
    toast.success(tCopy("success"))
  }, [tCopy])

  const handleRegenerate = useCallback(() => {
    void onRegenerate()
  }, [onRegenerate])

  const handleEditResend = useCallback(
    (id: string, newText: string) => {
      void onEditResend(id, newText)
    },
    [onEditResend]
  )

  const handleSend = useCallback(
    async (content: SendContent) => {
      await onSend(content)
    },
    [onSend]
  )

  const handleRetry = useCallback(async () => {
    useChatStore.getState().setError(null)
    await onRegenerate()
  }, [onRegenerate])

  if (!activeSession) {
    return <EmptyChatState onCreate={onCreate} onUseSample={(text) => onUseSample(text)} />
  }

  return (
    <>
      {showHeader && (
        <ChatHeader
          session={activeSession}
          messages={messages}
          onOpenSettings={() => onOpenSettings("api-key")}
        />
      )}
      {/* ADR-0030 — surfaces a destructive Alert when session.characterId
          no longer resolves (plugin disabled, local pack deleted). Renders
          nothing when the character resolves or the id is a plain Dexie
          row that's simply missing. */}
      <CharacterMissingBanner characterId={activeSession.characterId} onPickAnother={onCreate} />
      <ExternalAgentSessionPanel />
      {messages.length === 0 ? (
        <EmptyChatState
          onCreate={onCreate}
          onUseSample={(text) => onUseSample(text)}
          variant="inline"
        />
      ) : (
        <MessageList
          messages={messages}
          status={status}
          onCopy={handleCopySuccess}
          onRegenerate={handleRegenerate}
          onEditResend={handleEditResend}
        />
      )}
      {errorMessage && (
        <InlineError
          message={errorMessage}
          onRetry={messages.length > 0 ? handleRetry : undefined}
          onOpenSettings={() => onOpenSettings("api-key")}
          onDismiss={() => useChatStore.getState().setError(null)}
        />
      )}
      <PluginExtensionSlot
        point="chat.footer"
        className="flex items-center justify-center gap-2 px-3 empty:hidden"
      />
      <Composer
        ref={composerRef}
        session={activeSession}
        onStartNewSession={() => onCreate()}
        onOpenSettings={(tab) => onOpenSettings(tab)}
        onSend={handleSend}
        onStop={() => void onStop()}
        disabled={status === "awaiting_approval"}
        mobileMentionMembers={mobileMentionMembers}
      />
    </>
  )
}
