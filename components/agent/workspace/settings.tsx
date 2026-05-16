"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { AlertTriangleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { toast } from "sonner"

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam } from "@/types/agent/agent-team"
import { createLogger } from "@/lib/logger"

const log = createLogger("agentTeams.settings")

const EXECUTION_MODES: ReadonlyArray<{ value: string; labelKey: string }> = [
  { value: "coordinated", labelKey: "coordinated" },
  { value: "autonomous", labelKey: "autonomous" },
  { value: "delegate", labelKey: "delegate" },
]

const EXECUTION_PATTERNS: ReadonlyArray<{ value: string; labelKey: string }> = [
  { value: "manager_worker", labelKey: "managerWorker" },
  { value: "parallel_specialists", labelKey: "parallelSpecialists" },
  { value: "background_handoff", labelKey: "backgroundHandoff" },
  { value: "external_handoff", labelKey: "externalHandoff" },
  { value: "single_agent_recommended", labelKey: "singleAgent" },
]

export interface AgentTeamSettingsProps {
  team: AgentTeam
}

export function AgentTeamSettings({ team }: AgentTeamSettingsProps) {
  const t = useTranslations("agentTeamsWorkspace.settings")
  const tCommon = useTranslations("agentTeamsWorkspace")
  const tMode = useTranslations("agentTeamsWorkspace.settings.executionModeOption")
  const tPattern = useTranslations("agentTeamsWorkspace.settings.executionPatternOption")
  const router = useRouter()

  const updateTeam = useAgentTeamStore((s) => s.updateTeam)
  const updateTeamConfig = useAgentTeamStore((s) => s.updateTeamConfig)
  const deleteTeam = useAgentTeamStore((s) => s.deleteTeam)

  const [name, setName] = useState(team.name)
  const [description, setDescription] = useState(team.description ?? "")
  const [executionMode, setExecutionMode] = useState(team.config.executionMode ?? "coordinated")
  const [executionPattern, setExecutionPattern] = useState(
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
      {/* General */}
      <Card className="space-y-3 p-4">
        <p className="text-sm font-medium">{t("title")}</p>
        <div className="space-y-1">
          <Label className="text-xs">{t("name")}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-md" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("description")}</Label>
          <Textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="max-w-2xl text-xs"
          />
        </div>
      </Card>

      {/* Execution */}
      <Card className="space-y-3 p-4">
        <p className="text-sm font-medium">{t("sectionExecution")}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">{t("executionMode")}</Label>
            <Select
              value={executionMode}
              onValueChange={(v) => setExecutionMode(v as typeof executionMode)}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXECUTION_MODES.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {tMode(m.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("executionPattern")}</Label>
            <Select
              value={executionPattern}
              onValueChange={(v) => setExecutionPattern(v as typeof executionPattern)}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXECUTION_PATTERNS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {tPattern(p.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">{t("maxConcurrent")}</Label>
            <Input
              type="number"
              min={1}
              max={20}
              value={maxConcurrent}
              onChange={(e) => setMaxConcurrent(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("tokenBudget")}</Label>
            <Input
              type="number"
              min={0}
              value={tokenBudget}
              onChange={(e) => setTokenBudget(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
        </div>
      </Card>

      {/* Toggles */}
      <Card className="space-y-3 p-4">
        <p className="text-sm font-medium">{t("sectionControls")}</p>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-xs">{t("autoShutdown")}</Label>
            <Switch checked={autoShutdown} onCheckedChange={setAutoShutdown} />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-xs">{t("enableMessaging")}</Label>
            <Switch checked={enableMessaging} onCheckedChange={setEnableMessaging} />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-xs">{t("requirePlanApproval")}</Label>
            <Switch checked={requirePlanApproval} onCheckedChange={setRequirePlanApproval} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("maxRetries")}</Label>
            <Input
              type="number"
              min={0}
              max={10}
              value={maxRetries}
              onChange={(e) => setMaxRetries(e.target.value)}
              className="h-8 w-24 text-xs"
            />
          </div>
        </div>
      </Card>

      {/* Save */}
      <div className="flex justify-end">
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? t("saving") : t("save")}
        </Button>
      </div>

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
