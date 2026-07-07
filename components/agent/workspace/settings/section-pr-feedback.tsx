"use client"

/**
 * Workspace settings → PR feedback loop section (ADR — team PR feedback; ported
 * from agent-orchestrator). Toggles observing each teammate's PR and routing CI /
 * review / merge-conflict feedback back as guarded nudges, plus optional
 * auto-publish and the internal reviewer. Eager-saves in place, matching the
 * worktrees / governance sections.
 *
 * Desktop + git-repo + resolvable GitHub credentials only at runtime; the card
 * renders everywhere but the behavior no-ops otherwise (surfaced by the caveat).
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

export interface PrFeedbackSectionProps {
  team: AgentTeam
}

type PrFeedbackConfig = NonNullable<AgentTeamConfig["prFeedback"]>

/** How long to keep observing after the task DAG completes (ms). 0 = one pass. */
const OBSERVE_WINDOWS: ReadonlyArray<{ key: string; ms: number }> = [
  { key: "onePass", ms: 0 },
  { key: "twoMin", ms: 120_000 },
  { key: "fiveMin", ms: 300_000 },
  { key: "tenMin", ms: 600_000 },
]

export function PrFeedbackSection({ team }: PrFeedbackSectionProps) {
  const t = useTranslations("agentTeamsWorkspace.settings.prFeedback")
  const updateTeamConfig = useAgentTeamStore((s) => s.updateTeamConfig)

  const cfg: PrFeedbackConfig = team.config.prFeedback ?? {}
  const enabled = cfg.enabled === true

  const patch = useCallback(
    (next: Partial<PrFeedbackConfig>) => {
      updateTeamConfig(team.id, {
        ...team.config,
        prFeedback: { ...team.config.prFeedback, ...next },
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

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label className="text-xs">{t("publishPr.label")}</Label>
          <p className="text-[11px] text-muted-foreground">{t("publishPr.hint")}</p>
        </div>
        <Switch
          checked={cfg.publishPr === true}
          onCheckedChange={(v) => patch({ publishPr: v })}
          disabled={!enabled}
          aria-label={t("publishPr.label")}
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label className="text-xs">{t("reviewer.label")}</Label>
          <p className="text-[11px] text-muted-foreground">{t("reviewer.hint")}</p>
        </div>
        <Switch
          checked={cfg.reviewer?.enabled === true}
          onCheckedChange={(v) => patch({ reviewer: { enabled: v } })}
          disabled={!enabled}
          aria-label={t("reviewer.label")}
        />
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{t("observeWindow.label")}</Label>
        <Select
          value={String(cfg.observeWindowMs ?? 0)}
          onValueChange={(v) => patch({ observeWindowMs: Number(v) })}
          disabled={!enabled}
        >
          <SelectTrigger className="h-8 text-xs" aria-label={t("observeWindow.label")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OBSERVE_WINDOWS.map((w) => (
              <SelectItem key={w.key} value={String(w.ms)}>
                {t(`observeWindow.option.${w.key}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">{t("observeWindow.hint")}</p>
      </div>

      <p className="text-[11px] text-muted-foreground">{t("caveat")}</p>
    </Card>
  )
}
