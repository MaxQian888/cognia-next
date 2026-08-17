"use client"

// The reviewed catalog, plus the three coherent stacks.
//
// Rendered in catalog order rather than sorted: the ordering *is* the
// recommendation (core, then optional, then the explicit do-not-install rows),
// and re-sorting by name or popularity would throw that away.
//
// Presets install what is missing and never remove anything. Removal is always
// an explicit, per-package decision — a preset that silently uninstalled
// packages would be a destructive action behind a one-click button.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, ExternalLinkIcon, PlusIcon, SparklesIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  PI_PACKAGE_CATALOG,
  PI_STACK_PRESETS,
  piCatalogEntry,
  type PiCatalogEntry,
  type PiStackPresetId,
} from "@/lib/pi-packages/catalog"
import { piPackageIdentity } from "@/lib/pi-packages/identity"
import type { ResolvedPiPackage } from "@/lib/pi-packages/resolve"
import { piPackageSourceString } from "@/lib/pi-packages/types"
import { cn } from "@/lib/utils"
import { piPackageShortName } from "./pi-context-budget"

const PRESET_IDS: readonly PiStackPresetId[] = ["starter", "balanced", "power"]

/** Catalog entries a preset would add on top of what is already installed. */
export function presetGap(
  preset: PiStackPresetId,
  installedIdentities: ReadonlySet<string>
): PiCatalogEntry[] {
  return PI_STACK_PRESETS[preset]
    .map((id) => piCatalogEntry(id))
    .filter((entry): entry is PiCatalogEntry => entry !== undefined)
    .filter((entry) => !installedIdentities.has(piPackageIdentity(entry.spec)))
}

export interface PiCatalogListProps {
  resolved: readonly ResolvedPiPackage[]
  busySpec: string | null
  applyingPreset: PiStackPresetId | null
  onInstall: (spec: string) => void
  onApplyPreset: (preset: PiStackPresetId, missing: PiCatalogEntry[]) => void
}

export function PiCatalogList({
  resolved,
  busySpec,
  applyingPreset,
  onInstall,
  onApplyPreset,
}: PiCatalogListProps) {
  const t = useTranslations("plugins.agentPackages")
  const [query, setQuery] = useState("")
  const [customSpec, setCustomSpec] = useState("")

  const installedIdentities = useMemo(
    () => new Set(resolved.map((entry) => piPackageIdentity(piPackageSourceString(entry.pkg)))),
    [resolved]
  )

  const needle = query.trim().toLowerCase()
  const visible = needle
    ? PI_PACKAGE_CATALOG.filter(
        (entry) =>
          entry.id.toLowerCase().includes(needle) || entry.spec.toLowerCase().includes(needle)
      )
    : PI_PACKAGE_CATALOG

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4" data-testid="pi-stack-presets">
        <div className="flex items-start gap-2">
          <SparklesIcon className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{t("presets.title")}</h3>
            <p className="text-muted-foreground text-xs">{t("presets.description")}</p>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {PRESET_IDS.map((preset) => {
            const missing = presetGap(preset, installedIdentities)
            const complete = missing.length === 0
            return (
              <div key={preset} className="flex flex-col gap-1.5 rounded-md border p-3">
                <span className="text-sm font-medium">{t(`presets.${preset}`)}</span>
                <p className="text-muted-foreground flex-1 text-[11px]">
                  {t(`presets.${preset}Hint`)}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant={complete ? "ghost" : "outline"}
                  disabled={complete || applyingPreset !== null}
                  onClick={() => onApplyPreset(preset, missing)}
                  data-testid={`pi-preset-apply-${preset}`}
                >
                  {complete ? (
                    <>
                      <CheckIcon className="size-3.5" />
                      {t("presets.alreadyApplied")}
                    </>
                  ) : applyingPreset === preset ? (
                    t("presets.applying")
                  ) : (
                    t("presets.willInstall", { count: missing.length })
                  )}
                </Button>
              </div>
            )
          })}
        </div>
      </Card>

      <Card className="space-y-3 p-4" data-testid="pi-catalog-list">
        <div>
          <h3 className="text-sm font-semibold">{t("catalogTitle")}</h3>
          <p className="text-muted-foreground text-xs">
            {t("catalogDescription", { date: PI_PACKAGE_CATALOG[0]?.reviewedAt ?? "" })}
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("actions.search")}
            aria-label={t("actions.search")}
            className="h-8 text-sm"
          />
          <div className="flex gap-2">
            <Input
              value={customSpec}
              onChange={(event) => setCustomSpec(event.target.value)}
              placeholder={t("actions.installCustomPlaceholder")}
              aria-label={t("actions.installCustom")}
              className="h-8 font-mono text-sm"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={customSpec.trim() === "" || busySpec !== null}
              onClick={() => {
                onInstall(customSpec.trim())
                setCustomSpec("")
              }}
            >
              {t("actions.install")}
            </Button>
          </div>
        </div>

        <ul className="divide-y">
          {visible.map((entry) => {
            const installed = installedIdentities.has(piPackageIdentity(entry.spec))
            return (
              <li
                key={entry.id}
                className="flex items-start gap-3 py-2.5"
                data-testid={`pi-catalog-${entry.id}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-sm">{piPackageShortName(entry.spec)}</span>
                    <Badge
                      variant={
                        entry.tier === "avoid"
                          ? "destructive"
                          : entry.tier === "core"
                            ? "default"
                            : "outline"
                      }
                      className="text-[11px]"
                    >
                      {t(`tier.${entry.tier}`)}
                    </Badge>
                    {entry.toolCount > 0 && (
                      <span className="text-muted-foreground font-mono text-[11px]">
                        {entry.toolCount} · {entry.staticTokens.toLocaleString()}t
                      </span>
                    )}
                    {entry.spawnsContexts && (
                      <Badge variant="secondary" className="text-[11px] text-amber-600">
                        {t("budget.spawning")}
                      </Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {t(`catalog.${entry.id}.summary`)}
                  </p>
                  <p
                    className={cn(
                      "mt-1 text-[11px]",
                      entry.tier === "avoid" ? "text-destructive" : "text-muted-foreground"
                    )}
                  >
                    <span className="font-medium">{t("catalogFields.risk")}: </span>
                    {t(`catalog.${entry.id}.risk`)}
                  </p>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <p className="text-muted-foreground mt-1 w-fit text-[11px] underline decoration-dotted">
                        {t("catalogFields.removeWhen")}
                      </p>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-sm">
                      {t(`catalog.${entry.id}.removeWhen`)}
                    </TooltipContent>
                  </Tooltip>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {entry.docsUrl && (
                    <Button
                      asChild
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={t("actions.docs")}
                    >
                      <a href={entry.docsUrl} target="_blank" rel="noreferrer noopener">
                        <ExternalLinkIcon className="size-3.5" />
                      </a>
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant={installed ? "ghost" : "outline"}
                    disabled={installed || busySpec !== null}
                    onClick={() => onInstall(entry.spec)}
                    data-testid={`pi-catalog-install-${entry.id}`}
                  >
                    {installed ? (
                      <CheckIcon className="size-3.5" />
                    ) : (
                      <>
                        <PlusIcon className="size-3.5" />
                        {t("actions.install")}
                      </>
                    )}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      </Card>
    </div>
  )
}
