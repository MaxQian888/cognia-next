"use client"

// Discovery surface — surfaces marketplace "featured" entries with a
// thumbnail-style card grid so a fresh-install user can find something
// to try. Mirrors `components/skills/skill-discovery.tsx`.

import { useTranslations } from "next-intl"
import { SparklesIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { usePluginMarketplace } from "@/hooks/plugins"

export function PluginDiscovery() {
  const t = useTranslations("plugins.discovery")
  const market = usePluginMarketplace()

  if (market.state.kind === "loading") {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>
  }

  const featured = market.featured.slice(0, 6)
  if (featured.length === 0) {
    return (
      <Card className="p-6 text-center space-y-2">
        <SparklesIcon className="size-10 mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      </Card>
    )
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
              <Badge variant="outline" className="text-xs">
                v{entry.version}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void market.install(entry.id, entry.version)}
                disabled={market.installingId === entry.id}
              >
                {market.installingId === entry.id ? t("installing") : t("install")}
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}
