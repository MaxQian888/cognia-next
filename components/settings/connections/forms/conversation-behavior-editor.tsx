"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  IM_MODE_CUSTOM,
  IM_MODE_PRESET_IDS,
  imModePresetFor,
  imModePresetPatch,
  imModePresetUnavailableReason,
  type ImModePresetId,
} from "@/lib/connectors/composition/im-mode-presets"
import {
  autonomyFromConnectorMode,
  engagementFromConnectorMode,
  type ImTargetKind,
} from "@/lib/connectors/composition/mode-projection"
import type {
  AgentAuthority,
  AutonomyLevel,
  EngagementMode,
} from "@cognia/agent-config-types/agent-composition"
import type {
  ActiveRunDispatchMode,
  ConnectorMode,
  InboundActivationPolicy,
} from "@/types/connectors/policy"

export interface ConversationBehaviorValue {
  /** Legacy three-value mirror. Still written, no longer the thing routing reads. */
  mode?: ConnectorMode
  autonomy?: AutonomyLevel
  engagement?: EngagementMode
  authority?: AgentAuthority
  inboundActivationPolicy?: InboundActivationPolicy
  activeRunDispatchMode?: ActiveRunDispatchMode
  activationTtlHours?: string
  /**
   * Whether replies may paint interactive surfaces. Tri-state at BOTH scopes,
   * unlike the fields above: `undefined` at the bot scope is not "off" either,
   * it is "whatever the channel supports", which is what the runtime has always
   * forced for an IM conversation with a cached capability matrix.
   */
  a2ui?: boolean
}

export interface ConversationBehaviorEditorProps {
  scope: "adapter" | "conversation"
  value: ConversationBehaviorValue
  onChange: (next: ConversationBehaviorValue) => void
  sources?: Partial<Record<keyof ConversationBehaviorValue, string>>
  /**
   * The execution target this scope resolves to. Only `delegate` depends on
   * it — background work needs a team or workflow to carry it.
   */
  targetKind?: ImTargetKind
}

const AUTONOMY_LEVELS = ["observe", "suggest", "confirm", "act", "autopilot"] as const
const ENGAGEMENT_MODES = ["inline", "background", "human"] as const
const AUTHORITY_LEVELS = ["plan", "default", "acceptEdits", "bypassPermissions"] as const

const INHERIT = "inherit"

