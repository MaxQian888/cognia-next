"use client"

// Capabilities sub-tab — manifest-declared capability badges + the full
// runtime contributions registry view (via PluginContributedTab) + the
// per-plugin workflow triggers panel (via PluginTriggersTab). Composes
// three existing surfaces rather than re-implementing any of them.

import { useTranslations } from "next-intl"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { usePluginRow } from "@/hooks/plugins"
import type { PluginManifest } from "@/types/plugin"
import { PluginContributedTab } from "./plugin-contributed-tab"
import { PluginTriggersTab } from "./plugin-triggers-tab"
import { PluginCliToolsSection } from "./plugin-cli-tools-section"

export function PluginDetailCapabilities({ pluginId }: { pluginId: string }) {
  const t = useTranslations("plugins.detail")
  const rowState = usePluginRow(pluginId)

  if (rowState.state === "loading") {
    return (
      <div className="space-y-3" data-testid="plugin-detail-capabilities-loading" aria-busy="true">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }
  if (rowState.state === "not-found") {
    return <p className="text-sm text-muted-foreground">{t("notFound")}</p>
  }
  const plugin = rowState.row

  const manifest = plugin.manifest as {
    contributes?: Record<string, unknown>
    activationEvents?: string[]
  }
  const hasCapabilities = plugin.capabilities.length > 0
  const contributes = manifest.contributes ? Object.keys(manifest.contributes) : []
  const activations = manifest.activationEvents ?? []
  const showOverview = hasCapabilities || contributes.length > 0 || activations.length > 0

  return (
    <div className="space-y-4">
      {!showOverview && <p className="text-sm text-muted-foreground">{t("noCapabilities")}</p>}
      {showOverview && (
        <div className="space-y-2">
          {hasCapabilities && (
            <Card className="p-3 space-y-1">
              <div className="text-xs font-semibold">{t("capabilitiesTitle")}</div>
              <div className="flex flex-wrap gap-1.5">
                {plugin.capabilities.map((cap) => (
                  <Badge key={cap} variant="outline">
                    {cap}
                  </Badge>
                ))}
              </div>
            </Card>
          )}
          {contributes.length > 0 && (
            <Card className="p-3 space-y-1">
              <div className="text-xs font-semibold">{t("contributes")}</div>
              <div className="flex flex-wrap gap-1.5">
                {contributes.map((key) => (
                  <Badge key={key} variant="outline" className="text-xs">
                    {key}
                  </Badge>
                ))}
              </div>
            </Card>
          )}
          {activations.length > 0 && (
            <Card className="p-3 space-y-1">
              <div className="text-xs font-semibold">{t("activation")}</div>
              <div className="flex flex-wrap gap-1.5">
                {activations.map((ev) => (
                  <Badge key={ev} variant="outline" className="text-xs">
                    {ev}
                  </Badge>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      <PluginCliToolsSection manifest={plugin.manifest as unknown as PluginManifest} />

      <section className="space-y-2">
        <h3 className="text-xs font-semibold">{t("runtimeContributions")}</h3>
        <PluginContributedTab pluginId={pluginId} />
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold">{t("workflowTriggers")}</h3>
        <PluginTriggersTab pluginId={pluginId} />
      </section>
    </div>
  )
}
