"use client"

import { ChevronDownIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { resolveMessageDisplayOptions } from "@/lib/chat/message-display"
import {
  MESSAGE_MATH_FONT_SCALES,
  type AgentFlowMode,
  type MessageActionVisibility,
  type MessageBodyFont,
  type MessageDisplayLayout,
  type MessageDisplayMetadataOptions,
  type MessageDisplayPreferences,
  type MessageDisplayPreset,
  type MessageMarkdownOptions,
  type MessageMathAlign,
  type MessageMathFontScale,
  type MessageMotion,
  type MessagePartVisibility,
  type MessageRichControls,
} from "@/types/appearance"

export interface MessageDisplayControlsProps {
  value?: MessageDisplayPreferences
  inheritedValue?: MessageDisplayPreferences
  onChange: (value: MessageDisplayPreferences | undefined) => void
  allowInherit?: boolean
  className?: string
}

const PRESETS: MessageDisplayPreset[] = ["focused", "balanced", "inspector"]
const LAYOUTS: MessageDisplayLayout[] = ["hybrid", "bubbles", "cards"]
const ACTIONS: MessageActionVisibility[] = ["hover", "core", "all"]
const AGENT_FLOWS: AgentFlowMode[] = ["simplified", "standard", "detailed"]
const PART_VISIBILITY: MessagePartVisibility[] = ["hidden", "collapsed", "auto", "expanded"]
const RICH_CONTROLS: MessageRichControls[] = ["hidden", "hover", "always"]
const MOTION: MessageMotion[] = ["off", "restrained", "expressive"]
const PLACEMENTS: MessageDisplayMetadataOptions[keyof MessageDisplayMetadataOptions][] = [
  "hidden",
  "header",
  "details",
]
const BODY_FONTS: MessageBodyFont[] = ["sans", "serif"]
const MATH_ALIGNS: MessageMathAlign[] = ["center", "left"]
/** ADR-0127 boolean markdown knobs rendered as switches, in display order. */
const MARKDOWN_TOGGLES = [
  "math",
  "mermaid",
  "diff",
  "codeLineNumbers",
  "codeWrap",
  "mathCopy",
] as const satisfies readonly (keyof MessageMarkdownOptions)[]
const METADATA_FIELDS: Array<keyof MessageDisplayMetadataOptions> = [
  "identity",
  "timestamp",
  "model",
  "provider",
  "duration",
  "usage",
  "cost",
  "finishState",
]

export function MessageDisplayControls({
  value,
  inheritedValue,
  onChange,
  allowInherit = false,
  className,
}: MessageDisplayControlsProps) {
  const t = useTranslations("settings.appearance.messageDisplay")
  const effective = value ?? inheritedValue ?? { preset: "balanced" as const }
  const ownOverrides = value?.overrides
  const resolved = resolveMessageDisplayOptions(effective)

  const updateOverride = <K extends keyof NonNullable<MessageDisplayPreferences["overrides"]>>(
    key: K,
    next: NonNullable<MessageDisplayPreferences["overrides"]>[K]
  ) => {
    onChange({
      preset: effective.preset,
      overrides: { ...(ownOverrides ?? {}), [key]: next },
    })
  }

  const updateMetadata = (
    key: keyof MessageDisplayMetadataOptions,
    placement: MessageDisplayMetadataOptions[keyof MessageDisplayMetadataOptions]
  ) => {
    updateOverride("metadata", { ...(ownOverrides?.metadata ?? {}), [key]: placement })
  }

  const updateMarkdown = <K extends keyof MessageMarkdownOptions>(
    key: K,
    next: MessageMarkdownOptions[K]
  ) => {
    updateOverride("markdown", { ...(ownOverrides?.markdown ?? {}), [key]: next })
  }

  return (
    <div className={cn("space-y-3", className)} data-testid="message-display-controls">
      <div className="space-y-1.5">
        <Label className="text-xs">{t("preset.label")}</Label>
        <Select
          value={value ? value.preset : allowInherit ? "inherit" : effective.preset}
          onValueChange={(next) => {
            if (next === "inherit") {
              onChange(undefined)
              return
            }
            onChange({
              preset: next as MessageDisplayPreset,
              overrides: ownOverrides,
            })
          }}
        >
          <SelectTrigger className="w-full max-w-xs" data-testid="message-display-preset-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {allowInherit && <SelectItem value="inherit">{t("preset.inherit")}</SelectItem>}
            {PRESETS.map((preset) => (
              <SelectItem key={preset} value={preset}>
                {t(`preset.${preset}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">{t(`preset.hint.${effective.preset}`)}</p>
      </div>

      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="group h-8 gap-1 px-2 text-xs">
            <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
            {t("advanced")}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-2">
          <div className="grid gap-3 @md/appearance-pane:grid-cols-2">
            <PreferenceSelect
              label={t("layout.label")}
              value={ownOverrides?.layout}
              fallback={resolved.layout}
              options={LAYOUTS}
              getLabel={(option) => t(`layout.${option}`)}
              onChange={(next) => updateOverride("layout", next as MessageDisplayLayout)}
            />
            <PreferenceSelect
              label={t("actions.label")}
              value={ownOverrides?.actions}
              fallback={resolved.actions}
              options={ACTIONS}
              getLabel={(option) => t(`actions.${option}`)}
              onChange={(next) => updateOverride("actions", next as MessageActionVisibility)}
            />
            <PreferenceSelect
              label={t("agentFlow.label")}
              value={ownOverrides?.agentFlowMode}
              fallback={resolved.agentFlowMode}
              options={AGENT_FLOWS}
              getLabel={(option) => t(`agentFlow.${option}`)}
              onChange={(next) => updateOverride("agentFlowMode", next as AgentFlowMode)}
            />
            {(["reasoning", "tools", "sources"] as const).map((key) => (
              <PreferenceSelect
                key={key}
                label={t(`${key}.label`)}
                value={ownOverrides?.[key]}
                fallback={resolved[key]}
                options={PART_VISIBILITY}
                getLabel={(option) => t(`visibility.${option}`)}
                onChange={(next) => updateOverride(key, next as MessagePartVisibility)}
              />
            ))}
            <PreferenceSelect
              label={t("richControls.label")}
              value={ownOverrides?.richControls}
              fallback={resolved.richControls}
              options={RICH_CONTROLS}
              getLabel={(option) => t(`richControls.${option}`)}
              onChange={(next) => updateOverride("richControls", next as MessageRichControls)}
            />
            <PreferenceSelect
              label={t("motion.label")}
              value={ownOverrides?.motion}
              fallback={resolved.motion}
              options={MOTION}
              getLabel={(option) => t(`motion.${option}`)}
              onChange={(next) => updateOverride("motion", next as MessageMotion)}
            />
          </div>

          {/* ADR-0127: markdown / code / math knobs — both renderer branches read
              the resolved values, the per-block toolbar can still override. */}
          <div className="space-y-2" data-testid="message-display-markdown">
            <Label className="text-xs">{t("markdown.label")}</Label>
            <div className="grid gap-3 @md/appearance-pane:grid-cols-2">
              <PreferenceSelect
                label={t("bodyFont.label")}
                value={ownOverrides?.bodyFont}
                fallback={resolved.bodyFont}
                options={BODY_FONTS}
                getLabel={(option) => t(`bodyFont.${option}`)}
                onChange={(next) => updateOverride("bodyFont", next as MessageBodyFont)}
              />
              <PreferenceSelect
                label={t("markdown.mathFontScale.label")}
                value={
                  ownOverrides?.markdown?.mathFontScale === undefined
                    ? undefined
                    : String(ownOverrides.markdown.mathFontScale)
                }
                fallback={String(resolved.markdown.mathFontScale)}
                options={MESSAGE_MATH_FONT_SCALES.map(String)}
                getLabel={(option) => t(`markdown.mathFontScale.${option.replace(".", "_")}`)}
                onChange={(next) =>
                  updateMarkdown("mathFontScale", Number(next) as MessageMathFontScale)
                }
              />
              <PreferenceSelect
                label={t("markdown.mathAlign.label")}
                value={ownOverrides?.markdown?.mathAlign}
                fallback={resolved.markdown.mathAlign}
                options={MATH_ALIGNS}
                getLabel={(option) => t(`markdown.mathAlign.${option}`)}
                onChange={(next) => updateMarkdown("mathAlign", next as MessageMathAlign)}
              />
            </div>
            <div className="grid gap-2 @md/appearance-pane:grid-cols-2">
              {MARKDOWN_TOGGLES.map((key) => (
                <PreferenceSwitch
                  key={key}
                  id={`message-display-markdown-${key}`}
                  label={t(`markdown.${key}.label`)}
                  description={t(`markdown.${key}.hint`)}
                  checked={ownOverrides?.markdown?.[key] ?? resolved.markdown[key]}
                  onCheckedChange={(next) => updateMarkdown(key, next)}
                />
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">{t("metadata.label")}</Label>
            <div className="grid gap-3 @md/appearance-pane:grid-cols-2">
              {METADATA_FIELDS.map((key) => (
                <PreferenceSelect
                  key={key}
                  label={t(`metadata.${key}`)}
                  value={ownOverrides?.metadata?.[key]}
                  fallback={resolved.metadata[key]}
                  options={PLACEMENTS}
                  getLabel={(option) => t(`placement.${option}`)}
                  onChange={(next) =>
                    updateMetadata(
                      key,
                      next as MessageDisplayMetadataOptions[keyof MessageDisplayMetadataOptions]
                    )
                  }
                />
              ))}
            </div>
          </div>

          {ownOverrides && Object.keys(ownOverrides).length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onChange({ preset: effective.preset })}
            >
              {t("resetOverrides")}
            </Button>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function PreferenceSelect({
  label,
  value,
  fallback,
  options,
  getLabel,
  onChange,
}: {
  label: string
  value: string | undefined
  fallback: string
  options: readonly string[]
  getLabel: (option: string) => string
  onChange: (value: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value ?? fallback} onValueChange={onChange}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {getLabel(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function PreferenceSwitch({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border px-3 py-2">
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id} className="text-xs">
          {label}
        </Label>
        <p className="text-[11px] leading-snug text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}