export function ConversationBehaviorEditor({
  scope,
  value,
  onChange,
  sources,
  targetKind = "direct",
}: ConversationBehaviorEditorProps) {
  const t = useTranslations("settings.connections.behaviorEditor")
  // Open when an axis is already pinned: a value the operator (or an SLA step)
  // set is not something to hide behind a collapsed panel.
  const [advancedOpen, setAdvancedOpen] = useState(
    () =>
      value.autonomy !== undefined ||
      value.engagement !== undefined ||
      value.authority !== undefined
  )

  const set = <K extends keyof ConversationBehaviorValue>(
    key: K,
    next: ConversationBehaviorValue[K]
  ) => onChange({ ...value, [key]: next })

  const optional = scope === "conversation"
  const source = (key: keyof ConversationBehaviorValue) =>
    sources?.[key] ? (
      <p className="text-[11px] text-muted-foreground" data-testid={`behavior-source-${key}`}>
        {t("effectiveSource", { source: t(`source_${sources[key]}`) })}
      </p>
    ) : null

  // The axes an unset field resolves to, so the preset row shows what the
  // conversation actually behaves like rather than an empty control.
  const mirrorMode = value.mode ?? "auto"
  const effectiveAutonomy = value.autonomy ?? autonomyFromConnectorMode(mirrorMode)
  const effectiveEngagement =
    value.engagement ?? engagementFromConnectorMode(mirrorMode, targetKind)

  // A conversation that has pinned nothing inherits; anything else names the
  // preset its axes add up to, `custom` included.
  const pinnedNothing =
    optional &&
    value.mode === undefined &&
    value.autonomy === undefined &&
    value.engagement === undefined
  const preset = pinnedNothing
    ? INHERIT
    : imModePresetFor({ autonomy: effectiveAutonomy, engagement: effectiveEngagement })

  const applyPreset = (next: string) => {
    if (next === INHERIT) {
      onChange({ ...value, mode: undefined, autonomy: undefined, engagement: undefined })
      return
    }
    if (next === IM_MODE_CUSTOM) {
      // `custom` is a read-out, not a choice — picking it would have to invent
      // axis values, so the advanced panel is opened instead.
      setAdvancedOpen(true)
      return
    }
    onChange({ ...value, ...imModePresetPatch(next as ImModePresetId) })
  }

  return (
    <div className="space-y-4" data-testid="conversation-behavior-editor">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`${scope}-behavior-mode`}>{t("behaviourPreset")}</Label>
          <Select value={preset} onValueChange={applyPreset}>
            <SelectTrigger id={`${scope}-behavior-mode`} data-testid="behavior-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {optional && <SelectItem value={INHERIT}>{t("inherit")}</SelectItem>}
              {IM_MODE_PRESET_IDS.map((id) => {
                const reason = imModePresetUnavailableReason(id, targetKind)
                // Flat text only: Radix reads an item's label out of its
                // children, and a nested element tree leaves it with none.
                return (
                  <SelectItem key={id} value={id} disabled={reason !== null}>
                    {reason
                      ? `${t(`preset_${id}`)} — ${t(`unavailable_${reason}`)}`
                      : t(`preset_${id}`)}
                  </SelectItem>
                )
              })}
              {/* Only offered when the stored axes already are custom, so the
                  list never advertises a choice that cannot be made. */}
              {preset === IM_MODE_CUSTOM && (
                <SelectItem value={IM_MODE_CUSTOM}>{t("preset_custom")}</SelectItem>
              )}
            </SelectContent>
          </Select>
          {/* The chosen preset's own description, under the control rather than
              inside the options — see the flat-text note above. */}
          {preset !== INHERIT && preset !== IM_MODE_CUSTOM && (
            <p className="text-xs text-muted-foreground" data-testid="behavior-preset-help">
              {t(`presetHelp_${preset}`)}
            </p>
          )}
          {source("mode")}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${scope}-behavior-activation`}>{t("groupActivation")}</Label>
          <Select
            value={value.inboundActivationPolicy ?? (optional ? INHERIT : "mention_activates")}
            onValueChange={(next) =>
              set(
                "inboundActivationPolicy",
                next === INHERIT ? undefined : (next as InboundActivationPolicy)
              )
            }
          >
            <SelectTrigger id={`${scope}-behavior-activation`} data-testid="behavior-activation">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {optional && <SelectItem value={INHERIT}>{t("inherit")}</SelectItem>}
              {(["mention_activates", "mention_each", "always", "direct_only"] as const).map(
                (policy) => (
                  <SelectItem key={policy} value={policy}>
                    {t(`activation_${policy}`)}
                  </SelectItem>
                )
              )}
            </SelectContent>
          </Select>
          {source("inboundActivationPolicy")}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${scope}-behavior-dispatch`}>{t("activeRun")}</Label>
          <Select
            value={value.activeRunDispatchMode ?? (optional ? INHERIT : "queue")}
            onValueChange={(next) =>
              set(
                "activeRunDispatchMode",
                next === INHERIT ? undefined : (next as ActiveRunDispatchMode)
              )
            }
          >
            <SelectTrigger id={`${scope}-behavior-dispatch`} data-testid="behavior-dispatch">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {optional && <SelectItem value={INHERIT}>{t("inherit")}</SelectItem>}
              <SelectItem value="queue">{t("dispatchQueue")}</SelectItem>
              <SelectItem value="steer">{t("dispatchSteer")}</SelectItem>
            </SelectContent>
          </Select>
          {source("activeRunDispatchMode")}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${scope}-behavior-a2ui`}>{t("a2ui")}</Label>
          <Select
            value={value.a2ui === undefined ? INHERIT : value.a2ui ? "on" : "off"}
            onValueChange={(next) => set("a2ui", next === INHERIT ? undefined : next === "on")}
          >
            <SelectTrigger id={`${scope}-behavior-a2ui`} data-testid="behavior-a2ui">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* Offered at the bot scope too — see the field's docblock. */}
              <SelectItem value={INHERIT}>
                {scope === "adapter" ? t("a2uiChannelDefault") : t("inherit")}
              </SelectItem>
              <SelectItem value="on">{t("a2uiOn")}</SelectItem>
              <SelectItem value="off">{t("a2uiOff")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t("a2uiHelp")}</p>
          {source("a2ui")}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`${scope}-behavior-ttl`}>{t("activationTtl")}</Label>
          <Input
            id={`${scope}-behavior-ttl`}
            type="number"
            min="1"
            step="1"
            value={value.activationTtlHours ?? ""}
            placeholder={t("activationTtlPlaceholder")}
            onChange={(event) => set("activationTtlHours", event.target.value)}
            data-testid="behavior-ttl"
          />
          {source("activationTtlHours")}
        </div>
      </div>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5 px-0 text-xs text-muted-foreground hover:bg-transparent"
            data-testid="behavior-advanced-toggle"
          >
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", advancedOpen && "rotate-180")}
            />
            {t("advancedAxes")}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-3">
          <AxisSelect
            id={`${scope}-behavior-autonomy`}
            testId="behavior-autonomy"
            label={t("autonomyLabel")}
            help={t("autonomyHelp")}
            options={AUTONOMY_LEVELS}
            optionLabel={(v) => t(`autonomy_${v}`)}
            value={value.autonomy}
            placeholder={t(`autonomy_${effectiveAutonomy}`)}
            onChange={(next) => set("autonomy", next)}
            source={source("autonomy")}
          />
          <AxisSelect
            id={`${scope}-behavior-engagement`}
            testId="behavior-engagement"
            label={t("engagementLabel")}
            help={t("engagementHelp")}
            options={ENGAGEMENT_MODES}
            optionLabel={(v) => t(`engagement_${v}`)}
            value={value.engagement}
            placeholder={t(`engagement_${effectiveEngagement}`)}
            onChange={(next) => set("engagement", next)}
            source={source("engagement")}
          />
          <AxisSelect
            id={`${scope}-behavior-authority`}
            testId="behavior-authority"
            label={t("authorityLabel")}
            help={t("authorityHelp")}
            options={AUTHORITY_LEVELS}
            optionLabel={(v) => t(`authority_${v}`)}
            value={value.authority}
            placeholder={t("inherit")}
            onChange={(next) => set("authority", next)}
            source={source("authority")}
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

/**
 * One axis row. Every axis is optional at both scopes — an unset axis follows
 * the preset (or the layer below), and the placeholder shows what that
 * currently resolves to so "unset" never reads as "off".
 */
function AxisSelect<T extends string>({
  id,
  testId,
  label,
  help,
  options,
  optionLabel,
  value,
  placeholder,
  onChange,
  source,
}: {
  id: string
  testId: string
  label: string
  help: string
  options: readonly T[]
  optionLabel: (value: T) => string
  value: T | undefined
  placeholder: string
  onChange: (next: T | undefined) => void
  source: React.ReactNode
}) {
  const t = useTranslations("settings.connections.behaviorEditor")
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <p className="text-xs text-muted-foreground">{help}</p>
      <Select
        value={value ?? INHERIT}
        onValueChange={(next) => onChange(next === INHERIT ? undefined : (next as T))}
      >
        <SelectTrigger id={id} data-testid={testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT}>{t("followsPreset", { value: placeholder })}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {optionLabel(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {source}
    </div>
  )
}
