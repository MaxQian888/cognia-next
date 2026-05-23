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
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { toast } from "sonner"

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam } from "@/types/agent/agent-team"
import { createLogger } from "@/lib/logging"

import { OverviewSection } from "./settings/section-overview"
import { PluginsSection } from "./settings/section-plugins"
import { GovernanceSection } from "./settings/section-governance"
import { MemorySection } from "./settings/section-memory"

const log = createLogger("agentTeams.settings")

export interface AgentTeamSettingsProps {
  team: AgentTeam
}

export function AgentTeamSettings({ team }: AgentTeamSettingsProps) {
  const t = useTranslations("agentTeamsWorkspace.settings")
  const tCommon = useTranslations("agentTeamsWorkspace")
  const router = useRouter()

  const updateTeam = useAgentTeamStore((s) => s.updateTeam)
  const updateTeamConfig = useAgentTeamStore((s) => s.updateTeamConfig)
  const deleteTeam = useAgentTeamStore((s) => s.deleteTeam)

  // Overview-section local state. Persisted on explicit Save (matches the
  // pre-refactor UX). The other sections persist eagerly through the store.
  const [name, setName] = useState(team.name)
  const [description, setDescription] = useState(team.description ?? "")
  const [executionMode, setExecutionMode] = useState<string>(
    team.config.executionMode ?? "coordinated"
  )
  const [executionPattern, setExecutionPattern] = useState<string>(
    team.config.preferredExecutionPattern ?? "manager_worker"
  )
  const [maxConcurrent, setMaxConcurrent] = useState(
    String(team.config.maxConcurrentTeammates ?? 5)
  )
  const [tokenBudget, setTokenBudget] = useState(String(team.config.tokenBudget ?? 0))
  const [autoShutdown, setAutoShutdown] = useState(team.config.autoShutdown ?? true)
  const [enableMessaging, setEnableMessaging] = useState(team.config.enableMessaging ?? true)
  const [requirePlanApproval, setRequirePlanApproval] = useState(
    team.config.requirePlanApproval ?? false
  )
  const [maxRetries, setMaxRetries] = useState(String(team.config.maxRetries ?? 3))
  const [deleteConfirmText, setDeleteConfirmText] = useState("")
  const [saving, setSaving] = useState(false)

  const handleSave = () => {
    setSaving(true)
    try {
      updateTeam(team.id, {
        name: name.trim() || team.name,
        description: description.trim() || undefined,
      })
      updateTeamConfig(team.id, {
        ...team.config,
        executionMode: executionMode as AgentTeam["config"]["executionMode"],
        preferredExecutionPattern:
          executionPattern as AgentTeam["config"]["preferredExecutionPattern"],
        maxConcurrentTeammates: Math.max(1, parseInt(maxConcurrent, 10) || 5),
        tokenBudget: parseInt(tokenBudget, 10) || 0,
        autoShutdown: autoShutdown,
        enableMessaging: enableMessaging,
        requirePlanApproval: requirePlanApproval,
        maxRetries: Math.max(0, parseInt(maxRetries, 10) || 0),
      })
      log.info("team_settings_updated", { id: team.id })
      toast.success(t("saved"))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = () => {
    deleteTeam(team.id)
    log.info("team_deleted", { id: team.id })
    toast.success(tCommon("teamDeleted", { name: team.name }))
    router.push("/agent-teams")
  }

  return (
    <div className="space-y-4" data-testid="workspace-settings">
      <Accordion type="multiple" defaultValue={["overview"]} className="space-y-2">
        <AccordionItem value="overview" className="border-none">
          <AccordionTrigger className="rounded-md bg-muted/40 px-3 text-sm font-medium">
            {t("accordion.overview")}
          </AccordionTrigger>
          <AccordionContent className="pt-3">
            <OverviewSection
              team={team}
              name={name}
              setName={setName}
              description={description}
              setDescription={setDescription}
              executionMode={executionMode}
              setExecutionMode={setExecutionMode}
              executionPattern={executionPattern}
              setExecutionPattern={setExecutionPattern}
              maxConcurrent={maxConcurrent}
              setMaxConcurrent={setMaxConcurrent}
              tokenBudget={tokenBudget}
              setTokenBudget={setTokenBudget}
              autoShutdown={autoShutdown}
              setAutoShutdown={setAutoShutdown}
              enableMessaging={enableMessaging}
              setEnableMessaging={setEnableMessaging}
              requirePlanApproval={requirePlanApproval}
              setRequirePlanApproval={setRequirePlanApproval}
              maxRetries={maxRetries}
              setMaxRetries={setMaxRetries}
            />
            <div className="flex justify-end pt-2">
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? t("saving") : t("save")}
              </Button>
            </div>
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

        <AccordionItem value="memory" className="border-none">
          <AccordionTrigger className="rounded-md bg-muted/40 px-3 text-sm font-medium">
            {t("accordion.memory")}
          </AccordionTrigger>
          <AccordionContent className="pt-3">
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
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm">
              {t("deleteAction")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{tCommon("deleteTeam")}</AlertDialogTitle>
              <AlertDialogDescription>{t("deleteWarning")}</AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-1">
              <Label className="text-xs">{t("typeToConfirm", { name: team.name })}</Label>
              <Input
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder={team.name}
                className="h-8 text-xs"
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={deleteConfirmText !== team.name}
                onClick={handleDelete}
              >
                {t("deleteAction")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Card>
    </div>
  )
}
