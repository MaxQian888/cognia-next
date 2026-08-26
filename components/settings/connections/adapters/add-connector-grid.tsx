"use client"

/**
 * AddConnectorGrid — the "Add a connector" platform picker.
 *
 * Replaces the old plain dropdown menu with a searchable grid of brand cards
 * (icon + name + one-line description + "configured" count). Selecting a card
 * opens that platform's existing configuration dialog — the grid itself owns
 * no form state, it just routes the chosen kind back to the AdaptersTab via
 * `onPick`. Keeps the shadcn Dialog + Card + Badge + Input vocabulary so it
 * matches the rest of the Connections settings.
 *
 * `plannedKinds` (from `listConnectorMetadata()` where `status === "planned"`)
 * render as disabled cards with a "Planned" badge and no `onPick` — the UI
 * axis of the planned-platform dormancy label (see `ConnectorMeta.status`).
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { SearchIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { getPlatformMeta } from "./platform-meta"

export interface AddConnectorGridProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Platform kinds that have a configuration dialog wired in. */
  kinds: readonly PlatformKind[]
  /**
   * Platform kinds reserved by the union but without a factory / dialog yet
   * (`ConnectorMeta.status === "planned"`). Rendered disabled with a
   * "Planned" badge; never passed to `onPick`.
   */
  plannedKinds?: readonly PlatformKind[]
  /**
   * Names for kinds outside the built-in vocabulary. A plugin contribution has
   * no `platforms.*` message, so without this every contributed connector would
   * render as "Unknown" — the label comes from the contribution itself.
   */
  labelsByKind?: ReadonlyMap<string, { label: string; description: string }>
  /** Count of already-configured instances per platform kind. */
  configuredCounts: Map<PlatformKind, number>
  /** Called with the chosen kind; the parent opens its config dialog. */
  onPick: (kind: PlatformKind) => void
}

const NO_PLANNED_KINDS: readonly PlatformKind[] = []

export function AddConnectorGrid({
  open,
  onOpenChange,
  kinds,
  plannedKinds = NO_PLANNED_KINDS,
  labelsByKind,
  configuredCounts,
  onPick,
}: AddConnectorGridProps) {
  const t = useTranslations("settings.connections.adapters")
  const [query, setQuery] = useState("")

  const items = useMemo(() => {
    const toItem = (kind: PlatformKind, planned: boolean) => {
      const meta = getPlatformMeta(kind)
      const contributed = labelsByKind?.get(kind)
      return {
        kind,
        label: contributed?.label ?? t(`platforms.${meta.labelKey}`),
        description: contributed
          ? t("addConnector.providedBy", { plugin: contributed.description })
          : t(`platformDescriptions.${meta.labelKey}`),
        Icon: meta.Icon,
        count: configuredCounts.get(kind) ?? 0,
        planned,
      }
    }
    // Configurable kinds first, planned kinds after — a planned card must
    // never shadow a buildable one with the same id.
    const configurable = new Set(kinds)
    const all = [
      ...kinds.map((kind) => toItem(kind, false)),
      ...plannedKinds.filter((kind) => !configurable.has(kind)).map((kind) => toItem(kind, true)),
    ]
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        it.description.toLowerCase().includes(q) ||
        it.kind.toLowerCase().includes(q)
    )
  }, [kinds, plannedKinds, labelsByKind, configuredCounts, query, t])

  const handlePick = (kind: PlatformKind) => {
    setQuery("")
    onPick(kind)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("")
        onOpenChange(next)
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-2xl"
        data-testid="add-connector-grid"
      >
        <DialogHeader>
          <DialogTitle>{t("addConnector.title")}</DialogTitle>
          <DialogDescription>{t("addConnector.description")}</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("addConnector.searchPlaceholder")}
            className="pl-9"
            data-testid="add-connector-search"
            aria-label={t("addConnector.searchPlaceholder")}
          />
        </div>

        <div className="-mx-2 flex-1 overflow-y-auto px-2">
          {items.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t("addConnector.noResults")}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {items.map(({ kind, label, description, Icon, count, planned }) => (
                <Button
                  key={kind}
                  type="button"
                  variant="outline"
                  onClick={planned ? undefined : () => handlePick(kind)}
                  disabled={planned}
                  aria-disabled={planned || undefined}
                  title={planned ? t("addConnector.plannedHint") : undefined}
                  data-testid={`add-connector-card-${kind}`}
                  data-planned={planned ? "true" : undefined}
                  className={cn(
                    "group h-auto items-start justify-start gap-3 whitespace-normal rounded-lg bg-transparent p-3 text-left font-normal",
                    "transition-colors hover:border-primary/40 hover:bg-muted/40",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    planned && "border-dashed opacity-70 hover:border-input hover:bg-transparent"
                  )}
                >
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
                    <Icon className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{label}</span>
                      {planned ? (
                        <Badge
                          variant="outline"
                          className="shrink-0 gap-1 text-[10px]"
                          data-testid={`add-connector-planned-${kind}`}
                        >
                          {t("addConnector.planned")}
                        </Badge>
                      ) : (
                        count > 0 && (
                          <Badge
                            variant="secondary"
                            className="shrink-0 gap-1 text-[10px]"
                            data-testid={`add-connector-count-${kind}`}
                          >
                            {t("addConnector.configuredCount", { count })}
                          </Badge>
                        )
                      )}
                    </span>
                    <span className="block text-xs text-muted-foreground">{description}</span>
                  </span>
                </Button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
