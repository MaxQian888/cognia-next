"use client"

/**
 * Read-only detail for a plugin-contributed subagent. The source of truth is
 * the plugin manifest, so nothing here is editable — but the panel does state
 * plainly what the resolvers will do with the entry, which the old flat list
 * at the bottom of the templates tab never did.
 */

import { useTranslations } from "next-intl"
import { InfoIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { SettingsAlert, SettingsEmptyState } from "@/components/settings/common/settings-section"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"

export interface PluginPanelProps {
  runtimeId: string
  entry: PluginSubagentDef | undefined
  pluginId?: string
}

export function PluginPanel({ runtimeId, entry, pluginId }: PluginPanelProps) {
  const t = useTranslations("settings.subagents.pluginSection")

  if (!entry) {
    return <SettingsEmptyState title={t("missingTitle")} description={t("missingBody")} />
  }

  return (
    <div className="space-y-4">
      <SettingsAlert icon={<InfoIcon className="size-4" />} title={t("readOnlyTitle")}>
        {t("readOnlyBody")}
      </SettingsAlert>

      <div className="flex flex-wrap items-center gap-1.5">
        {pluginId ? (
          <Badge variant="secondary" className="text-[10px]">
            {pluginId}
          </Badge>
        ) : null}
        {entry.model ? (
          <Badge variant="outline" className="font-mono text-[10px]">
            {entry.model}
          </Badge>
        ) : null}
        {entry.disabled ? (
          <Badge variant="outline" className="text-[10px]" data-testid="plugin-disabled">
            {t("disabledBadge")}
          </Badge>
        ) : null}
        {entry.hidden ? (
          <Badge variant="outline" className="text-[10px]" data-testid="plugin-hidden">
            {t("hiddenBadge")}
          </Badge>
        ) : null}
      </div>

      <Row label={t("runtimeId")} value={runtimeId} mono />
      <Row label={t("descriptionLabel")} value={entry.description} />
      {entry.tools?.length ? (
        <Row label={t("toolsLabel")} value={entry.tools.join(", ")} mono />
      ) : null}
      {entry.disallowedTools?.length ? (
        <Row label={t("disallowedToolsLabel")} value={entry.disallowedTools.join(", ")} mono />
      ) : null}
      {entry.mcpServerIds?.length ? (
        <Row label={t("mcpLabel")} value={entry.mcpServerIds.join(", ")} mono />
      ) : null}
      {entry.externalPresetId ? (
        <Row label={t("externalPresetLabel")} value={entry.externalPresetId} mono />
      ) : null}
      {entry.prompt ? (
        <div className="space-y-1">
          <Label className="text-xs">{t("promptLabel")}</Label>
          <pre className="max-h-60 overflow-auto rounded border bg-muted/40 p-2 font-mono text-[11px] whitespace-pre-wrap">
            {entry.prompt}
          </pre>
        </div>
      ) : null}
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  if (!value) return null
  return (
    <div className="space-y-0.5">
      <Label className="text-xs">{label}</Label>
      <p className={`text-xs text-muted-foreground ${mono ? "font-mono break-all" : ""}`}>
        {value}
      </p>
    </div>
  )
}
