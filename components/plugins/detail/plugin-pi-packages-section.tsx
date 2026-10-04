"use client"

// Pi packages section of the Capabilities sub-tab (ADR-0210) — the plugin's
// `manifest.piPackages`, with prepare / install / remove per scope and the
// hosted-session details, through the same list the Agent packages pane uses.
//
// A disabled plugin contributes nothing to the registry, so its packages can
// be neither installed nor loaded; the section names them and says so rather
// than rendering actions that would only fail.

import { useTranslations } from "next-intl"
import { PackageIcon } from "lucide-react"

import { ContributedPiPackageList } from "@/components/plugins/agent-packages/contributed-pi-package-list"
import { useContributedPiPackageEntries } from "@/hooks/plugins/use-contributed-pi-packages"
import { usePiPackages } from "@/hooks/plugins/use-pi-packages"
import type { PluginManifest } from "@/types/plugin"
import { PluginDetailGroup } from "./plugin-detail-group"

export function PluginPiPackagesSection({
  pluginId,
  manifest,
}: {
  pluginId: string
  manifest: PluginManifest
}) {
  const declared = Array.isArray(manifest.piPackages) ? manifest.piPackages : []
  if (declared.length === 0) return null
  return <PluginPiPackagesSectionBody pluginId={pluginId} declared={declared} />
}

function PluginPiPackagesSectionBody({
  pluginId,
  declared,
}: {
  pluginId: string
  declared: NonNullable<PluginManifest["piPackages"]>
}) {
  const t = useTranslations("plugins.piPackages")
  const registered = useContributedPiPackageEntries(pluginId)
  const pi = usePiPackages()

  return (
    <PluginDetailGroup
      title={t("sectionTitle")}
      icon={<PackageIcon className="size-3.5" />}
      testId="plugin-pi-packages-section"
    >
      <p className="text-muted-foreground mb-2 text-xs">{t("sectionDescription")}</p>
      {registered.length === 0 ? (
        <div className="space-y-1" data-testid="plugin-pi-packages-disabled">
          <p className="text-muted-foreground text-xs">{t("pluginDisabled")}</p>
          <ul className="list-disc pl-4 text-xs">
            {declared.map((def) => (
              <li key={def.id}>
                <code className="font-mono">{def.id}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ContributedPiPackageList pluginId={pluginId} pi={pi} />
      )}
    </PluginDetailGroup>
  )
}
