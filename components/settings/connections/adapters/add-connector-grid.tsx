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
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { getPlatformMeta } from "./platform-meta"

export interface AddConnectorGridProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Platform kinds that have a configuration dialog wired in. */
  kinds: readonly PlatformKind[]
  /** Count of already-configured instances per platform kind. */
  configuredCounts: Map<PlatformKind, number>
  /** Called with the chosen kind; the parent opens its config dialog. */
  onPick: (kind: PlatformKind) => void
}

export function AddConnectorGrid({
  open,
  onOpenChange,
  kinds,
  configuredCounts,
  onPick,
}: AddConnectorGridProps) {
  const t = useTranslations("settings.connections.adapters")
  const [query, setQuery] = useState("")

  const items = useMemo(() => {
    const all = kinds.map((kind) => {
      const meta = getPlatformMeta(kind)
      return {
        kind,
        label: t(`platforms.${meta.labelKey}`),
        description: t(`platformDescriptions.${meta.labelKey}`),
        Icon: meta.Icon,
        count: configuredCounts.get(kind) ?? 0,
      }
    })
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        it.description.toLowerCase().includes(q) ||
        it.kind.toLowerCase().includes(q)
    )
  }, [kinds, configuredCounts, query, t])

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
              {items.map(({ kind, label, description, Icon, count }) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => handlePick(kind)}
                  data-testid={`add-connector-card-${kind}`}
                  className={cn(
                    "group flex items-start gap-3 rounded-lg border bg-card p-3 text-left",
                    "transition-colors hover:border-primary/40 hover:bg-muted/40",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  )}
                >
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
                    <Icon className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{label}</span>
                      {count > 0 && (
                        <Badge
                          variant="secondary"
                          className="shrink-0 gap-1 text-[10px]"
                          data-testid={`add-connector-count-${kind}`}
                        >
                          {t("addConnector.configuredCount", { count })}
                        </Badge>
                      )}
                    </span>
                    <span className="block text-xs text-muted-foreground">{description}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
