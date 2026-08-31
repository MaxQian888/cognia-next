"use client"

/**
 * One Squad's identity and roster.
 *
 * Deliberately not the eleven-accordion settings surface the old workspace
 * page carried. What a person needs from a *library* is: what is this called,
 * what is it for, who is on it — and a way to get rid of it. The deep
 * governance knobs stay reachable from the Squad's own run surfaces rather
 * than being fanned out here, where they made the page unreadable.
 *
 * Edits commit on blur/Enter through `DeferredTextInput`, the house pattern
 * for a settings field over a store: keystroke-by-keystroke writes to a
 * persisted store fight the input's own cursor.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon, Trash2Icon, UsersIcon } from "lucide-react"

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
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { DeferredTextInput } from "@/components/settings/common/deferred-text-input"
import { StatusBadge } from "@/components/status-badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { AgentTeamSettings } from "@/components/agent/workspace/settings"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { cn } from "@/lib/utils"

export interface SquadDetailPanelProps {
  squadId: string
  /** Called after a delete so the section can move the selection. */
  onDeleted?: (squadId: string) => void
}

export function SquadDetailPanel({ squadId, onDeleted }: SquadDetailPanelProps) {
  const t = useTranslations("settings.squads.detail")
  const tCommon = useTranslations("common")
  const squad = useAgentTeamStore((s) => s.teams[squadId])
  const teammatesRecord = useAgentTeamStore((s) => s.teammates)
  const updateTeam = useAgentTeamStore((s) => s.updateTeam)
  const deleteTeam = useAgentTeamStore((s) => s.deleteTeam)
  const [descDraft, setDescDraft] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const members = useMemo(
    () =>
      Object.values(teammatesRecord)
        .filter((m) => m.teamId === squadId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [teammatesRecord, squadId]
  )

  if (!squad) {
    // The rail and the resolver both guard against this, so reaching it means
    // the Squad was deleted in another window while this pane was open.
    return (
      <Empty className="h-full rounded-none" data-testid="squad-detail-missing">
        <EmptyTitle className="text-sm">{t("missingTitle")}</EmptyTitle>
        <EmptyDescription className="text-xs">{t("missingDescription")}</EmptyDescription>
      </Empty>
    )
  }

  const description = descDraft ?? squad.description ?? ""

  return (
    <div className="space-y-5" data-testid="squad-detail">
      <div className="space-y-2">
        <Label htmlFor="squad-name" className="text-xs">
          {t("nameLabel")}
        </Label>
        <DeferredTextInput
          id="squad-name"
          data-setting-id="squad-name"
          value={squad.name}
          onCommit={(next) => {
            // An empty name would leave an unclickable row in the rail.
            if (next) updateTeam(squadId, { name: next })
          }}
          className="max-w-md"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="squad-description" className="text-xs">
          {t("descriptionLabel")}
        </Label>
        <Textarea
          id="squad-description"
          data-setting-id="squad-description"
          rows={3}
          value={description}
          onChange={(e) => setDescDraft(e.target.value)}
          onBlur={() => {
            if (descDraft !== null && descDraft !== (squad.description ?? "")) {
              updateTeam(squadId, { description: descDraft })
            }
            setDescDraft(null)
          }}
          className="max-w-md text-sm"
          placeholder={t("descriptionPlaceholder")}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label className="text-xs">{t("rosterLabel")}</Label>
          <span className="text-xs text-muted-foreground">
            {t("memberCount", { count: members.length })}
          </span>
        </div>
        {members.length === 0 ? (
          <Empty
            className="rounded-md border border-dashed py-6"
            data-testid="squad-detail-empty-roster"
          >
            <EmptyTitle className="text-sm">{t("noMembersTitle")}</EmptyTitle>
            <EmptyDescription className="text-xs">{t("noMembersDescription")}</EmptyDescription>
          </Empty>
        ) : (
          <div className="max-w-md divide-y rounded-md border">
            {members.map((member) => (
              <Item key={member.id} size="sm" data-testid="squad-detail-member">
                <ItemMedia>
                  <UsersIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                </ItemMedia>
                <ItemContent className="min-w-0 gap-0.5">
                  <ItemTitle className="block w-full min-w-0 truncate text-xs">
                    {member.name}
                  </ItemTitle>
                  {member.role ? (
                    <ItemDescription className="truncate text-[10px]">
                      {member.role}
                    </ItemDescription>
                  ) : null}
                </ItemContent>
                <StatusBadge
                  value={member.status}
                  labelNamespace="agentTeam.status"
                  className="shrink-0 text-[10px]"
                />
              </Item>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-md border border-destructive/40 p-3">
        <p className="text-xs font-medium">{t("dangerTitle")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("dangerDescription")}</p>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 text-destructive hover:text-destructive"
              data-testid="squad-delete"
            >
              <Trash2Icon className="mr-1.5 size-3.5" />
              {t("deleteAction")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("deleteTitle", { name: squad.name })}</AlertDialogTitle>
              <AlertDialogDescription>{t("deleteBody")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  deleteTeam(squadId)
                  onDeleted?.(squadId)
                }}
              >
                {tCommon("delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/*
        The deep governance knobs, as ONE collapsed group rather than nine more
        rows. The objection above is to fanning them out across the library, not
        to their being reachable: they were only ever editable from a tab of
        `/agent-teams/workspace`, which ADR-0140 retired and took out of
        navigation, so every one of them was about to become unreachable.

        `AgentTeamSettings` is mounted whole rather than its nine sections being
        re-listed here. It already composes them, each section already persists
        eagerly through the store, and a second composition would be two places
        to add the tenth.
      */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 h-8 w-full justify-start text-xs"
            data-testid="squad-advanced-toggle"
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3.5 transition-transform", advancedOpen && "rotate-90")}
            />
            {t("advanced")}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2" data-testid="squad-advanced">
          <AgentTeamSettings team={squad} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

export default SquadDetailPanel
