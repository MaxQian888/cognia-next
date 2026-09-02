"use client"

/**
 * Mode selection for a session (ADR-0117).
 *
 * The ordinary view is a preset list and nothing else — the five axes exist so
 * that permission, tool presentation and orchestration can be reasoned about
 * separately, not so that every user has to. The advanced panel is where those
 * axes become individually selectable.
 *
 * The resolved summary underneath is not decoration. A composition can be
 * quietly narrowed — by the preset's own cap, by a parent agent's ceiling, or
 * by a host that cannot offer code tools — and a picker that showed the request
 * rather than the result would be lying about what the next turn will do. It
 * is rendered as one labelled row per axis so the three answers are readable
 * even while the advanced panel is collapsed.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { ChevronRight, Network, ShieldCheck, Wrench } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  AGENT_AUTHORITIES,
  AGENT_ORCHESTRATION_POLICIES,
  TOOL_PRESENTATION_MODES,
} from "@cognia/agent-config-types/agent-composition"
import type {
  AgentCompositionSelectionV1,
  AgentCompositionWarning,
  AgentPresetDefinitionV1,
  ToolPresentationMode,
  AgentOrchestrationPolicy,
} from "@cognia/agent-config-types/agent-composition"
import { visiblePresets } from "@/lib/agent/composition/preset-catalog"
import { resolveComposition } from "@/lib/agent/composition/resolve-composition"
import { chatOrchestrationUnavailableReason } from "@/lib/agent/composition/chat-orchestrations"
import { presetDisplayName, type PresetNameTranslator } from "@/lib/agent/composition/preset-label"
import { useHostProfile } from "@/hooks/use-host-profile"

export interface CompositionPickerProps {
  presets: readonly AgentPresetDefinitionV1[]
  selection: AgentCompositionSelectionV1
  onChange: (selection: AgentCompositionSelectionV1) => void
  developerMode?: boolean
  includeExperimental?: boolean
  /**
   * Render the preset selector. When the host places the preset control
   * elsewhere (the composer's split chip), the picker becomes the advanced
   * panel itself: the axes are always shown and the collapse toggle is gone.
   */
  presetControl?: boolean
  /** Advanced axes are hidden until the user opts in (ignored without a preset control). */
  advancedOpen?: boolean
  onAdvancedOpenChange?: (open: boolean) => void
  /** Parent ceiling when composing a subagent. */
  ceiling?: AgentCompositionSelectionV1["authority"]
  /** Absent means the host supports everything. */
  supportedToolPresentations?: readonly ToolPresentationMode[]
  supportedOrchestrations?: readonly AgentOrchestrationPolicy[]
  disabled?: boolean
  className?: string
}

/** Placeholder used for "no explicit choice — follow the preset". */
const INHERIT = "__inherit__"

/** The three axes a user can pin, in the order the summary lists them. */
const AXES = ["authority", "toolPresentation", "orchestration"] as const
type Axis = (typeof AXES)[number]

const AXIS_ICON: Record<Axis, typeof ShieldCheck> = {
  authority: ShieldCheck,
  toolPresentation: Wrench,
  orchestration: Network,
}

/**
 * Preset description, preferring the translated catalog entry (mirrors
 * `presetDisplayName`; a custom or plugin preset only has its own text).
 */
function presetDescription(preset: AgentPresetDefinitionV1, t: PresetNameTranslator): string {
  const key = `${preset.id}.description`
  if (t.has?.(key)) {
    const translated = t(key)
    if (translated) return translated
  }
  return preset.description
}

