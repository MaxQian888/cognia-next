"use client"

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
import { useChatStore } from "@/stores/chat-store"
import { clearMessages } from "@/lib/db/messages"
import { listCharacters } from "@/lib/db/characters"
import { useLiveQuery } from "dexie-react-hooks"
import type { Character } from "@/lib/claude/types"
import { useCallback, useMemo } from "react"
import { toast } from "sonner"

interface Props {
  messages: UIMessage[]
  status: "idle" | "streaming" | "awaiting_approval" | "error"
  onCopy?: () => void
  onRegenerate?: () => void | Promise<void>
  onEditResend?: (messageId: string, newText: string) => void | Promise<void>
}

export function MessageList({ messages, status, onCopy, onRegenerate, onEditResend }: Props) {
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
      toast.info("Nothing to export yet.")
      return
    }
    const md = messagesToMarkdown(messages)
    const blob = new Blob([md], { type: "text/markdown" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    const ts = new Date().toISOString().replaceAll(/[:.]/g, "-")
    link.href = url
    link.download = `cognia-chat-${ts}.md`
    document.body.append(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    toast.success("Exported as markdown.")
  }, [messages])

  const handleClear = useCallback(async () => {
    if (!sessionId) return
    await clearMessages(sessionId)
    useChatStore.getState().replaceMessages([])
    toast.success("Conversation cleared.")
  }, [sessionId])

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
            Export
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive"
              >
                <Trash2Icon className="size-3.5" />
                Clear
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear this conversation?</AlertDialogTitle>
                <AlertDialogDescription>
                  All messages in this session will be permanently deleted. The session itself will
                  remain.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void handleClear()}>
                  Delete messages
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
              Claude is thinking…
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
