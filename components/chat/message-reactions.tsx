"use client"

/**
 * Emoji reactions on a message row (ADR-0177, batch 2).
 *
 * Two pieces, because they have two lifetimes. The pills are what is on the
 * row (`metadata.reactions`), whoever put them there: the local user, an IM
 * member whose reaction the bus recorded, later a person in a shared room.
 * They stay visible, on the same line as the action bar and on the message's
 * side of the column. The add button is one more action in the hover bar,
 * and opens the small palette canvas comments already use.
 *
 * On a companion shell the row belongs to the host and a local write would be
 * undone by the next sync, so the controls render disabled with the reason,
 * rather than vanishing. Hiding a control collapses three different answers
 * into one blank space.
 *
 * The one case that does vanish is the one where the feature never applied:
 * a solo chat with the assistant has nobody to receive a reaction, so the add
 * button is absent rather than dead (`messageAllowsReactions`). Pills follow
 * the row itself — where reactions exist, they are shown.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { SmilePlusIcon } from "lucide-react"
import { toast } from "sonner"
import type { UIMessage } from "ai"
import { hasReacted, LOCAL_REACTOR_ID } from "@cognia/agent-config-types"

import { MessageAction } from "@/components/ai-elements/message"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  MESSAGE_REACTION_EMOJIS,
  messageAllowsReactions,
  reactionAbilityFor,
  readReactions,
  toggleMessageReaction,
} from "@/lib/chat/reactions"
import { useInboxWriteRoute } from "@/lib/connectors/inbox-writes/use-inbox-write-route"
import { cn } from "@/lib/utils"

export interface MessageReactionsProps {
  message: UIMessage
  sessionId?: string | null
  className?: string
}

/** The write gate and the toggle, shared by the pills and the add button. */
function useReactionToggle(message: UIMessage, sessionId: string | null | undefined) {
  const t = useTranslations("chat.reactions")
  const route = useInboxWriteRoute()
  const ability = reactionAbilityFor(route)
  const canWrite = ability !== "host-only" && Boolean(sessionId)
  const [busy, setBusy] = useState(false)

  const toggle = useCallback(
    async (emoji: string) => {
      if (!sessionId || !canWrite || busy) return
      setBusy(true)
      try {
        const result = await toggleMessageReaction({ sessionId, message, emoji })
        if (typeof result.mirror === "object") {
          toast.warning(t("mirrorFailed"), { description: result.mirror.failed })
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    },
    [busy, canWrite, message, sessionId, t]
  )

  const disabledReason = !sessionId ? undefined : canWrite ? undefined : t("needsHost")
  return { t, ability, canWrite, busy, toggle, disabledReason }
}

/** The reactions already on the row. Renders nothing when there are none. */
export function MessageReactionPills({ message, sessionId, className }: MessageReactionsProps) {
  const { t, ability, canWrite, busy, toggle, disabledReason } = useReactionToggle(
    message,
    sessionId
  )
  const reactions = readReactions(message)
  if (reactions.length === 0) return null
  return (
    <div
      className={cn("flex flex-wrap items-center gap-1", className)}
      data-testid="message-reactions"
      data-ability={ability}
    >
      {reactions.map((reaction) => {
        const mine = hasReacted([reaction], reaction.emoji, LOCAL_REACTOR_ID)
        return (
          <Button
            key={reaction.emoji}
            type="button"
            size="xs"
            variant={mine ? "secondary" : "outline"}
            className="h-6 gap-1 rounded-pill px-2 text-xs tabular-nums"
            aria-pressed={mine}
            aria-label={t("toggle", { emoji: reaction.emoji, count: reaction.actorIds.length })}
            title={disabledReason}
            disabled={!canWrite || busy}
            onClick={() => void toggle(reaction.emoji)}
            data-testid={`message-reaction-${reaction.emoji}`}
          >
            <span aria-hidden>{reaction.emoji}</span>
            <span>{reaction.actorIds.length}</span>
          </Button>
        )
      })}
    </div>
  )
}

/** The palette trigger, sized and revealed like every other row action. */
export function MessageReactionAdd({ message, sessionId, className }: MessageReactionsProps) {
  const { t, ability, canWrite, busy, toggle, disabledReason } = useReactionToggle(
    message,
    sessionId
  )
  const [open, setOpen] = useState(false)
  const reactions = readReactions(message)
  if (!sessionId || !messageAllowsReactions(message)) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <MessageAction
          tooltip={disabledReason ?? t("add")}
          label={t("add")}
          className={className}
          disabled={!canWrite || busy}
          data-testid="message-reaction-add"
          data-ability={ability}
        >
          <SmilePlusIcon className="size-3.5" />
        </MessageAction>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-1">
        <div className="flex items-center gap-0.5" role="group" aria-label={t("palette")}>
          {MESSAGE_REACTION_EMOJIS.map((emoji) => (
            <Button
              key={emoji}
              type="button"
              size="icon-sm"
              variant={hasReacted(reactions, emoji, LOCAL_REACTOR_ID) ? "secondary" : "ghost"}
              className="size-7 text-base"
              aria-label={t("pick", { emoji })}
              onClick={() => {
                setOpen(false)
                void toggle(emoji)
              }}
              data-testid={`message-reaction-pick-${emoji}`}
            >
              {emoji}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
