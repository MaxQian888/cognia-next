"use client"

// The packages Pi will actually load, in the order Pi resolves them.
//
// Three things this list refuses to hide:
//
//   1. **Scope.** A project entry can either replace a user entry or layer over
//      it. Those are different outcomes, so "Project" and "Layered" are
//      separate badges rather than one merged row.
//   2. **Inert ≠ absent.** Pi has no `enabled` field; disabled means
//      `autoload: false`, which still applies whatever the filter arrays list.
//      The row says "inert", not "off".
//   3. **Unreviewed ≠ free.** A package Cognia has never reviewed shows as
//      cost-unmeasured, because claiming it is free would be a claim we cannot
//      support — and an unreviewed package is the one most likely to collide.

import { useTranslations } from "next-intl"
import { FilterIcon, LayersIcon, SettingsIcon, Trash2Icon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { matchPiCatalog } from "@/lib/pi-packages/conflicts"
import { piConfigTemplateFor } from "@/lib/pi-packages/config-templates"
import { piPackageIdentity, piPackageVersion } from "@/lib/pi-packages/identity"
import type { ResolvedPiPackage } from "@/lib/pi-packages/resolve"
import {
  asPiPackageEntry,
  isPiPackageAutoloaded,
  piPackageSourceString,
  type PiPackageScope,
} from "@/lib/pi-packages/types"
import { piPackageShortName } from "./pi-context-budget"

/** Which of the four resource-filter arrays this entry narrows. */
function filtersOf(pkg: ResolvedPiPackage["pkg"]): string[] {
  const entry = asPiPackageEntry(pkg)
  return (["extensions", "skills", "prompts", "themes"] as const).filter(
    (key) => entry[key] !== undefined
  )
}

export interface PiInstalledListProps {
  resolved: readonly ResolvedPiPackage[]
  busySpec: string | null
  onToggle: (spec: string, scope: PiPackageScope, enabled: boolean) => void
  onRemove: (spec: string, scope: PiPackageScope) => void
  onConfigure: (spec: string) => void
}

export function PiInstalledList({
  resolved,
  busySpec,
  onToggle,
  onRemove,
  onConfigure,
}: PiInstalledListProps) {
  const t = useTranslations("plugins.agentPackages")

  if (resolved.length === 0) {
    return (
      <Card className="p-4" data-testid="pi-installed-empty">
        <h3 className="text-sm font-semibold">{t("installed.title")}</h3>
        <p className="text-muted-foreground mt-1 text-xs">{t("installed.empty")}</p>
      </Card>
    )
  }

  const known = new Map(
    matchPiCatalog(resolved.map((entry) => entry.pkg)).known.map((entry) => [
      piPackageIdentity(entry.spec),
      entry,
    ])
  )

  return (
    <Card className="p-4" data-testid="pi-installed-list">
      <h3 className="text-sm font-semibold">{t("installed.title")}</h3>
      <ul className="mt-3 divide-y">
        {resolved.map((entry) => {
          const spec = piPackageSourceString(entry.pkg)
          const catalogEntry = known.get(entry.identity)
          const version = piPackageVersion(spec)
          const autoloaded = isPiPackageAutoloaded(entry.pkg)
          const filters = filtersOf(entry.pkg)
          const busy = busySpec === spec

          return (
            <li
              key={`${entry.scope}:${entry.identity}`}
              className="flex items-start gap-3 py-2.5"
              data-testid={`pi-package-${entry.identity}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-sm">{piPackageShortName(spec)}</span>
                  {version && (
                    <span className="text-muted-foreground font-mono text-xs">{version}</span>
                  )}
                  <Badge variant="outline" className="text-[11px]">
                    {t(`scope.${entry.scope}`)}
                  </Badge>
                  {entry.isDelta && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="secondary" className="gap-1 text-[11px]">
                          <LayersIcon className="size-3" />
                          {t("scope.delta")}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">{t("scope.deltaHint")}</TooltipContent>
                    </Tooltip>
                  )}
                  {!autoloaded && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="secondary" className="text-[11px]">
                          {t("installed.disabled")}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        {t("installed.disabledHint")}
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {filters.length > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="outline" className="gap-1 text-[11px]">
                          <FilterIcon className="size-3" />
                          {t("installed.filtered")}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        {t("installed.filteredHint")} ({filters.join(", ")})
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {catalogEntry && catalogEntry.tier === "avoid" && (
                    <Badge variant="destructive" className="text-[11px]">
                      {t("tier.avoid")}
                    </Badge>
                  )}
                </div>

                {catalogEntry ? (
                  <p className="text-muted-foreground mt-1 text-xs">
                    {t(`catalog.${catalogEntry.id}.summary`)}
                  </p>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <p className="text-muted-foreground mt-1 w-fit text-xs underline decoration-dotted">
                        {t("installed.unknown")}
                      </p>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      {t("installed.unknownHint")}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1">
                {piConfigTemplateFor(spec) !== null && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={t("actions.configure")}
                    onClick={() => onConfigure(spec)}
                  >
                    <SettingsIcon className="size-3.5" />
                  </Button>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Switch
                      checked={autoloaded}
                      disabled={busy}
                      aria-label={autoloaded ? t("actions.disable") : t("actions.enable")}
                      onCheckedChange={(next) => onToggle(spec, entry.scope, next)}
                    />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    {autoloaded ? t("actions.disable") : t("actions.enable")}
                  </TooltipContent>
                </Tooltip>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive size-7"
                  disabled={busy}
                  aria-label={t("actions.remove")}
                  onClick={() => onRemove(spec, entry.scope)}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
