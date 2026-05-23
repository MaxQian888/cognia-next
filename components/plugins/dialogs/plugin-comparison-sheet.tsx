"use client"

// Side-by-side comparison sheet for marketplace entries that the user
// queued via the marketplace card's "Compare" toggle. Reads / writes
// `comparisonIds` + `comparisonOpen` on the persistent marketplace store
// so the queue survives navigation and the sheet can be opened from any
// surface that mounts a "Compare ({n})" trigger.
//
// The store caps comparison at 2 entries to keep the table readable on
// every viewport — anything richer would crowd mobile.

import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"
import { AlertTriangleIcon, CheckIcon, DownloadIcon, StarIcon, XIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Card } from "@/components/ui/card"
import { usePluginMarketplaceStore } from "@/stores/plugin-runtime/plugin-marketplace-store"
import type { PluginMarketplaceEntry } from "@/hooks/plugins/use-plugin-marketplace"

interface ResolvedEntry extends PluginMarketplaceEntry {
  capabilities?: string[]
  permissions?: string[]
  signed?: boolean
}

interface Props {
  /** Optional resolver — defaults to looking up entries from a passed-in map. */
  resolveEntry?: (id: string) => ResolvedEntry | undefined
  /** Map of entry-id → entry. Pass the marketplace results here. */
  entries: ResolvedEntry[]
  installedIds?: ReadonlySet<string>
  onInstall?: (id: string, version?: string) => void
}

const DANGEROUS_PERMS = new Set([
  "shell:execute",
  "process:spawn",
  "python:execute",
  "filesystem:write",
])

export function PluginComparisonSheet({ resolveEntry, entries, installedIds, onInstall }: Props) {
  const t = useTranslations("plugins.comparison")
  const open = usePluginMarketplaceStore((s) => s.comparisonOpen)
  const ids = usePluginMarketplaceStore((s) => s.comparisonIds)
  const setOpen = usePluginMarketplaceStore((s) => s.setComparisonOpen)
  const remove = usePluginMarketplaceStore((s) => s.removeFromComparison)
  const clearAll = usePluginMarketplaceStore((s) => s.clearComparison)

  // Auto-close once the queue empties — the sheet has nothing to show.
  useEffect(() => {
    if (open && ids.length === 0) setOpen(false)
  }, [open, ids.length, setOpen])

  const lookup = resolveEntry ?? ((id: string) => entries.find((e) => e.id === id))

  const resolved = ids
    .map((id) => lookup(id))
    .filter((entry): entry is ResolvedEntry => entry !== undefined)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-2xl overflow-y-auto"
        data-testid="plugin-comparison-sheet"
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {t("title")}
            <Badge variant="outline" className="text-xs">
              {t("count", { count: ids.length })}
            </Badge>
          </SheetTitle>
        </SheetHeader>

        {resolved.length === 0 ? (
          <Card className="p-6 text-center mt-4 text-sm text-muted-foreground">{t("empty")}</Card>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <div
              className="grid gap-3"
              style={{
                gridTemplateColumns: `repeat(${resolved.length}, minmax(14rem,1fr))`,
              }}
            >
              {resolved.map((entry) => (
                <ComparisonColumn
                  key={entry.id}
                  entry={entry}
                  installed={installedIds?.has(entry.id) ?? false}
                  onRemove={() => remove(entry.id)}
                  onInstall={onInstall}
                />
              ))}
            </div>
          </div>
        )}

        <SheetFooter className="mt-4 gap-2">
          <Button variant="outline" size="sm" onClick={() => clearAll()}>
            {t("clearAll")}
          </Button>
          <Button size="sm" onClick={() => setOpen(false)}>
            {t("close")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

interface ColumnProps {
  entry: ResolvedEntry
  installed: boolean
  onRemove: () => void
  onInstall?: (id: string, version?: string) => void
}

function ComparisonColumn({ entry, installed, onRemove, onInstall }: ColumnProps) {
  const t = useTranslations("plugins.comparison")
  const dangerousCount = (entry.permissions ?? []).filter((p) => DANGEROUS_PERMS.has(p)).length

  return (
    <Card className="p-3 space-y-2 flex flex-col">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-0.5 min-w-0">
          <p className="font-medium truncate">{entry.name}</p>
          <p className="text-xs text-muted-foreground truncate">v{entry.version}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={onRemove}
          aria-label={t("removeAria", { name: entry.name })}
          data-testid={`plugin-comparison-remove-${entry.id}`}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>

      {entry.author && <Row label={t("author")} value={entry.author} />}
      {typeof entry.rating === "number" && entry.rating > 0 && (
        <Row
          label={t("rating")}
          value={
            <span className="flex items-center gap-1">
              <StarIcon className="size-3 fill-current" />
              {entry.rating.toFixed(1)}
            </span>
          }
        />
      )}
      {typeof entry.downloads === "number" && entry.downloads > 0 && (
        <Row
          label={t("downloads")}
          value={
            <span className="flex items-center gap-1">
              <DownloadIcon className="size-3" />
              {entry.downloads.toLocaleString()}
            </span>
          }
        />
      )}
      <Row
        label={t("signed")}
        value={
          entry.signed ? (
            <span className="flex items-center gap-1 text-green-700 dark:text-green-400">
              <CheckIcon className="size-3" />
              {t("yes")}
            </span>
          ) : (
            t("no")
          )
        }
      />
      {(entry.capabilities ?? []).length > 0 && (
        <Row
          label={t("capabilities")}
          value={
            <div className="flex flex-wrap gap-1 justify-end">
              {(entry.capabilities ?? []).map((cap) => (
                <Badge key={cap} variant="outline" className="text-xs">
                  {cap}
                </Badge>
              ))}
            </div>
          }
        />
      )}
      <Row
        label={t("permissions")}
        value={
          <div className="text-right">
            <div className="text-xs">
              {t("permissionsCount", { count: (entry.permissions ?? []).length })}
            </div>
            {dangerousCount > 0 && (
              <Badge variant="destructive" className="text-xs gap-1 mt-0.5">
                <AlertTriangleIcon className="size-3" />
                {t("dangerousCount", { count: dangerousCount })}
              </Badge>
            )}
          </div>
        }
      />

      <div className="mt-auto pt-2">
        {installed ? (
          <Badge variant="secondary" className="w-full justify-center text-xs">
            {t("installed")}
          </Badge>
        ) : onInstall ? (
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={() => onInstall(entry.id, entry.version)}
          >
            {t("install")}
          </Button>
        ) : null}
      </div>
    </Card>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2 text-xs border-t pt-1.5">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <div className="text-right min-w-0">{value}</div>
    </div>
  )
}

/**
 * Standalone helper component that renders a "Compare (n)" trigger button.
 * Pulled out so the marketplace and any other surface can mount it without
 * duplicating the store wiring.
 */
export function PluginComparisonTrigger() {
  const t = useTranslations("plugins.comparison")
  const ids = usePluginMarketplaceStore((s) => s.comparisonIds)
  const setOpen = usePluginMarketplaceStore((s) => s.setComparisonOpen)
  const [hydrated, setHydrated] = useState(false)

  // Avoid SSR/CSR mismatch — the persisted store hydrates after mount.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setHydrated(true), [])

  if (!hydrated || ids.length === 0) return null

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => setOpen(true)}
      data-testid="plugin-comparison-trigger"
    >
      {t("triggerLabel", { count: ids.length })}
    </Button>
  )
}
