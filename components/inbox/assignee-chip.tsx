"use client"

/**
 * Conversation assignee control (CRM, schema v83). A compact chip showing who
 * owns the conversation (kind dot + label) and, on click, lets the operator
 * (re)assign it to themselves ("Me"), to one of the bound characters, or
 * unassign it. Writes via setAssignee, which records the transition on the
 * assignment-event trail. The app is single-user, so "human" carries no id.
 *
 * Mirrors LifecycleStatusChip's shape (DropdownMenu + write + toast on error).
 */

import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useCharacters } from "@/lib/data-hooks/context"
import { setAssignee, type ConversationAssignee } from "@/lib/db/conversation-overrides"

const KIND_DOT: Record<ConversationAssignee["kind"], string> = {
  human: "bg-indigo-500",
  character: "bg-violet-500",
  team: "bg-teal-500",
}

export interface AssigneeChipProps {
  conversationKey: string
  sessionId: string
  assignee?: ConversationAssignee
}

export function AssigneeChip({ conversationKey, sessionId, assignee }: AssigneeChipProps) {
  const t = useTranslations("inbox.assignee")
  const characters = useCharacters() ?? []

  const apply = async (next: ConversationAssignee | null) => {
    try {
      await setAssignee(conversationKey, next, { sessionId, via: "manual" })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const label = !assignee
    ? t("unassigned")
    : assignee.kind === "human"
      ? t("me")
      : assignee.kind === "team"
        ? (assignee.label ?? t("team"))
        : (assignee.label ?? t("unknownCharacter"))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          data-testid="assignee-chip"
          aria-label={t("aria", { assignee: label })}
        >
          <span
            className={cn(
              "size-2 rounded-full",
              assignee ? KIND_DOT[assignee.kind] : "bg-muted-foreground"
            )}
            aria-hidden
          />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void apply({ kind: "human" })}>{t("me")}</DropdownMenuItem>
        {characters.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("character")}
            </DropdownMenuLabel>
            {characters.map((c) => (
              <DropdownMenuItem
                key={c.id}
                onClick={() => void apply({ kind: "character", id: c.id, label: c.name })}
              >
                {c.name}
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void apply(null)}>{t("unassign")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
