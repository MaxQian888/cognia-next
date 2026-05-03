"use client"

// Compact card used in the marketplace browse grid. Mirrors the shape of
// `components/skills/skill-marketplace-card.tsx` but adds plugin-specific
// concerns: signature badge, danger-permission warning, capability count.

import { useTranslations } from "next-intl"
import { DownloadIcon, StarIcon, AlertTriangleIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { PluginSignatureBadge, type SignatureState } from "./plugin-signature-badge"
import type { PluginMarketplaceEntry } from "@/hooks/plugins/use-plugin-marketplace"

interface Props {
  entry: PluginMarketplaceEntry & {
    /** Optional fields the registry may carry — kept loose because the entry
     * shape is shared between Skills and Plugins marketplaces. */
    capabilities?: string[]
    permissions?: string[]
    signatureState?: SignatureState
  }
  installed: boolean
  installing: boolean
  onView: (id: string) => void
  onInstall: (id: string, version?: string) => void
  onUninstall: (id: string) => void
}

export function PluginMarketplaceCard({
  entry,
  installed,
  installing,
  onView,
  onInstall,
  onUninstall,
}: Props) {
  const t = useTranslations("plugins.marketplaceCard")
  const dangerous =
    (entry.permissions ?? []).filter(
      (p) =>
        p === "shell:execute" ||
        p === "process:spawn" ||
        p === "python:execute" ||
        p === "filesystem:write"
    ).length > 0
  const sigState = entry.signatureState ?? (entry.signed ? "verified" : "unverified")

  return (
    <Card className="p-3 space-y-2 flex flex-col">
      <div className="flex items-start justify-between gap-2">
        <button type="button" className="flex-1 min-w-0 text-left" onClick={() => onView(entry.id)}>
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-medium truncate">{entry.name}</span>
            <span className="text-xs text-muted-foreground shrink-0">v{entry.version}</span>
          </div>
          <div className="text-xs text-muted-foreground truncate mt-0.5">{entry.id}</div>
        </button>
        <PluginSignatureBadge state={sigState} compact />
      </div>

      {entry.description && (
        <p className="text-xs text-muted-foreground line-clamp-2">{entry.description}</p>
      )}

      <div className="flex flex-wrap items-center gap-1">
        {(entry.capabilities ?? []).slice(0, 3).map((cap) => (
          <Badge key={cap} variant="outline" className="text-xs">
            {cap}
          </Badge>
        ))}
        {(entry.capabilities ?? []).length > 3 && (
          <Badge variant="outline" className="text-xs">
            +{(entry.capabilities ?? []).length - 3}
          </Badge>
        )}
        {dangerous && (
          <Badge variant="destructive" className="text-xs gap-1">
            <AlertTriangleIcon className="size-3" />
            {t("dangerous")}
          </Badge>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 mt-auto pt-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {typeof entry.rating === "number" && entry.rating > 0 && (
            <span className="flex items-center gap-0.5">
              <StarIcon className="size-3 fill-current" />
              {entry.rating.toFixed(1)}
            </span>
          )}
          {typeof entry.downloads === "number" && entry.downloads > 0 && (
            <span className="flex items-center gap-0.5">
              <DownloadIcon className="size-3" />
              {entry.downloads.toLocaleString()}
            </span>
          )}
          {entry.author && <span className="truncate">{entry.author}</span>}
        </div>
        {installed ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onUninstall(entry.id)}
            disabled={installing}
          >
            {installing ? t("uninstalling") : t("uninstall")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onInstall(entry.id, entry.version)}
            disabled={installing}
          >
            {installing ? t("installing") : t("install")}
          </Button>
        )}
      </div>
    </Card>
  )
}
