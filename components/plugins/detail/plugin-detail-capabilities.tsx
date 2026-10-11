"use client"

// Capabilities tab — manifest-declared capability badges + the full
// runtime contributions registry view (via PluginContributedTab) + the
// per-plugin workflow triggers panel (via PluginTriggersTab). Composes
// three existing surfaces rather than re-implementing any of them.
//
// Capabilities print their names (`capabilityLabel`), not their ids, and a
// plugin that declares nothing in its manifest no longer opens on "this
// plugin doesn't contribute any capabilities" directly above the list of
// runtime contributions it does register.

import { useTranslations } from "next-intl"
import { capabilityLabel } from "../plugin-capabilities"
import { Badge } from "@/components/ui/badge"
import { PluginDetailGroup } from "./plugin-detail-group"
import { Skeleton } from "@/components/ui/skeleton"
import { usePluginRow } from "@/hooks/plugins"
import type { PluginManifest } from "@/types/plugin"
import { PluginContributedTab } from "./plugin-contributed-tab"
import { PluginTriggersTab } from "./plugin-triggers-tab"
import { PluginCliToolsSection } from "./plugin-cli-tools-section"
import { PluginPiPackagesSection } from "./plugin-pi-packages-section"

export function PluginDetailCapabilities({ pluginId }: { pluginId: string }) {
  const t = useTranslations("plugins.detail")
  const tCapability = useTranslations("plugins.categorySidebar")
  const tContributed = useTranslations("plugins.detail.contributed")
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
      {showOverview && (
        <div className="space-y-4">
          {hasCapabilities && (
            <PluginDetailGroup
              title={t("capabilitiesTitle")}
              testId="plugin-detail-capability-list"
            >
              <div className="flex flex-wrap gap-1.5">
                {plugin.capabilities.map((cap) => {
                  const { label, known } = capabilityLabel(tCapability as never, cap)
                  return (
                    <Badge
                      key={cap}
                      variant="outline"
                      className={known ? undefined : "font-mono text-[11px]"}
                      title={cap}
                    >
                      {label}
                    </Badge>
                  )
                })}
              </div>
            </PluginDetailGroup>
          )}
          {contributes.length > 0 && (
            <PluginDetailGroup title={t("contributes")}>
              <div className="flex flex-wrap gap-1.5">
                {contributes.map((key) => {
                  // Manifest contribution fields share their names with the
                  // runtime contribution groups below where one exists.
                  const named = tContributed.has(key as never)
                  return (
                    <Badge
                      key={key}
                      variant="outline"
                      className={named ? "text-xs" : "font-mono text-[11px]"}
                      title={key}
                    >
                      {named ? tContributed(key as never) : key}
                    </Badge>
                  )
                })}
              </div>
            </PluginDetailGroup>
          )}
          {activations.length > 0 && (
            <PluginDetailGroup title={t("activation")}>
              <div className="flex flex-wrap gap-1.5">
                {activations.map((ev) => (
                  // Activation events are contract strings (`onCommand:x`),
                  // shown as written.
                  <Badge key={ev} variant="outline" className="font-mono text-[11px]">
                    {ev}
                  </Badge>
                ))}
              </div>
            </PluginDetailGroup>
          )}
        </div>
      )}

      <PluginCliToolsSection manifest={plugin.manifest as unknown as PluginManifest} />

      <PluginPiPackagesSection
        pluginId={pluginId}
        manifest={plugin.manifest as unknown as PluginManifest}
      />

      <PluginDetailGroup title={t("runtimeContributions")}>
        <PluginContributedTab pluginId={pluginId} />
      </PluginDetailGroup>

      {/* Titled by itself ("Subscribed workflows"); a second heading above
          it used to say the same thing twice. */}
      <PluginTriggersTab pluginId={pluginId} />
    </div>
  )
}
