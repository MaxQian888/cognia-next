"use client"

/**
 * Workspace settings → Overview section.
 *
 * Eager-save: every field persists through the store on its own (debounced)
 * commit via `EditableSettingRow` — no section-level Save button. The save
 * indicator in the Settings header reflects the latest write.
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam } from "@/types/agent/agent-team"

import { EditableSettingRow } from "./editable-setting-row"

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

export interface OverviewSectionProps {
  team: AgentTeam
}

export function OverviewSection({ team }: OverviewSectionProps) {
  const t = useTranslations("agentTeamsWorkspace.settings")
  const tMode = useTranslations("agentTeamsWorkspace.settings.executionModeOption")
  const tPattern = useTranslations("agentTeamsWorkspace.settings.executionPatternOption")
  const tExecutors = useTranslations("agentTeamsWorkspace.autoCompose.executors")
  const updateTeam = useAgentTeamStore((s) => s.updateTeam)
  const updateTeamConfig = useAgentTeamStore((s) => s.updateTeamConfig)

  const patchConfig = (patch: Partial<AgentTeam["config"]>): void => {
    updateTeamConfig(team.id, { ...team.config, ...patch })
  }

  return (
    <div className="space-y-4">
      {/* General */}
      <Card className="space-y-3 p-4">
        <p className="text-sm font-medium">{t("title")}</p>
        <EditableSettingRow<string>
          label={t("name")}
          value={team.name}
          onCommit={(v) => updateTeam(team.id, { name: v.trim() || team.name })}
          testid="overview-name"
          render={({ value, setValue, commit }) => (
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={commit}
              className="max-w-md"
            />
          )}
        />
        <EditableSettingRow<string>
          label={t("description")}
          value={team.description ?? ""}
          onCommit={(v) => updateTeam(team.id, { description: v.trim() || undefined })}
          testid="overview-description"
          render={({ value, setValue, commit }) => (
            <Textarea
              rows={3}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={commit}
              className="max-w-2xl text-xs"
            />
          )}
        />
      </Card>

      {/* Execution */}
      <Card className="space-y-3 p-4">
        <p className="text-sm font-medium">{t("sectionExecution")}</p>
        {team.dispatchDecision || team.externalPickup ? (
          <div className="flex flex-wrap items-center gap-2">
            {team.dispatchDecision ? (
              <div
                className="flex items-center gap-2"
                data-testid="overview-dispatch-decision"
                title={team.dispatchDecision.reason}
              >
                <span className="text-muted-foreground text-xs">{t("dispatchDecisionLabel")}</span>
                <Badge variant="outline">{tExecutors(team.dispatchDecision.kind)}</Badge>
              </div>
            ) : null}
            {team.externalPickup && !team.externalPickup.claimedAt ? (
              <Badge variant="secondary" data-testid="overview-awaiting-external">
                {t("awaitingExternalPickup")}
              </Badge>
            ) : null}
            {team.externalPickup?.claimedAt && team.externalPickup.claimedBy ? (
              <Badge variant="secondary" data-testid="overview-external-claimed">
                {t("externalClaimedBy", { claimer: team.externalPickup.claimedBy })}
              </Badge>
            ) : null}
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <EditableSettingRow<string>
            label={t("executionMode")}
            value={team.config.executionMode ?? "coordinated"}
            onCommit={(v) =>
              patchConfig({ executionMode: v as AgentTeam["config"]["executionMode"] })
            }
            debounceMs={0}
            render={({ value, setValue }) => (
              <Select value={value} onValueChange={setValue}>
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
            )}
          />
          <EditableSettingRow<string>
            label={t("executionPattern")}
            value={team.config.preferredExecutionPattern ?? "manager_worker"}
            onCommit={(v) =>
              patchConfig({
                preferredExecutionPattern: v as AgentTeam["config"]["preferredExecutionPattern"],
              })
            }
            debounceMs={0}
            render={({ value, setValue }) => (
              <Select value={value} onValueChange={setValue}>
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
            )}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <EditableSettingRow<string>
            label={t("maxConcurrent")}
            value={String(team.config.maxConcurrentTeammates ?? 5)}
            onCommit={(v) =>
              patchConfig({ maxConcurrentTeammates: Math.max(1, parseInt(v, 10) || 5) })
            }
            render={({ value, setValue, commit }) => (
              <Input
                type="number"
                min={1}
                max={20}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onBlur={commit}
                className="h-8 text-xs"
              />
            )}
          />
          <EditableSettingRow<string>
            label={t("tokenBudget")}
            value={String(team.config.tokenBudget ?? 0)}
            onCommit={(v) => patchConfig({ tokenBudget: parseInt(v, 10) || 0 })}
            render={({ value, setValue, commit }) => (
              <Input
                type="number"
                min={0}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onBlur={commit}
                className="h-8 text-xs"
              />
            )}
          />
        </div>
      </Card>

      {/* Toggles */}
      <Card className="space-y-3 p-4">
        <p className="text-sm font-medium">{t("sectionControls")}</p>
        <div className="space-y-3">
          <EditableSettingRow<boolean>
            label={t("autoShutdown")}
            value={team.config.autoShutdown ?? true}
            onCommit={(v) => patchConfig({ autoShutdown: v })}
            debounceMs={0}
            render={({ value, setValue }) => (
              <div className="flex items-center justify-between">
                <span className="sr-only">{t("autoShutdown")}</span>
                <Switch checked={value} onCheckedChange={setValue} />
              </div>
            )}
          />
          <EditableSettingRow<boolean>
            label={t("enableMessaging")}
            value={team.config.enableMessaging ?? true}
            onCommit={(v) => patchConfig({ enableMessaging: v })}
            debounceMs={0}
            render={({ value, setValue }) => (
              <div className="flex items-center justify-between">
                <span className="sr-only">{t("enableMessaging")}</span>
                <Switch checked={value} onCheckedChange={setValue} />
              </div>
            )}
          />
          <EditableSettingRow<boolean>
            label={t("streamProgress")}
            value={team.config.streamProgress ?? true}
            onCommit={(v) => patchConfig({ streamProgress: v })}
            debounceMs={0}
            render={({ value, setValue }) => (
              <div className="flex items-center justify-between">
                <span className="sr-only">{t("streamProgress")}</span>
                <Switch checked={value} onCheckedChange={setValue} />
              </div>
            )}
          />
          <EditableSettingRow<boolean>
            label={t("requirePlanApproval")}
            value={team.config.requirePlanApproval ?? false}
            onCommit={(v) => patchConfig({ requirePlanApproval: v })}
            debounceMs={0}
            render={({ value, setValue }) => (
              <div className="flex items-center justify-between">
                <span className="sr-only">{t("requirePlanApproval")}</span>
                <Switch checked={value} onCheckedChange={setValue} />
              </div>
            )}
          />
          <EditableSettingRow<boolean>
            label={t("riskGating")}
            value={team.config.riskGating ?? true}
            onCommit={(v) => patchConfig({ riskGating: v })}
            debounceMs={0}
            render={({ value, setValue }) => (
              <div className="flex items-center justify-between">
                <span className="sr-only">{t("riskGating")}</span>
                <Switch checked={value} onCheckedChange={setValue} />
              </div>
            )}
          />
          <EditableSettingRow<string>
            label={t("maxRetries")}
            value={String(team.config.maxRetries ?? 3)}
            onCommit={(v) => patchConfig({ maxRetries: Math.max(0, parseInt(v, 10) || 0) })}
            render={({ value, setValue, commit }) => (
              <Input
                type="number"
                min={0}
                max={10}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onBlur={commit}
                className="h-8 w-24 text-xs"
              />
            )}
          />
        </div>
      </Card>
    </div>
  )
}