export function CompositionPicker({
  presets,
  selection,
  onChange,
  developerMode = false,
  includeExperimental = false,
  presetControl = true,
  advancedOpen = false,
  onAdvancedOpenChange,
  ceiling,
  supportedToolPresentations,
  supportedOrchestrations,
  disabled = false,
  className,
}: CompositionPickerProps) {
  const t = useTranslations("agentComposition")
  const tModes = useTranslations("agentMode.modes")
  // The independent reviewer runs only on a shell that owns the sidecar. On a
  // companion shell the option stays listed and disabled with that reason,
  // never hidden (three-axis dormancy, see `lib/agent/composition/verified-fresh-agent.ts`).
  const hostProfile = useHostProfile()

  const offered = useMemo(
    () => visiblePresets(presets, { developerMode, includeExperimental }),
    [presets, developerMode, includeExperimental]
  )

  // Resolved with placeholder digests: the summary is about the AXES, and the
  // real digests are not known until the turn assembles its prompt and tools.
  const resolved = useMemo(
    () =>
      resolveComposition({
        selection,
        presets,
        ceiling,
        supportedToolPresentations,
        supportedOrchestrations,
        promptDigest: `sha256:${"0".repeat(64)}`,
        toolDigest: `sha256:${"0".repeat(64)}`,
      }),
    [selection, presets, ceiling, supportedToolPresentations, supportedOrchestrations]
  )

  const activePreset = presets.find((preset) => preset.id === selection.presetId)
  const activePresetName = activePreset ? presetDisplayName(activePreset, tModes) : undefined
  const inheritLabel = activePresetName
    ? t("inherit", { preset: activePresetName })
    : t("inheritGeneric")
  const overrideCount = AXES.filter((axis) => selection[axis] !== undefined).length
  const axesVisible = !presetControl || advancedOpen

  function patch(next: Partial<AgentCompositionSelectionV1>): void {
    onChange({ ...selection, ...next })
  }

  function axisValue(value: string | undefined): string {
    return value ?? INHERIT
  }

  function axisChange<K extends keyof AgentCompositionSelectionV1>(key: K) {
    return (value: string) => {
      patch({
        [key]: value === INHERIT ? undefined : value,
      } as Partial<AgentCompositionSelectionV1>)
    }
  }

  return (
    <div className={cn("space-y-3", className)}>
      {presetControl ? (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="composition-preset">
            {t("presetLabel")}
          </label>
          <Select
            value={selection.presetId}
            onValueChange={(presetId) => patch({ presetId })}
            disabled={disabled}
          >
            <SelectTrigger id="composition-preset" className="w-full">
              <SelectValue placeholder={t("title")} />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {offered.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  <span className="flex items-center gap-2">
                    <span className="truncate">{presetDisplayName(preset, tModes)}</span>
                    {preset.experimental ? (
                      <Badge variant="outline" className="text-[10px]">
                        {t("badges.experimental")}
                      </Badge>
                    ) : null}
                    {preset.visibility === "developer-only" ? (
                      <Badge variant="outline" className="text-[10px]">
                        {t("badges.developerOnly")}
                      </Badge>
                    ) : null}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {activePreset ? (
            <p
              className="line-clamp-2 text-[11px] leading-snug text-muted-foreground"
              data-testid="composition-preset-description"
            >
              {presetDescription(activePreset, tModes)}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className={cn(presetControl && "overflow-hidden rounded-md border")}>
        {presetControl ? (
          <button
            type="button"
            className={cn(
              "flex w-full items-center gap-1.5 px-2.5 py-2 text-left text-xs font-medium",
              "transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:pointer-events-none disabled:opacity-50"
            )}
            aria-expanded={advancedOpen}
            aria-controls="composition-advanced"
            onClick={() => onAdvancedOpenChange?.(!advancedOpen)}
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                advancedOpen && "rotate-90"
              )}
            />
            <span className="flex-1">{t("advanced")}</span>
            {overrideCount > 0 ? (
              <Badge
                variant="secondary"
                className="h-4 px-1.5 text-[10px] font-normal"
                data-testid="composition-override-count"
              >
                {t("overrides", { count: overrideCount })}
              </Badge>
            ) : null}
          </button>
        ) : null}

        {axesVisible ? (
          <div
            id="composition-advanced"
            className={cn(
              "space-y-2.5",
              presetControl ? "border-t bg-muted/20 px-2.5 py-2.5" : "pb-0.5"
            )}
          >
            <p className="text-[11px] leading-snug text-muted-foreground">{t("advancedHint")}</p>

            <AxisSelect
              id="composition-authority"
              axis="authority"
              label={t("axis.authority.label")}
              value={axisValue(selection.authority)}
              onValueChange={axisChange("authority")}
              disabled={disabled}
              inheritLabel={inheritLabel}
              options={AGENT_AUTHORITIES.map((value) => ({
                value,
                label: t(`axis.authority.options.${value}`),
              }))}
            />

            <AxisSelect
              id="composition-tools"
              axis="toolPresentation"
              label={t("axis.toolPresentation.label")}
              value={axisValue(selection.toolPresentation)}
              onValueChange={axisChange("toolPresentation")}
              disabled={disabled}
              inheritLabel={inheritLabel}
              options={TOOL_PRESENTATION_MODES.map((value) => ({
                value,
                label: t(`axis.toolPresentation.options.${value}`),
              }))}
            />

            <AxisSelect
              id="composition-orchestration"
              axis="orchestration"
              label={t("axis.orchestration.label")}
              value={axisValue(selection.orchestration)}
              onValueChange={axisChange("orchestration")}
              disabled={disabled}
              inheritLabel={inheritLabel}
              options={AGENT_ORCHESTRATION_POLICIES.map((value) => {
                const reason = chatOrchestrationUnavailableReason(value, { hostProfile })
                return {
                  value,
                  label: t(`axis.orchestration.options.${value}`),
                  ...(reason
                    ? { unavailableHint: t(`axis.orchestration.unavailable.${reason}`) }
                    : {}),
                }
              })}
            />
          </div>
        ) : null}
      </div>

      <div className="space-y-2 rounded-md border border-dashed p-2.5 text-xs">
        <p className="font-medium">{t("summary.title")}</p>
        <dl className="space-y-1" data-testid="composition-summary">
          {AXES.map((axis) => {
            const Icon = AXIS_ICON[axis]
            const pinned = selection[axis] !== undefined
            return (
              <div key={axis} className="flex items-center gap-2" data-axis={axis}>
                <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <dt className="w-[5.5rem] shrink-0 text-muted-foreground">
                  {t(`axis.${axis}.label`)}
                </dt>
                <dd className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-medium">
                  <span className="truncate">{t(`axis.${axis}.options.${resolved[axis]}`)}</span>
                  {pinned ? (
                    <span
                      aria-hidden
                      title={t("pinned")}
                      className="size-1.5 shrink-0 rounded-full bg-primary/70"
                      data-testid={`composition-pinned-${axis}`}
                    />
                  ) : null}
                </dd>
              </div>
            )
          })}
        </dl>
        {resolved.warnings.length > 0 ? (
          <div className="space-y-1 border-t border-dashed pt-2">
            {resolved.warnings.map((warning) => (
              <CompositionWarningLine
                key={`${warning.reason}:${warning.requested ?? ""}`}
                warning={warning}
                presetName={activePresetName ?? resolved.presetId}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

interface AxisSelectProps {
  id: string
  axis: Axis
  label: string
  value: string
  onValueChange: (value: string) => void
  options: Array<{ value: string; label: string; unavailableHint?: string }>
  inheritLabel: string
  disabled?: boolean
}

function AxisSelect({
  id,
  axis,
  label,
  value,
  onValueChange,
  options,
  inheritLabel,
  disabled,
}: AxisSelectProps) {
  const Icon = AXIS_ICON[axis]
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-2">
      <label
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
        htmlFor={id}
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </label>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger id={id} size="sm" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="end" className="max-h-72">
          <SelectItem value={INHERIT}>{inheritLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.unavailableHint !== undefined}
            >
              <span className="flex flex-col items-start gap-0.5">
                <span>{option.label}</span>
                {/* Named rather than hidden: two of these are real features
                    reachable another way, and one runs only on the shell
                    that owns the agent. A silently-missing entry teaches
                    neither. */}
                {option.unavailableHint ? (
                  <span className="text-[0.6875rem] text-muted-foreground">
                    {option.unavailableHint}
                  </span>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function CompositionWarningLine({
  warning,
  presetName,
}: {
  warning: AgentCompositionWarning
  presetName: string
}) {
  const t = useTranslations("agentComposition.warnings")
  return (
    <p className="text-amber-600 dark:text-amber-500" role="status">
      {t(warning.reason, {
        applied: warning.applied,
        requested: warning.requested ?? "",
        preset: presetName,
      })}
    </p>
  )
}

export default CompositionPicker
