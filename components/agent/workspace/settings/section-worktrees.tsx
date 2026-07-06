"use client"

/**
 * Workspace settings → Worktree isolation section (ADR-0022 workspace-isolation
 * addendum). Toggles per-dispatch git-worktree isolation and picks how the
 * per-dispatch agent branches are reconciled once the run settles. Eager-saves
 * the team config in place, matching the ultracode/governance sections.
 *
 * Desktop + git-repo only at runtime; the card renders everywhere but the
 * behavior no-ops off-desktop (surfaced by the caveat text).
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"

import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { AgentTeam, AgentTeamConfig } from "@/types/agent/agent-team"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { markSettingsSaved } from "./settings-save-indicator"

export interface WorktreesSectionProps {
  team: AgentTeam
}

type IsolationConfig = NonNullable<AgentTeamConfig["workspaceIsolation"]>

const RECONCILE_MODES: ReadonlyArray<NonNullable<IsolationConfig["reconcile"]>> = [
  "manual",
  "merge-all",
  "select",
  "pipeline",
]
const SELECT_STRATEGIES: ReadonlyArray<NonNullable<IsolationConfig["selectStrategy"]>> = [
  "manual",
  "first-success",
  "judge",
]
const RETAIN_POLICIES: ReadonlyArray<NonNullable<IsolationConfig["retain"]>> = [
  "keep-winner",
  "prune-losers",
  "all",
]

export function WorktreesSection({ team }: WorktreesSectionProps) {
  const t = useTranslations("agentTeamsWorkspace.settings.worktrees")
  const updateTeamConfig = useAgentTeamStore((s) => s.updateTeamConfig)

  const iso: IsolationConfig = team.config.workspaceIsolation ?? {}
  const enabled = iso.enabled === true
  const mode = iso.reconcile ?? "manual"

  const patch = useCallback(
    (next: Partial<IsolationConfig>) => {
      updateTeamConfig(team.id, {
        ...team.config,
        workspaceIsolation: { ...team.config.workspaceIsolation, ...next },
      })
      markSettingsSaved()
    },
    [team.config, team.id, updateTeamConfig]
  )

  return (
    <Card className="space-y-4 p-4">
      <p className="text-sm font-medium">{t("title")}</p>
      <p className="text-xs text-muted-foreground">{t("description")}</p>

      <div className="flex items-center justify-between">
        <Label className="text-xs">{t("enabled")}</Label>
        <Switch
          checked={enabled}
          onCheckedChange={(v) => patch({ enabled: v })}
          aria-label={t("enabled")}
        />
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{t("reconcile.label")}</Label>
        <Select
          value={mode}
          onValueChange={(v) => patch({ reconcile: v as IsolationConfig["reconcile"] })}
          disabled={!enabled}
        >
          <SelectTrigger className="h-8 text-xs" aria-label={t("reconcile.label")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RECONCILE_MODES.map((m) => (
              <SelectItem key={m} value={m}>
                {t(`reconcile.option.${m}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">{t(`reconcile.hint.${mode}`)}</p>
      </div>

      {mode === "select" && (
        <div className="space-y-1">
          <Label className="text-xs">{t("selectStrategy.label")}</Label>
          <Select
            value={iso.selectStrategy ?? "manual"}
            onValueChange={(v) => patch({ selectStrategy: v as IsolationConfig["selectStrategy"] })}
            disabled={!enabled}
          >
            <SelectTrigger className="h-8 text-xs" aria-label={t("selectStrategy.label")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SELECT_STRATEGIES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`selectStrategy.option.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="space-y-1">
        <Label className="text-xs">{t("retain.label")}</Label>
        <Select
          value={iso.retain ?? "keep-winner"}
          onValueChange={(v) => patch({ retain: v as IsolationConfig["retain"] })}
          disabled={!enabled}
        >
          <SelectTrigger className="h-8 text-xs" aria-label={t("retain.label")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RETAIN_POLICIES.map((r) => (
              <SelectItem key={r} value={r}>
                {t(`retain.option.${r}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <p className="text-[11px] text-muted-foreground">{t("caveat")}</p>
    </Card>
  )
}
