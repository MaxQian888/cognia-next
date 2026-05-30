"use client"

/**
 * Workspace settings → Ultracode section (ADR-0022 addendum).
 *
 * Toggles the ultracode multi-agent orchestration mode and its fan-out knobs.
 * When enabled, `autoMode` decides whether a complex task auto-orchestrates
 * (`auto`, the default), always does, or never does. Patches the team config
 * in place via `updateTeamConfig`, matching the governance section's eager-save
 * pattern.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"

import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
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

export interface UltracodeSectionProps {
  team: AgentTeam
}

type UltracodeConfig = NonNullable<AgentTeamConfig["ultracode"]>

const AUTO_MODES: ReadonlyArray<NonNullable<UltracodeConfig["autoMode"]>> = [
  "auto",
  "always",
  "never",
]

function clampInt(value: string, min: number, max: number, fallback: number): number {
  const n = parseInt(value, 10)
  if (Number.isNaN(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

export function UltracodeSection({ team }: UltracodeSectionProps) {
  const t = useTranslations("agentTeamsWorkspace.settings.ultracode")
  const updateTeamConfig = useAgentTeamStore((s) => s.updateTeamConfig)

  const uc: UltracodeConfig = team.config.ultracode ?? {}
  const enabled = uc.enabled === true

  const patchUltracode = useCallback(
    (patch: Partial<UltracodeConfig>) => {
      updateTeamConfig(team.id, {
        ...team.config,
        ultracode: { ...team.config.ultracode, ...patch },
      })
      markSettingsSaved()
    },
    [team.config, team.id, updateTeamConfig]
  )

  const patchWorkingDir = useCallback(
    (value: string) => {
      updateTeamConfig(team.id, { ...team.config, workingDir: value.trim() || undefined })
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
          onCheckedChange={(v) => patchUltracode({ enabled: v })}
          aria-label={t("enabled")}
        />
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{t("autoMode.label")}</Label>
        <Select
          value={uc.autoMode ?? "auto"}
          onValueChange={(v) => patchUltracode({ autoMode: v as UltracodeConfig["autoMode"] })}
          disabled={!enabled}
        >
          <SelectTrigger className="h-8 text-xs" aria-label={t("autoMode.label")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUTO_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {t(`autoMode.option.${mode}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          {t(`autoMode.hint.${uc.autoMode ?? "auto"}`)}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="space-y-1">
          <Label className="text-xs">{t("skepticsPerFinding")}</Label>
          <Input
            type="number"
            min={1}
            max={16}
            value={uc.skepticsPerFinding ?? 3}
            disabled={!enabled}
            onChange={(e) =>
              patchUltracode({ skepticsPerFinding: clampInt(e.target.value, 1, 16, 3) })
            }
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("judgesPerAttempt")}</Label>
          <Input
            type="number"
            min={1}
            max={16}
            value={uc.judgesPerAttempt ?? 3}
            disabled={!enabled}
            onChange={(e) =>
              patchUltracode({ judgesPerAttempt: clampInt(e.target.value, 1, 16, 3) })
            }
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("maxFinderRounds")}</Label>
          <Input
            type="number"
            min={1}
            max={20}
            value={uc.maxFinderRounds ?? 4}
            disabled={!enabled}
            onChange={(e) =>
              patchUltracode({ maxFinderRounds: clampInt(e.target.value, 1, 20, 4) })
            }
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("dryRoundsToStop")}</Label>
          <Input
            type="number"
            min={1}
            max={10}
            value={uc.dryRoundsToStop ?? 2}
            disabled={!enabled}
            onChange={(e) =>
              patchUltracode({ dryRoundsToStop: clampInt(e.target.value, 1, 10, 2) })
            }
            className="h-8 text-xs"
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{t("workingDir.label")}</Label>
        <Input
          value={team.config.workingDir ?? ""}
          disabled={!enabled}
          onChange={(e) => patchWorkingDir(e.target.value)}
          placeholder={t("workingDir.placeholder")}
          className="h-8 text-xs"
        />
        <p className="text-[11px] text-muted-foreground">{t("workingDir.hint")}</p>
      </div>
    </Card>
  )
}
