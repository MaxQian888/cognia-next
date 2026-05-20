"use client"

/**
 * Bottom Sheet that surfaces the plugin marketplace from inside the Discover
 * page (Phase 4 wiring). Uses the existing `usePluginMarketplace` hook so
 * the install pipeline (conflict detection, permission review, configuration)
 * runs through the same code path as `/plugins` — no new orchestration.
 *
 * On Capacitor mobile the install action is disabled (plugins require the
 * desktop runtime); the sheet still renders the catalog so the user knows
 * what's available.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { DownloadIcon, LoaderIcon, PuzzleIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import {
  usePluginMarketplace,
  type PluginMarketplaceEntry,
} from "@/hooks/plugins/use-plugin-marketplace"
import { usePlatform } from "@/hooks/use-platform"
import { cn } from "@/lib/utils"

export interface PluginMarketplaceSheetProps {
  /**
   * Set of plugin ids already installed locally — the sheet uses this to
   * hide entries the user has already added. Caller resolves from
   * `useLiveQuery(listPlugins)` so the value stays reactive.
   */
  installedIds: ReadonlySet<string>
  /** Optional sheet trigger override. Defaults to a "Browse marketplace" button. */
  trigger?: React.ReactNode
  className?: string
}

export function PluginMarketplaceSheet({
  installedIds,
  trigger,
  className,
}: PluginMarketplaceSheetProps) {
  const t = useTranslations("discover")
  const platform = usePlatform()
  const isMobile = platform === "mobile"
  const market = usePluginMarketplace()
  const [open, setOpen] = useState(false)

  // Refresh once the sheet opens — the hook auto-refreshes on first mount
  // anyway, so this is a no-op for users who opened the sheet from a cold
  // cache. We still call it so reopening after `query` changes refetches.
  // Wired through onOpenChange rather than a useEffect so the exhaustive-deps
  // rule stays satisfied without depending on `market.refresh` identity
  // (the hook returns a fresh closure each render).
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      if (next) void market.refresh()
    },
    [market]
  )

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        {trigger ?? (
          <Button
            type="button"
            variant="outline"
            className={cn("gap-2", className)}
            data-testid="discover-marketplace-trigger"
          >
            <PuzzleIcon className="size-4" />
            {t("marketplace.browse")}
          </Button>
        )}
      </SheetTrigger>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-3 sm:max-w-md"
        data-testid="discover-marketplace-sheet"
      >
        <SheetHeader>
          <SheetTitle>{t("marketplace.title")}</SheetTitle>
        </SheetHeader>
        <div className="px-4">
          <Input
            placeholder={t("marketplace.searchPlaceholder")}
            value={market.query}
            onChange={(e) => market.setQuery(e.target.value)}
            data-testid="discover-marketplace-search"
            aria-label={t("marketplace.searchPlaceholder")}
          />
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          <MarketplaceListings market={market} installedIds={installedIds} isMobile={isMobile} />
        </div>
      </SheetContent>
    </Sheet>
  )
}

function MarketplaceListings({
  market,
  installedIds,
  isMobile,
}: {
  market: ReturnType<typeof usePluginMarketplace>
  installedIds: ReadonlySet<string>
  isMobile: boolean
}) {
  const t = useTranslations("discover")

  // Surface the most useful entries first — search results when the user
  // has typed, otherwise featured + popular. Recent is omitted from the
  // discover panel because it overlaps with popular in practice; tap
  // "Refresh" if you want the freshest set.
  const queryTrimmed = market.query.trim()
  const entries = useMemo(() => {
    if (queryTrimmed.length > 0 && market.state.kind === "ready") {
      return market.state.results
    }
    // De-duplicate by id; featured precedes popular.
    const seen = new Set<string>()
    const out: PluginMarketplaceEntry[] = []
    for (const e of [...market.featured, ...market.popular]) {
      if (seen.has(e.id)) continue
      seen.add(e.id)
      out.push(e)
    }
    return out
  }, [queryTrimmed, market.state, market.featured, market.popular])

  if (market.state.kind === "loading") {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">{t("marketplace.loading")}</p>
    )
  }
  if (market.state.kind === "error") {
    return (
      <p
        className="py-6 text-center text-sm text-destructive"
        data-testid="discover-marketplace-error"
      >
        {market.state.error}
      </p>
    )
  }
  if (entries.length === 0) {
    return (
      <p
        className="py-6 text-center text-sm text-muted-foreground"
        data-testid="discover-marketplace-empty"
      >
        {t("marketplace.empty")}
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-2" data-testid="discover-marketplace-list">
      {entries.map((entry) => (
        <li key={entry.id}>
          <MarketplaceRow
            entry={entry}
            installed={installedIds.has(entry.id)}
            installing={market.installingId === entry.id}
            disabled={isMobile}
            onInstall={() => {
              void market
                .install(entry.id, entry.version)
                .then(() => toast.success(t("marketplace.installSuccess", { name: entry.name })))
                .catch((err: unknown) =>
                  toast.error(err instanceof Error ? err.message : String(err))
                )
            }}
          />
        </li>
      ))}
    </ul>
  )
}

function MarketplaceRow({
  entry,
  installed,
  installing,
  disabled,
  onInstall,
}: {
  entry: PluginMarketplaceEntry
  installed: boolean
  installing: boolean
  disabled: boolean
  onInstall: () => void
}) {
  const t = useTranslations("discover")
  return (
    <div
      className="flex items-start gap-3 rounded-md border border-border bg-card p-3"
      data-testid={`discover-marketplace-row-${entry.id}`}
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground">
        <PuzzleIcon className="size-5" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{entry.name}</span>
          {entry.signed ? (
            <Badge variant="outline" className="text-[10px]">
              {t("marketplace.verified")}
            </Badge>
          ) : null}
          {entry.version ? (
            <Badge variant="secondary" className="text-[10px]">
              v{entry.version}
            </Badge>
          ) : null}
        </div>
        {entry.description ? (
          <span className="line-clamp-2 text-xs text-muted-foreground">{entry.description}</span>
        ) : null}
        {disabled ? (
          <span className="text-xs text-muted-foreground">{t("marketplace.desktopOnly")}</span>
        ) : null}
      </div>
      {installed ? (
        <Badge variant="secondary" data-testid={`discover-marketplace-installed-${entry.id}`}>
          {t("marketplace.installed")}
        </Badge>
      ) : (
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={disabled || installing}
          aria-disabled={disabled || installing}
          onClick={onInstall}
          data-testid={`discover-marketplace-install-${entry.id}`}
          className="gap-1"
        >
          {installing ? (
            <LoaderIcon className="size-4 animate-spin" />
          ) : (
            <DownloadIcon className="size-4" />
          )}
          {t("marketplace.install")}
        </Button>
      )}
    </div>
  )
}
