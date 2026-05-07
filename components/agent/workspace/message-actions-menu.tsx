"use client"

import { useTranslations } from "next-intl"
import { CopyIcon, MoreHorizontalIcon, RotateCwIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { AgentTeamMessage } from "@/types/agent/agent-team"
import { TEAM_USER_SENDER_ID } from "@/types/agent/agent-team"
import { TEAM_MESSAGE_METADATA_KEYS } from "@/lib/agent-team/team-runtime-dispatcher"

export interface MessageActionsMenuProps {
  message: AgentTeamMessage
  /** Re-dispatch the original prompt to the same target. */
  onRetry?: (params: {
    targetId: string
    prompt: string
    messageId: string
  }) => void | Promise<void>
  /** Remove this message from the store. */
  onDelete?: (messageId: string) => void | Promise<void>
  className?: string
}

function readDispatchTarget(message: AgentTeamMessage): {
  targetId?: string
  prompt?: string
} {
  const meta = message.metadata ?? {}
  const targetId = meta[TEAM_MESSAGE_METADATA_KEYS.DISPATCH_TARGET_ID]
  const prompt = meta[TEAM_MESSAGE_METADATA_KEYS.DISPATCH_PROMPT]
  return {
    targetId: typeof targetId === "string" ? targetId : undefined,
    prompt: typeof prompt === "string" ? prompt : undefined,
  }
}

export function MessageActionsMenu({
  message,
  onRetry,
  onDelete,
  className,
}: MessageActionsMenuProps) {
  const t = useTranslations("agentTeamsWorkspace.chat.messageActions")

  const isFromUser = message.senderId === TEAM_USER_SENDER_ID
  const { targetId, prompt } = readDispatchTarget(message)
  const canRetry = !isFromUser && !!onRetry && !!targetId && !!prompt
  const canDelete = !!onDelete

  const handleCopy = async () => {
    try {
      if (!message.content) return
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(message.content)
      }
      toast.success(t("copied"))
    } catch (err) {
      // Fall through quietly; toast.error would clutter the demo.
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleRetry = async () => {
    if (!canRetry || !onRetry || !targetId || !prompt) return
    await onRetry({ targetId, prompt, messageId: message.id })
  }

  const handleDelete = async () => {
    if (!onDelete) return
    try {
      await onDelete(message.id)
    } catch (err) {
      toast.error(`${t("deleteFailed")}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-6", className)}
          data-testid={`msg-actions-trigger-${message.id}`}
          aria-label={t("open")}
        >
          <MoreHorizontalIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuItem onClick={handleCopy} data-testid={`msg-action-copy-${message.id}`}>
          <CopyIcon className="size-3.5" />
          <span className="text-xs">{t("copy")}</span>
        </DropdownMenuItem>
        {canRetry && (
          <DropdownMenuItem onClick={handleRetry} data-testid={`msg-action-retry-${message.id}`}>
            <RotateCwIcon className="size-3.5" />
            <span className="text-xs">{t("retry")}</span>
          </DropdownMenuItem>
        )}
        {canDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={handleDelete}
              variant="destructive"
              data-testid={`msg-action-delete-${message.id}`}
            >
              <Trash2Icon className="size-3.5" />
              <span className="text-xs">{t("delete")}</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
