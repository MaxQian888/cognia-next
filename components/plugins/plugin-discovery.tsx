"use client"

// Discovery surface — surfaces marketplace "featured" entries with a
// thumbnail-style card grid so a fresh-install user can find something
// to try. Mirrors `components/skills/skill-discovery.tsx`.

import { useTranslations } from "next-intl"
import { SparklesIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { usePluginMarketplace } from "@/hooks/plugins"
import { InstallButton } from "./_shared/install-button"
import { PluginEmptyState } from "./_shared/plugin-empty-state"
import { PluginVersionBadge } from "./_shared/plugin-version-badge"

interface Props {
  /**
   * Install handler. The discovery surface always routes through this so
   * the caller (today: the marketplace panel) can run the pre-install
   * chain (conflict → permission → config) before any Dexie write. The
   * historical fire-and-forget fallback was removed — callers must pass
   * a handler that goes through `usePluginPreInstall`.
   */
  onInstall: (id: string, version?: string) => void
}

export function PluginDiscovery({ onInstall }: Props) {
  const t = useTranslations("plugins.discovery")
  const market = usePluginMarketplace()

  if (market.state.kind === "loading") {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>
  }

  const featured = market.featured.slice(0, 6)
  if (featured.length === 0) {
    return <PluginEmptyState icon={<SparklesIcon className="size-5" />} hint={t("empty")} />
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <SparklesIcon className="size-4" />
        <h3 className="text-sm font-semibold">{t("title")}</h3>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {featured.map((entry) => (
          <Card key={entry.id} className="p-3 space-y-2 flex flex-col">
            <div className="space-y-0.5">
              <div className="text-sm font-medium truncate">{entry.name}</div>
              <div className="text-xs text-muted-foreground truncate">{entry.id}</div>
            </div>
            {entry.description && (
              <p className="text-xs text-muted-foreground line-clamp-3">{entry.description}</p>
            )}
            <div className="flex items-center justify-between gap-2 mt-auto pt-2">
              <PluginVersionBadge version={entry.version} variant="outline" />
              <InstallButton
                installed={false}
                installing={market.installingId === entry.id}
                onInstall={() => onInstall(entry.id, entry.version)}
                installLabel={t("install")}
                installingLabel={t("installing")}
              />
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}
