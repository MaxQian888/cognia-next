"use client"

/**
 * Conversation assignee control (CRM, schema v83). A compact chip showing who
 * owns the conversation (kind dot + label) and, on click, lets the operator
 * (re)assign it to themselves ("Me"), to one of the bound characters, to an
 * Agent Team, or unassign it. Writes via setAssignee, which records the
 * transition on the assignment-event trail AND syncs routing (slice 1A:
 * character / team → override routing, human → manual mode, unassign →
 * restore); the Notification Center is told afterwards. The app is
 * single-user, so "human" carries no id.
 *
 * Mirrors LifecycleStatusChip's shape (DropdownMenu + write + toast on error).
 */

import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useCharacters } from "@/lib/data-hooks/context"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { setAssignee, type ConversationAssignee } from "@/lib/db/conversation-overrides"
import { notifyAssignmentChanged } from "@/lib/connectors/assignment/notify-assignment"

const KIND_DOT: Record<ConversationAssignee["kind"], string> = {
  human: "bg-indigo-500",
  character: "bg-violet-500",
  team: "bg-teal-500",
}

export interface AssigneeChipProps {
  conversationKey: string
  sessionId: string
  /** Bus-level adapter id — stamped on the routing-sync audit row. */
  adapterId?: string
  assignee?: ConversationAssignee
}

export function AssigneeChip({
  conversationKey,
  sessionId,
  adapterId,
  assignee,
}: AssigneeChipProps) {
  const t = useTranslations("inbox.assignee")
  const characters = useCharacters() ?? []
  const teamsById = useAgentTeamStore((s) => s.teams)
  const teams = Object.values(teamsById ?? {}).sort((a, b) => a.name.localeCompare(b.name))

  const apply = async (next: ConversationAssignee | null) => {
    try {
      await setAssignee(conversationKey, next, { sessionId, via: "manual", adapterId })
      await notifyAssignmentChanged({
        conversationKey,
        from: assignee ?? null,
        to: next,
        via: "manual",
      })
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
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => void apply({ kind: "human" })}>
            {t("me")}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {characters.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
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
            </DropdownMenuGroup>
          </>
        )}
        {teams.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t("team")}
              </DropdownMenuLabel>
              {teams.map((team) => (
                <DropdownMenuItem
                  key={team.id}
                  data-testid={`assignee-team-${team.id}`}
                  onClick={() => void apply({ kind: "team", id: team.id, label: team.name })}
                >
                  {team.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => void apply(null)}>{t("unassign")}</DropdownMenuItem>
        </DropdownMenuGroup>
        <p className="px-2 pb-1 pt-1.5 text-[10px] leading-snug text-muted-foreground">
          {t("routingSynced")}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
