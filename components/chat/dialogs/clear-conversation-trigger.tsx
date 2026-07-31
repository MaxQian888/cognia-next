"use client"

// Drop-in "clear conversation" trigger for the chat header. Pairs with
// SingleExportTrigger so export + clear live on one header row instead of a
// duplicated toolbar strip above the message list. Renders nothing when there
// is no active session or no messages to clear, matching the old toolbar's
// `messages.length > 0` gate.

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { Trash2Icon } from "lucide-react"
import { toast } from "sonner"

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
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { useChatStore } from "@/stores/chat"
import { useClearMessages } from "@/lib/data-hooks/context"
import { loggers } from "@cognia/logging"

export function ClearConversationTrigger() {
  const t = useTranslations("chat.list")
  const sessionId = useChatStore((s) => s.activeSessionId)
  const messageCount = useChatStore((s) => s.messages.length)
  const clearMessages = useClearMessages()

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
  }, [sessionId, clearMessages, t])

  if (!sessionId || messageCount === 0) return null

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <TooltipIconButton
          variant="ghost"
          size="icon"
          aria-label={t("clear")}
          tooltip={t("clear")}
          className="text-destructive hover:text-destructive"
        >
          <Trash2Icon className="size-4" />
        </TooltipIconButton>
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
  )
}
