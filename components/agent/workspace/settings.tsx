"use client"

/**
 * Workspace settings tab composer.
 *
 * Splits what was a single flat card stack into four collapsible accordion
 * sections — Overview / Plugins / Governance / Memory — each in its own
 * file under `settings/`. The historical save / delete path stays on this
 * file because the Overview state lives here; the new sections persist
 * their patches eagerly through the store so they need no save button.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { AlertTriangleIcon } from "lucide-react"

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { toast } from "sonner"

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam } from "@/types/agent/agent-team"
import { createLogger } from "@cognia/logging"

import { OverviewSection } from "./settings/section-overview"
import { PluginsSection } from "./settings/section-plugins"
import { GovernanceSection } from "./settings/section-governance"
import { ExecutionSection } from "./settings/section-execution"
import { UltracodeSection } from "./settings/section-ultracode"
import { WorktreesSection } from "./settings/section-worktrees"
import { PrFeedbackSection } from "./settings/section-pr-feedback"
import { StackedDeliverySection } from "./settings/section-stacked-delivery"
import { MemorySection } from "./settings/section-memory"
import { TeamKnowledgeTwinsCard } from "./settings/team-knowledge-twins-card"
import { SettingsSaveIndicator } from "./settings/settings-save-indicator"
import { ConfirmActionDialog } from "./settings/confirm-action-dialog"

const log = createLogger("agentTeams.settings")

export interface AgentTeamSettingsProps {
  team: AgentTeam
}

export function AgentTeamSettings({ team }: AgentTeamSettingsProps) {
  const t = useTranslations("agentTeamsWorkspace.settings")
  const tCommon = useTranslations("agentTeamsWorkspace")
  const router = useRouter()

  const deleteTeam = useAgentTeamStore((s) => s.deleteTeam)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const handleDelete = () => {
    deleteTeam(team.id)
    log.info("team_deleted", { id: team.id })
    toast.success(tCommon("teamDeleted", { name: team.name }))
    router.push("/agent-teams")
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4" data-testid="workspace-settings">
      <SettingsSaveIndicator teamId={team.id} />
      <Accordion type="multiple" defaultValue={["overview"]} className="space-y-2">
        <AccordionItem value="overview" className="border-none">
          <AccordionTrigger className="rounded-md bg-muted/40 px-3 text-sm font-medium">
            {t("accordion.overview")}
          </AccordionTrigger>
          <AccordionContent className="pt-3">
            <OverviewSection team={team} />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="plugins" className="border-none">
          <AccordionTrigger className="rounded-md bg-muted/40 px-3 text-sm font-medium">
            {t("accordion.plugins")}
          </AccordionTrigger>
          <AccordionContent className="pt-3">
            <PluginsSection team={team} />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="governance" className="border-none">
          <AccordionTrigger className="rounded-md bg-muted/40 px-3 text-sm font-medium">
            {t("accordion.governance")}
          </AccordionTrigger>
          <AccordionContent className="pt-3">
            <GovernanceSection team={team} />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="execution" className="border-none">
          <AccordionTrigger className="rounded-md bg-muted/40 px-3 text-sm font-medium">
            {t("accordion.execution")}
          </AccordionTrigger>
          <AccordionContent className="pt-3">
            <ExecutionSection team={team} />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="ultracode" className="border-none">
          <AccordionTrigger className="rounded-md bg-muted/40 px-3 text-sm font-medium">
            {t("accordion.ultracode")}
          </AccordionTrigger>
          <AccordionContent className="pt-3">
            <UltracodeSection team={team} />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="worktrees" className="border-none">
          <AccordionTrigger className="rounded-md bg-muted/40 px-3 text-sm font-medium">
            {t("accordion.worktrees")}
          </AccordionTrigger>
          <AccordionContent className="pt-3">
            <WorktreesSection team={team} />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="prFeedback" className="border-none">
          <AccordionTrigger className="rounded-md bg-muted/40 px-3 text-sm font-medium">
            {t("accordion.prFeedback")}
          </AccordionTrigger>
          <AccordionContent className="pt-3">
            <PrFeedbackSection team={team} />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="stackedDelivery" className="border-none">
          <AccordionTrigger className="rounded-md bg-muted/40 px-3 text-sm font-medium">
            {t("accordion.stackedDelivery")}
          </AccordionTrigger>
          <AccordionContent className="pt-3">
            <StackedDeliverySection team={team} />
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="memory" className="border-none">
          <AccordionTrigger className="rounded-md bg-muted/40 px-3 text-sm font-medium">
            {t("accordion.memory")}
          </AccordionTrigger>
          <AccordionContent className="space-y-3 pt-3">
            <TeamKnowledgeTwinsCard team={team} />
            <MemorySection team={team} />
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <Separator />

      {/* Danger Zone */}
      <Card className="space-y-3 border-destructive/30 p-4">
        <div className="flex items-center gap-2">
          <AlertTriangleIcon className="size-4 text-destructive" />
          <p className="text-sm font-medium text-destructive">{t("dangerZone")}</p>
        </div>
        <p className="text-xs text-muted-foreground">{t("deleteWarning")}</p>
        <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
          {t("deleteAction")}
        </Button>
        <ConfirmActionDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={tCommon("deleteTeam")}
          description={t("deleteWarning")}
          confirmLabel={t("deleteAction")}
          cancelLabel={t("cancel")}
          typeToConfirm={team.name}
          typeToConfirmLabel={t("typeToConfirm", { name: team.name })}
          typeToConfirmPlaceholder={team.name}
          onConfirm={handleDelete}
        />
      </Card>
    </div>
  )
}
