"use client"

/**
 * One Squad's governance, as nine collapsed accordion sections.
 *
 * Overview / Plugins / Governance / Execution / Ultracode / Worktrees / PR
 * feedback / Stacked delivery / Memory, each in its own file under `settings/`.
 * Every section persists eagerly through the store, so there is no save button
 * and no shared draft state here.
 *
 * It no longer owns deletion. The danger zone here redirected to
 * `/agent-teams`, a route ADR-0140 retired, and `SquadDetailPanel` already had
 * a delete with a type-to-confirm. Two delete paths over one entity is the
 * double-entry-point defect, and this was the copy pointing at a dead route.
 *
 * Mounted by `components/settings/squads/squad-detail-panel.tsx`. That file
 * says the deep knobs must not be "fanned out" across the library, which is
 * why they arrive as one collapsed group under Advanced rather than as nine
 * more rows.
 */

import { useTranslations } from "next-intl"

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"

import type { AgentTeam } from "@/types/agent/agent-team"

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

export interface AgentTeamSettingsProps {
  team: AgentTeam
}

export function AgentTeamSettings({ team }: AgentTeamSettingsProps) {
  const t = useTranslations("agentTeamsWorkspace.settings")

  return (
    <div className="w-full space-y-4" data-testid="workspace-settings">
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
    </div>
  )
}
