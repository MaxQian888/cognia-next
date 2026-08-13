"use client"

import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type {
  ActiveRunDispatchMode,
  ConnectorMode,
  InboundActivationPolicy,
} from "@/types/connectors/policy"

export interface ConversationBehaviorValue {
  mode?: ConnectorMode
  inboundActivationPolicy?: InboundActivationPolicy
  activeRunDispatchMode?: ActiveRunDispatchMode
  activationTtlHours?: string
}

export interface ConversationBehaviorEditorProps {
  scope: "adapter" | "conversation"
  value: ConversationBehaviorValue
  onChange: (next: ConversationBehaviorValue) => void
  sources?: Partial<Record<keyof ConversationBehaviorValue, string>>
}

export function ConversationBehaviorEditor({
  scope,
  value,
  onChange,
  sources,
}: ConversationBehaviorEditorProps) {
  const t = useTranslations("settings.connections.behaviorEditor")
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

  return (
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2"
      data-testid="conversation-behavior-editor"
    >
      <div className="space-y-1.5">
        <Label htmlFor={`${scope}-behavior-mode`}>{t("responseMode")}</Label>
        <Select
          value={value.mode ?? (optional ? "inherit" : "auto")}
          onValueChange={(next) =>
            set("mode", next === "inherit" ? undefined : (next as ConnectorMode))
          }
        >
          <SelectTrigger id={`${scope}-behavior-mode`} data-testid="behavior-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {optional && <SelectItem value="inherit">{t("inherit")}</SelectItem>}
            <SelectItem value="auto">{t("modeAuto")}</SelectItem>
            <SelectItem value="manual">{t("modeManual")}</SelectItem>
            <SelectItem value="draft">{t("modeDraft")}</SelectItem>
          </SelectContent>
        </Select>
        {source("mode")}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${scope}-behavior-activation`}>{t("groupActivation")}</Label>
        <Select
          value={value.inboundActivationPolicy ?? (optional ? "inherit" : "mention_activates")}
          onValueChange={(next) =>
            set(
              "inboundActivationPolicy",
              next === "inherit" ? undefined : (next as InboundActivationPolicy)
            )
          }
        >
          <SelectTrigger id={`${scope}-behavior-activation`} data-testid="behavior-activation">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {optional && <SelectItem value="inherit">{t("inherit")}</SelectItem>}
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
          value={value.activeRunDispatchMode ?? (optional ? "inherit" : "queue")}
          onValueChange={(next) =>
            set(
              "activeRunDispatchMode",
              next === "inherit" ? undefined : (next as ActiveRunDispatchMode)
            )
          }
        >
          <SelectTrigger id={`${scope}-behavior-dispatch`} data-testid="behavior-dispatch">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {optional && <SelectItem value="inherit">{t("inherit")}</SelectItem>}
            <SelectItem value="queue">{t("dispatchQueue")}</SelectItem>
            <SelectItem value="steer">{t("dispatchSteer")}</SelectItem>
          </SelectContent>
        </Select>
        {source("activeRunDispatchMode")}
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
  )
}
