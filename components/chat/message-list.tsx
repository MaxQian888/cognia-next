"use client"

import { useTranslations } from "next-intl"
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  messagesToMarkdown,
} from "@/components/ai-elements/conversation"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import type { UIMessage } from "ai"
import { DownloadIcon, Trash2Icon } from "lucide-react"
import { MessageRenderer } from "./message-renderer"
import { useChatStore } from "@/stores/chat"
import { clearMessages } from "@/lib/db/messages"
import { listCharacters } from "@/lib/db/characters"
import { useLiveQuery } from "dexie-react-hooks"
import type { Character } from "@/lib/claude/types"
import { useCallback, useMemo } from "react"
import { toast } from "sonner"
import { downloadBlob } from "@/lib/files/download"
import { loggers } from "@/lib/logger"

interface Props {
  messages: UIMessage[]
  status: "idle" | "streaming" | "awaiting_approval" | "error"
  onCopy?: () => void
  onRegenerate?: () => void | Promise<void>
  onEditResend?: (messageId: string, newText: string) => void | Promise<void>
}

export function MessageList({ messages, status, onCopy, onRegenerate, onEditResend }: Props) {
  const t = useTranslations("chat.list")
  const lastIndex = messages.length - 1
  const sessionId = useChatStore((s) => s.activeSessionId)

  // Single Dexie subscription so renderer can resolve senderId → Character
  // without N independent queries. Cheap: characters are 5–20 rows in practice.
  const charactersList = useLiveQuery<Character[]>(
    () => (typeof window === "undefined" ? Promise.resolve([]) : listCharacters()),
    []
  )
  const characterById = useMemo(() => {
    const map = new Map<string, Character>()
    for (const c of charactersList ?? []) map.set(c.id, c)
    return map
  }, [charactersList])

  const handleExport = useCallback(() => {
    if (messages.length === 0) {
      toast.info(t("nothingToExport"))
      return
    }
    const md = messagesToMarkdown(messages)
    const blob = new Blob([md], { type: "text/markdown" })
    const ts = new Date().toISOString().replaceAll(/[:.]/g, "-")
    downloadBlob(blob, `cognia-chat-${ts}.md`)
    toast.success(t("exported"))
  }, [messages, t])

  const handleClear = useCallback(async () => {
    if (!sessionId) return
    try {
      await clearMessages(sessionId)
      useChatStore.getState().replaceMessages([])
      toast.success(t("cleared"))
    } catch (err) {
      loggers.chat.error("clear messages failed", err, { sessionId })
      toast.error(err instanceof Error ? err.message : t("cleared"))
    }
  }, [sessionId, t])

  const lastAssistantId = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].id
    }
    return null
  })()

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      {messages.length > 0 && (
        <div className="flex items-center justify-end gap-1 border-b bg-background/40 px-3 py-1.5">
          <Button variant="ghost" size="sm" onClick={handleExport} className="h-7 gap-1.5 text-xs">
            <DownloadIcon className="size-3.5" />
            {t("export")}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive"
              >
                <Trash2Icon className="size-3.5" />
                {t("clear")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("clearTitle")}</AlertDialogTitle>
                <AlertDialogDescription>{t("clearDescription")}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("clearCancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void handleClear()}>
                  {t("clearAction")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}

      <Conversation>
        <ConversationContent>
          {messages.map((m, i) => (
            <MessageRenderer
              key={m.id}
              message={m}
              characterById={characterById}
              isStreaming={
                i === lastIndex &&
                m.role === "assistant" &&
                (status === "streaming" || status === "awaiting_approval")
              }
              isLastAssistant={m.id === lastAssistantId}
              onCopy={onCopy}
              onRegenerate={onRegenerate}
              onEditResend={onEditResend}
            />
          ))}
          {shouldShowThinking(messages, status) && (
            <Shimmer as="p" className="px-1 py-2 text-sm">
              {t("thinking")}
            </Shimmer>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
    </div>
  )
}

/**
 * True when we should show the "Claude is thinking…" shimmer:
 * we're streaming AND the assistant hasn't produced any visible content yet.
 *
 * Intentionally excludes `awaiting_approval` since the approval dialog itself
 * is the user feedback for that state.
 */
function shouldShowThinking(
  messages: UIMessage[],
  status: "idle" | "streaming" | "awaiting_approval" | "error"
): boolean {
  if (status !== "streaming") return false
  if (messages.length === 0) return true
  const last = messages[messages.length - 1]
  if (last.role !== "assistant") return true
  // Any non-empty text or finished part means content is already visible.
  for (const part of last.parts) {
    const type = (part as { type?: string }).type
    if (!type) continue
    if (type === "text") {
      const text = (part as { text?: string }).text ?? ""
      if (text.trim().length > 0) return false
    } else if (type === "reasoning") {
      const text = (part as { text?: string }).text ?? ""
      if (text.trim().length > 0) return false
    } else if (typeof type === "string" && type.startsWith("tool-")) {
      // Tool blocks render their own visible affordance — no shimmer needed.
      return false
    } else if (type === "file") {
      return false
    }
  }
  return true
}
