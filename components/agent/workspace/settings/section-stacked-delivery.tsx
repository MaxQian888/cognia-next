"use client"

/**
 * Workspace settings → stacked delivery (ADR — stacks as first-class).
 *
 * The write surface for `githubDeliveryPolicy`, which the runtime has read in
 * three places and nothing has ever written: a team could not turn stacked
 * delivery on from anywhere in the app. Off by default, and deliberately so —
 * turning it on rewrites how a completed run reaches GitHub.
 *
 * Renders everywhere; the behaviour behind it is desktop + GitHub remote only,
 * which the caveat says rather than the card pretending otherwise.
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
import type { AgentTeam } from "@/types/agent/agent-team"
import type { AgentTeamGithubDeliveryPolicy } from "@/types/agent/agent-team-runtime"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { STACKED_DELIVERY_DEFAULTS, stackedDeliveryOn } from "@/lib/stack/team-policy"
import { markSettingsSaved } from "./settings-save-indicator"

export interface StackedDeliverySectionProps {
  team: AgentTeam
}

export { STACKED_DELIVERY_DEFAULTS, stackedDeliveryOn }

export const MIN_LAYER_CHOICES = [2, 3, 4, 5] as const
export const MAX_LAYER_CHOICES = [5, 10, 20, 50] as const

export function StackedDeliverySection({ team }: StackedDeliverySectionProps) {
  const t = useTranslations("agentTeamsWorkspace.settings.stackedDelivery")
  const updateTeamConfig = useAgentTeamStore((s) => s.updateTeamConfig)

  const policy = team.config.githubDeliveryPolicy
  const on = stackedDeliveryOn(policy)
  const current = policy ?? STACKED_DELIVERY_DEFAULTS

  const patch = useCallback(
    (next: Partial<AgentTeamGithubDeliveryPolicy>) => {
      updateTeamConfig(team.id, {
        ...team.config,
        githubDeliveryPolicy: {
          ...STACKED_DELIVERY_DEFAULTS,
          ...team.config.githubDeliveryPolicy,
          ...next,
        },
      })
      markSettingsSaved()
    },
    [team.config, team.id, updateTeamConfig]
  )

  return (
    <Card className="space-y-4 p-4">
      <p className="text-sm font-medium">{t("title")}</p>
      <p className="text-xs text-muted-foreground">{t("description")}</p>

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label className="text-xs">{t("enabled.label")}</Label>
          <p className="text-[11px] text-muted-foreground">{t("enabled.hint")}</p>
        </div>
        <Switch
          checked={on}
          onCheckedChange={(value) => patch({ enabled: value, stackedPullRequests: value })}
          aria-label={t("enabled.label")}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="min-w-0 space-y-1">
          <Label className="text-xs">{t("minLayers.label")}</Label>
          <Select
            value={String(current.minLayers)}
            onValueChange={(value) => patch({ minLayers: Number(value) })}
            disabled={!on}
          >
            <SelectTrigger className="h-8 text-xs" aria-label={t("minLayers.label")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MIN_LAYER_CHOICES.map((count) => (
                <SelectItem key={count} value={String(count)}>
                  {t("layerCount", { count })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="min-w-0 space-y-1">
          <Label className="text-xs">{t("maxLayers.label")}</Label>
          <Select
            value={String(current.maxLayers)}
            onValueChange={(value) => patch({ maxLayers: Number(value) })}
            disabled={!on}
          >
            <SelectTrigger className="h-8 text-xs" aria-label={t("maxLayers.label")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MAX_LAYER_CHOICES.map((count) => (
                <SelectItem key={count} value={String(count)}>
                  {t("layerCount", { count })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("minLayers.hint")}</p>

      {/*
        One merge order exists and the type has one member. Stated as a fact
        rather than offered as a dropdown of one, so nobody reads a choice into
        it — and so the day a second order appears, this line is what changes.
      */}
      <div className="flex items-baseline justify-between gap-4">
        <Label className="text-xs">{t("mergeMode.label")}</Label>
        <p className="text-[11px] text-muted-foreground">{t("mergeMode.approvedBottomUp")}</p>
      </div>

      <p className="text-[11px] text-muted-foreground">{t("caveat")}</p>
    </Card>
  )
}
