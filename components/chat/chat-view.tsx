"use client"

import { Composer } from "./composer"
import { ChatHeader } from "./chat-header"
import { EmptyChatState } from "./empty-state"
import { InlineError } from "./inline-error"
import { MessageList } from "./message-list"
import { useChatStore } from "@/stores/chat-store"
import type { ChatSession, SendContent } from "@/lib/claude/types"
import { toast } from "sonner"

interface ChatPaneProps {
  activeSession: ChatSession | null
  onSend: (content: SendContent) => Promise<void>
  onStop: () => Promise<void>
  onRegenerate: () => Promise<void>
  onEditResend: (messageId: string, newContent: SendContent) => Promise<void>
  onCreate: () => void
  onUseSample: (text: string) => void
  onOpenSettings: (tab?: string) => void
}

/**
 * The "main pane" content of the Discord shell — header, message list,
 * composer, error/empty states. Owned by `<DiscordShell>`, which provides
 * the cross-cutting hooks and dialogs.
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
}: ChatPaneProps) {
  const messages = useChatStore((s) => s.messages)
  const status = useChatStore((s) => s.status)
  const errorMessage = useChatStore((s) => s.errorMessage)

  if (!activeSession) {
    return <EmptyChatState onCreate={onCreate} onUseSample={(text) => onUseSample(text)} />
  }

  const handleSend = async (content: SendContent) => {
    await onSend(content)
  }

  const handleRetry = async () => {
    useChatStore.getState().setError(null)
    await onRegenerate()
  }

  return (
    <>
      <ChatHeader
        session={activeSession}
        messages={messages}
        onOpenSettings={() => onOpenSettings("api-key")}
      />
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
          onCopy={() => toast.success("Copied to clipboard")}
          onRegenerate={() => void onRegenerate()}
          onEditResend={(id, newText) => void onEditResend(id, newText)}
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
      <Composer
        session={activeSession}
        onStartNewSession={() => onCreate()}
        onOpenSettings={(tab) => onOpenSettings(tab)}
        onSend={handleSend}
        onStop={() => void onStop()}
        disabled={status === "awaiting_approval"}
      />
    </>
  )
}
