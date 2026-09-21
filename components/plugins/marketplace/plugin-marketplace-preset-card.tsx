"use client"

// Card for a catalog `presets` bundle — a named group of plugins from one
// GitHub marketplace source. Members arrive already resolved to catalog
// entries (`MarketplacePreset.members`); installing runs the same per-plugin
// pre-install chain sequentially in the parent, so this card only renders
// the member list, a busy/progress state, and the install CTA.
//
// Installed-state is deliberately NOT claimed here: a catalog entry id is
// not the converted manifest id, so whether a member is already installed
// is only knowable inside the install run (which reports them as skipped).

import { useTranslations } from "next-intl"
import { LayersIcon, AlertTriangleIcon, DownloadIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import type { MarketplacePreset } from "@/lib/plugin/package/github-marketplace"

/** How many member names fit as chips before collapsing into "+n more". */
const MEMBER_CHIP_LIMIT = 6

interface Props {
  preset: MarketplacePreset
  /** True while any install runs — the bundle CTA shares that consent chain. */
  busy: boolean
  /** Progress of THIS preset's own run; undefined when it is not running. */
  progress?: { completed: number; total: number }
  onInstall: (preset: MarketplacePreset) => void
}

export function PluginMarketplacePresetCard({ preset, busy, progress, onInstall }: Props) {
  const t = useTranslations("plugins.marketplace")
  const running = progress !== undefined
  const shown = preset.members.slice(0, MEMBER_CHIP_LIMIT)
  const overflow = preset.members.length - shown.length

  return (
    <Card className="flex flex-col gap-0 py-0" data-testid={`preset-card-${preset.id}`}>
      <CardHeader className="gap-2 px-3 pt-3">
        <CardTitle className="min-w-0">
          <span className="flex min-w-0 items-center gap-1.5">
            <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="font-medium truncate">{preset.name}</span>
            <Badge variant="secondary" className="shrink-0 text-xs">
              {t("presets.badge")}
            </Badge>
          </span>
        </CardTitle>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-2 px-3 py-2">
        {preset.description && (
          <p className="line-clamp-2 text-xs text-muted-foreground">{preset.description}</p>
        )}

        <div className="flex flex-wrap items-center gap-1">
          {shown.map((member) => (
            <Badge key={member.id} variant="outline" className="max-w-full text-xs">
              <span className="truncate">{member.name}</span>
            </Badge>
          ))}
          {overflow > 0 && (
            <Badge variant="outline" className="text-xs">
              {t("presets.moreMembers", { count: overflow })}
            </Badge>
          )}
        </div>

        {preset.missingPlugins.length > 0 && (
          <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-500">
            <AlertTriangleIcon className="size-3 shrink-0" />
            {t("presets.missing", {
              count: preset.missingPlugins.length,
              names: preset.missingPlugins.join(", "),
            })}
          </p>
        )}
      </CardContent>

      <CardFooter className="mt-auto justify-between gap-2 px-3 pb-3">
        <span className="text-xs text-muted-foreground">
          {t("presets.memberCount", { count: preset.members.length })}
        </span>
        <Button
          size="sm"
          onClick={() => onInstall(preset)}
          disabled={busy || preset.members.length === 0}
          data-testid={`preset-install-${preset.id}`}
        >
          {running ? (
            <>
              <Spinner className="size-3.5" />
              {t("presets.installing", {
                current: progress.completed,
                total: progress.total,
              })}
            </>
          ) : (
            <>
              <DownloadIcon className="size-3.5" />
              {t("presets.install")}
            </>
          )}
        </Button>
      </CardFooter>
    </Card>
  )
}
