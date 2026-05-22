"use client"

// Detail-pane header. Consolidates the plugin's identity (name + version +
// description) with status pill, signature, enable/disable toggle, and the
// primary actions that the row menu otherwise hides (Configure / Review
// permissions / Uninstall). Also surfaces the latest plugin-point
// diagnostic entries inline so failures aren't buried behind the Data tab.

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  SettingsIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { setPluginEnabled } from "@/lib/db/plugins"
import { usePluginDiagnostics } from "@/hooks/plugins"
import { usePluginsStore } from "@/stores/plugins"
import type { PluginRow } from "@/lib/db/plugin-types"
import { PluginSignatureBadge, type SignatureState } from "../plugin-signature-badge"
import { PluginStatusPill } from "../plugin-status-badge"

interface Props {
  plugin: PluginRow
}

export function PluginDetailHeader({ plugin }: Props) {
  const t = useTranslations("plugins.detail")
  const tCard = useTranslations("plugins.card")
  const openConfigure = usePluginsStore((s) => s.openConfigure)
  const openPermissionReview = usePluginsStore((s) => s.openPermissionReview)
  const setDeleteTarget = usePluginsStore((s) => s.setDeleteTarget)
  const diagnostics = usePluginDiagnostics(plugin.id)

  const signatureState: SignatureState = (() => {
    const sig = (plugin.manifest as { signature?: { verified?: boolean; failed?: boolean } })
      ?.signature
    if (sig?.verified) return "verified"
    if (sig?.failed) return "failed"
    return "unverified"
  })()
  const isLoading =
    plugin.status === "loading" || plugin.status === "enabling" || plugin.status === "updating"
  const hasConfigSchema = !!(plugin.manifest as { configSchema?: unknown }).configSchema
  const declaredPermissions = (plugin.manifest as { permissions?: unknown[] }).permissions ?? []
  const hasPermissions = declaredPermissions.length > 0
  const description = (plugin.manifest as { description?: string }).description

  return (
    <header className="shrink-0 border-b px-4 py-3 space-y-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-base font-semibold truncate">{plugin.name}</h2>
            <span className="text-muted-foreground text-sm font-normal shrink-0">
              v{plugin.version}
            </span>
          </div>
          {description ? (
            <p className="text-xs text-muted-foreground line-clamp-2 mt-1">{description}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            <PluginStatusPill status={plugin.status} enabled={plugin.enabled} loading={isLoading} />
            <PluginSignatureBadge state={signatureState} compact />
            <Badge variant="outline" className="text-xs">
              {plugin.source}
            </Badge>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Switch
            checked={plugin.enabled}
            onCheckedChange={(next) => void setPluginEnabled(plugin.id, next)}
            aria-label={plugin.enabled ? tCard("disable") : tCard("enable")}
            data-testid="plugin-detail-enable-toggle"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {hasConfigSchema && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => openConfigure(plugin.id)}
          >
            <SettingsIcon className="size-3.5 mr-1.5" />
            {tCard("configure")}
          </Button>
        )}
        {hasPermissions && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => openPermissionReview(plugin.id)}
          >
            <ShieldCheckIcon className="size-3.5 mr-1.5" />
            {tCard("reviewPermissions")}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs text-destructive ml-auto"
          onClick={() => setDeleteTarget({ pluginId: plugin.id, name: plugin.name })}
        >
          <Trash2Icon className="size-3.5 mr-1.5" />
          {tCard("uninstall")}
        </Button>
      </div>

      {diagnostics.length > 0 && <DiagnosticsPreview entries={diagnostics} t={t} />}
    </header>
  )
}

interface DiagnosticsPreviewProps {
  entries: ReadonlyArray<{
    code: string
    severity: "warning" | "error"
    message: string
    hint?: string
    pointKind?: string
    pointId?: string
  }>
  t: (key: string, vars?: Record<string, string | number>) => string
}

// Inline diagnostics preview — latest 2 entries always visible, rest behind
// an expander. Renders nothing when there are no entries.
function DiagnosticsPreview({ entries, t }: DiagnosticsPreviewProps) {
  const [expanded, setExpanded] = useState(false)
  const latest = [...entries].reverse()
  const head = latest.slice(0, 2)
  const rest = latest.slice(2)
  const errorCount = entries.filter((e) => e.severity === "error").length

  return (
    <div
      className="rounded-md border border-amber-500/30 bg-amber-50/40 dark:bg-amber-950/20 p-2 space-y-1.5"
      data-testid="plugin-detail-diagnostics-preview"
      role="region"
      aria-label={t("diagnostics.ariaLabel")}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <AlertCircleIcon
          className={cn("size-3.5", errorCount > 0 ? "text-destructive" : "text-amber-600")}
        />
        <span>{t("diagnostics.title", { count: entries.length })}</span>
        {rest.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 ml-auto text-xs"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDownIcon className="size-3 mr-0.5" />
            ) : (
              <ChevronRightIcon className="size-3 mr-0.5" />
            )}
            {expanded
              ? t("diagnostics.collapse")
              : t("diagnostics.showMore", { count: rest.length })}
          </Button>
        )}
      </div>
      <ul className="space-y-1 text-xs">
        {head.map((entry, idx) => (
          <DiagnosticRow key={`head-${idx}`} entry={entry} />
        ))}
        {expanded && rest.map((entry, idx) => <DiagnosticRow key={`tail-${idx}`} entry={entry} />)}
      </ul>
    </div>
  )
}

function DiagnosticRow({ entry }: { entry: DiagnosticsPreviewProps["entries"][number] }) {
  return (
    <li className="flex items-start gap-1.5">
      <span
        className={cn(
          "mt-0.5 inline-block size-1.5 rounded-full shrink-0",
          entry.severity === "error" ? "bg-destructive" : "bg-amber-500"
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="font-medium break-words">{entry.message}</div>
        {entry.hint && <div className="text-muted-foreground text-[10px]">{entry.hint}</div>}
        {(entry.pointKind || entry.pointId) && (
          <code className="text-[10px] text-muted-foreground font-mono">
            {[entry.pointKind, entry.pointId].filter(Boolean).join(":")}
          </code>
        )}
      </div>
    </li>
  )
}
