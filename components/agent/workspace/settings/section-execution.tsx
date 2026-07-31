"use client"

/**
 * Workspace settings → Execution section (ADR-0090 Phase 7).
 *
 * The TEAM-level writers for the two execution-authority knobs that
 * previously had readers only:
 *   - `defaultExecution` — the team default every `inherit` member resolves
 *     to (reuses the same binding field as the per-member editor, so the
 *     delegation-mode preview stays consistent);
 *   - `maxTeamDelegationDepth` — the team→team delegation depth cap
 *     (default 2; depth 0/1/2 may delegate, deeper is refused).
 * Eager-saves the team config in place, matching the sibling sections.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"

import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { TeammateExecutionBindingField } from "@/components/agent/team/teammate-execution-binding-field"
import type { AgentTeam, TeammateExecutionBinding } from "@/types/agent/agent-team"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { DEFAULT_MAX_TEAM_DELEGATION_DEPTH } from "@/lib/ai/agent/team/delegation-orchestrator"
import { markSettingsSaved } from "./settings-save-indicator"

export interface ExecutionSectionProps {
  team: AgentTeam
}

export function ExecutionSection({ team }: ExecutionSectionProps) {
  const t = useTranslations("agentTeamsWorkspace.settings.execution")
  const updateTeamConfig = useAgentTeamStore((s) => s.updateTeamConfig)

  const saveDefaultExecution = useCallback(
    (execution: TeammateExecutionBinding | undefined) => {
      updateTeamConfig(team.id, { ...team.config, defaultExecution: execution })
      markSettingsSaved()
    },
    [team.id, team.config, updateTeamConfig]
  )

  const saveMaxDepth = useCallback(
    (raw: string) => {
      const parsed = Number.parseInt(raw, 10)
      updateTeamConfig(team.id, {
        ...team.config,
        maxTeamDelegationDepth:
          Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_TEAM_DELEGATION_DEPTH,
      })
      markSettingsSaved()
    },
    [team.id, team.config, updateTeamConfig]
  )

  return (
    <Card className="space-y-4 p-4" data-testid="execution-section">
      <div>
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <TeammateExecutionBindingField
        value={team.config.defaultExecution}
        onChange={saveDefaultExecution}
      />

      <div className="space-y-1">
        <Label className="text-xs" htmlFor="max-team-delegation-depth">
          {t("maxDelegationDepth")}
        </Label>
        <Input
          id="max-team-delegation-depth"
          type="number"
          min={0}
          max={10}
          className="h-8 w-24 text-xs"
          defaultValue={team.config.maxTeamDelegationDepth ?? DEFAULT_MAX_TEAM_DELEGATION_DEPTH}
          onBlur={(e) => saveMaxDepth(e.target.value)}
        />
        <p className="text-[10px] text-muted-foreground">{t("maxDelegationDepthHint")}</p>
      </div>
    </Card>
  )
}
