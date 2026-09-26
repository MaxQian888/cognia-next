"use client"

/**
 * Pin a preset-bound agent (a Squad teammate, a subagent template) to ONE of
 * the user's saved external-agent configs of that preset — "Codex strict"
 * rather than any Codex. The default, "Any … config", leaves the pin empty and
 * the dispatch picks a config of the preset in the documented order.
 *
 * The listing and the verdict on the current pin both come from the shared
 * selection rules in `lib/ai/agent/external/config/agent-binding.ts`, so what
 * this field offers and warns about is exactly what dispatch will accept.
 * Disabled configs stay listed (disabled items) so a pin that points at one is
 * still visible and replaceable; a pin whose config is gone shows as a missing
 * entry with the same warning a dispatch would fail with.
 *
 * Renders nothing without a preset: a pin only means something next to one.
 */

import { useId, useMemo } from "react"
import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  checkPinnedExternalAgent,
  listPinnableExternalAgents,
  normalizePinnedConfigId,
  toExternalAgentCandidate,
} from "@/lib/ai/agent/external/config/agent-binding"
import { getPresetDisplayInfo } from "@/lib/ai/agent/external/config/presets"
import { cn } from "@/lib/utils"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

/** Radix reserves the empty string, so "any config" needs a sentinel. */
const ANY_CONFIG_VALUE = "__any__"

export interface ExternalAgentConfigPinFieldProps {
  /** The preset the agent is bound to. Nothing renders without one. */
  presetId: string | null | undefined
  /** The pinned config id, or undefined for "any config of the preset". */
  value: string | undefined
  /** Receives the new pin, or undefined when the user picks "any". */
  onChange: (configId: string | undefined) => void
  /** Display name of the preset; defaults to the preset catalog's name. */
  presetLabel?: string
  /** Hide the label/hint and render the bare select (compact rows). */
  compact?: boolean
  className?: string
  triggerClassName?: string
  "data-testid"?: string
}

export function ExternalAgentConfigPinField({
  presetId,
  value,
  onChange,
  presetLabel,
  compact = false,
  className,
  triggerClassName,
  "data-testid": testId = "external-agent-config-pin",
}: ExternalAgentConfigPinFieldProps) {
  const t = useTranslations("externalAgent.configPin")
  const fieldId = useId()
  // Select the raw record and derive outside the store: a derived array per
  // render is a fresh snapshot every time and loops `useSyncExternalStore`.
  const agentsById = useExternalAgentStore((s) => s.agents)
  const pinned = normalizePinnedConfigId(value)

  const configs = useMemo(
    () => (presetId ? listPinnableExternalAgents(Object.values(agentsById ?? {}), presetId) : []),
    [agentsById, presetId]
  )

  if (!presetId) return null

  const pinnedConfig = pinned ? agentsById?.[pinned] : undefined
  const pinCheck = pinned
    ? checkPinnedExternalAgent(
        pinnedConfig ? toExternalAgentCandidate(pinnedConfig) : undefined,
        presetId
      )
    : ({ ok: true } as const)
  const pinnedListed = pinned ? configs.some((config) => config.id === pinned) : true
  const name = presetLabel ?? getPresetDisplayInfo(presetId)?.name ?? presetId

  return (
    <div className={cn("space-y-1", className)}>
      {compact ? null : (
        <Label className="text-xs" htmlFor={fieldId}>
          {t("label")}
        </Label>
      )}
      <Select
        value={pinned ?? ANY_CONFIG_VALUE}
        onValueChange={(next) => onChange(next === ANY_CONFIG_VALUE ? undefined : next)}
      >
        <SelectTrigger
          id={fieldId}
          className={cn("h-8 text-xs", triggerClassName)}
          aria-label={t("label")}
          data-testid={testId}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY_CONFIG_VALUE}>{t("any", { preset: name })}</SelectItem>
          {configs.map((config) => {
            const label = config.name || config.id
            return (
              <SelectItem
                key={config.id}
                value={config.id}
                // A disabled config cannot run; it stays listed (and selected,
                // when it is the current pin) so the pin is visible and fixable.
                disabled={!config.enabled && config.id !== pinned}
              >
                {config.enabled ? label : t("disabledOption", { name: label })}
              </SelectItem>
            )
          })}
          {pinned && !pinnedListed ? (
            <SelectItem value={pinned}>
              {pinnedConfig
                ? t("otherPresetOption", { name: pinnedConfig.name || pinnedConfig.id })
                : t("missingOption")}
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
      {!pinCheck.ok ? (
        <p className="text-[11px] text-destructive" role="alert" data-testid={`${testId}-problem`}>
          {pinCheck.problem === "missing"
            ? t("problemMissing")
            : pinCheck.problem === "disabled"
              ? t("problemDisabled")
              : t("problemPresetMismatch")}
        </p>
      ) : compact ? null : (
        <p className="text-[11px] text-muted-foreground">
          {configs.length > 0 ? t("hint") : t("noConfigs", { preset: name })}
        </p>
      )}
    </div>
  )
}
