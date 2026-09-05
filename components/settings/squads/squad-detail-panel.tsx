"use client"

/**
 * One Squad's identity and roster.
 *
 * The roster is the real editor, not a read-only list. Adding, removing and
 * configuring a teammate lived only in a tab of `/agent-teams/workspace`, and
 * when ADR-0140 retired that route the affordance went with it: the only way
 * left to put anyone in a Squad was to instantiate a template, so a Squad made
 * with "New Squad" was permanently a lead with nobody to lead. This panel's own
 * copy already promised "add teammates from a template, or from the Squad's own
 * run surface"; the second half had stopped being true.
 *
 * `AgentTeamMembers` is mounted whole for the same reason `AgentTeamSettings`
 * is: it already composes the member rows, the configure dialog and the
 * `agent.teammate.actions` plugin slot, and a second composition would be two
 * places to keep in step.
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
import { ChevronRightIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { SquadDeriveActions } from "./squad-derive-actions"
import { SquadReadinessCard } from "@/components/squads/squad-readiness-card"
import { SquadTemplateProvenance } from "./squad-template-provenance"
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
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { DeferredTextInput } from "@/components/settings/common/deferred-text-input"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { AgentTeamSettings } from "@/components/agent/workspace/settings"
import { AgentTeamMembers } from "@/components/agent/workspace/members"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
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
  const tasksRecord = useAgentTeamStore((s) => s.tasks)
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

  // Counted from the tasks themselves rather than from `squad.taskIds`, which
  // is a denormalised list the plugin context has no reason to trust.
  const taskStats = useMemo(() => {
    const tasks = Object.values(tasksRecord ?? {}).filter((task) => task.teamId === squadId)
    return {
      total: tasks.length,
      completed: tasks.filter((task) => task.status === "completed").length,
    }
  }, [tasksRecord, squadId])

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

      <div className="space-y-2" data-testid="squad-detail-roster">
        <div className="flex items-center gap-2">
          <Label className="text-xs">{t("rosterLabel")}</Label>
          <span className="text-xs text-muted-foreground">
            {t("memberCount", { count: members.length })}
          </span>
        </div>
        <AgentTeamMembers team={squad} teammates={members} leadId={squad.leadId} />
      </div>

      {/* Whether this Squad can run, and the one-click fixes when it cannot
          (ADR-0169). The two bindings the coordinator needs are edited here
          and nowhere else. */}
      <SquadReadinessCard squadId={squadId} />

      {/* Plugin-contributed Squad insight / governance panels. Context carries
          ids and counts only, never task or message bodies.

          Its declared host was `workspace/overview.tsx`, a tab of the retired
          `/agent-teams/workspace`. Nothing rendered that file any more, so a
          plugin could register here and the contribution simply never appeared,
          with `audit:slots` green throughout because it scans files rather than
          the render graph. Governance is what this pane is for, so the slot
          belongs here. */}
      <PluginExtensionSlot
        point="agent.team.panel"
        className="space-y-4"
        context={{
          teamId: squad.id,
          status: squad.status,
          teammateCount: members.filter((m) => m.role === "teammate").length,
          taskCount: taskStats.total,
          completedTaskCount: taskStats.completed,
        }}
      />

      {/* Where this Squad came from. Reads the `TemplateInstanceRecord` whose
          resources name this team, which is the only link a template keeps to
          what it produced, and offers the update / detach half of the
          lifecycle ADR-0100 advertises. */}
      <SquadTemplateProvenance squadId={squadId} className="rounded-md border p-3" />

      <SquadDeriveActions squadId={squadId} className="rounded-md border p-3" />

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
