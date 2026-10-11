"use client"

// Discovery surface — surfaces marketplace "featured" entries with a
// thumbnail-style card grid so a fresh-install user can find something
// to try. Mirrors `components/skills/skill-discovery.tsx`.

import { useTranslations } from "next-intl"
import { SparklesIcon } from "lucide-react"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import type { UsePluginMarketplace } from "@/hooks/plugins"
import { InstallButton } from "./_shared/install-button"
import { InstalledMarker } from "./_shared/installed-marker"
import { PluginVersionBadge } from "./_shared/plugin-version-badge"

interface Props {
  /**
   * The marketplace panel's own query state. The strip used to run a second
   * `usePluginMarketplace()`, which sent every registry request twice on
   * Discover and never saw `installingId` move (installs run through the
   * panel's hook), so its spinner could not show.
   */
  market: Pick<UsePluginMarketplace, "state" | "featured" | "installingId">
  /**
   * Install handler. The discovery surface always routes through this so
   * the caller (today: the marketplace panel) can run the pre-install
   * chain (conflict → permission → config) before any Dexie write. The
   * historical fire-and-forget fallback was removed — callers must pass
   * a handler that goes through `usePluginPreInstall`.
   */
  onInstall: (id: string, version?: string) => void
  /**
   * Ids already in the Library. A featured plugin the user has installed
   * shows the Installed marker and Uninstall, exactly like its marketplace
   * card below — the strip used to hard-code `installed={false}` and offer
   * Install for something already there.
   */
  installedIds: ReadonlySet<string>
  /** Routed through the shared uninstall confirmation by the caller. */
  onUninstall: (id: string, name: string) => void
}

export function PluginDiscovery({ market, onInstall, installedIds, onUninstall }: Props) {
  const t = useTranslations("plugins.discovery")

  // The strip is a nudge above the marketplace, and the marketplace below it
  // already reports its own loading and empty states. Echoing both here
  // stacked two spinners, then two "Nothing here yet" cards, one above the
  // other. With nothing to feature, the strip steps aside.
  if (market.state.kind === "loading") return null

  const featured = market.featured.slice(0, 6)
  if (featured.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <SparklesIcon className="size-4" />
        <h3 className="text-sm font-semibold">{t("title")}</h3>
      </div>
      {/* Columns follow the strip's own width (anonymous `@container`), the
          same breakpoints as the marketplace grid below it — viewport
          breakpoints packed three columns into a pane narrowed by the rail
          and the detail pane. */}
      <div className="@container">
        <div className="grid gap-3 @lg:grid-cols-2 @4xl:grid-cols-3">
          {featured.map((entry) => {
            const installed = installedIds.has(entry.id)
            return (
              <Card key={entry.id} className="flex flex-col gap-0 py-0">
                <CardHeader className="gap-0.5 px-3 pt-3">
                  <CardTitle className="truncate text-sm">{entry.name}</CardTitle>
                  <div className="truncate text-xs text-muted-foreground">{entry.id}</div>
                </CardHeader>
                <CardContent className="flex-1 px-3 py-2">
                  {entry.description && (
                    <p className="line-clamp-3 text-xs text-muted-foreground">
                      {entry.description}
                    </p>
                  )}
                </CardContent>
                <CardFooter className="mt-auto justify-between gap-2 px-3 pb-3">
                  <PluginVersionBadge version={entry.version} variant="outline" />
                  <div className="flex shrink-0 items-center gap-1">
                    {installed && <InstalledMarker />}
                    <InstallButton
                      installed={installed}
                      installing={market.installingId === entry.id}
                      onInstall={() => onInstall(entry.id, entry.version)}
                      onUninstall={() => onUninstall(entry.id, entry.name)}
                      installLabel={t("install")}
                      installingLabel={t("installing")}
                      className="pointer-coarse:h-10"
                    />
                  </div>
                </CardFooter>
              </Card>
            )
          })}
        </div>
      </div>
    </div>
  )
}
