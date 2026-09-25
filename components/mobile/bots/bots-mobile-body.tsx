"use client"

/**
 * `/bots` on a phone.
 *
 * `FeaturePageShell` does have a compact branch, but it collapses the left
 * pane into a Sheet trigger. For a per-installation console that is
 * backwards: the list is not a sidebar here, it is the page, and the detail
 * is what should arrive on demand. So this inverts the two and reuses both
 * halves verbatim — the same inversion `DevicesMobileBody` made, for the
 * same reason.
 *
 * Unlike `/devices`, selection lives in `?bot=` rather than a store, so the
 * drawer simply renders whatever the URL names: a tap writes the param, a
 * deep link opens the drawer directly, and closing it clears the param —
 * which also means uninstall flows back out through `onDeselect` for free.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, TriangleAlertIcon } from "lucide-react"

import { BotDetail } from "@/components/bots/bot-detail"
import { BotListPane } from "@/components/bots/bot-list-pane"
import { BotRuntimeNotice } from "@/components/bots/bot-runtime-notice"
import { InstallBotSheet } from "@/components/bots/install-bot-sheet"
import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useBotInstallations } from "@/hooks/bots/use-bot-installations"
import type { BotStatusFilter } from "@/lib/bot/console/bot-rows"

export interface BotsMobileBodyProps {
  /** The `?bot=` deep link; the drawer opens on it. */
  selectedId?: string
  onSelect: (installationId: string) => void
  onDeselect: () => void
  /** `?install=1`, same deep link the desktop console consumes. */
  installParam?: string | null
}

export function BotsMobileBody({
  selectedId,
  onSelect,
  onDeselect,
  installParam = null,
}: BotsMobileBodyProps) {
  const t = useTranslations("bots")
  const { rows, summary, loading, failed } = useBotInstallations()
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<BotStatusFilter>("all")

  // Same render-latch as `BotConsole`: a NEW `?install=1` opens the sheet,
  // clearing the param must not slam one the user opened from the header.
  const [installOpen, setInstallOpen] = useState(() => Boolean(installParam))
  const [seenInstallParam, setSeenInstallParam] = useState(installParam)
  if (installParam !== seenInstallParam) {
    setSeenInstallParam(installParam)
    if (installParam) setInstallOpen(true)
  }

  const selected = rows.find((row) => row.id === selectedId) ?? null

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="bots-mobile-body">
      <header className="safe-area-pt flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">{t("title")}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {/* On an empty page the description answers "what is this"; the
                armed/total stat answers it with "0 of 0". */}
            {summary.total > 0
              ? t("summary", { armed: summary.armed, total: summary.total })
              : t("description")}
          </p>
        </div>
        <Button
          size="icon"
          variant="outline"
          className="size-8"
          aria-label={t("install.action")}
          onClick={() => setInstallOpen(true)}
          data-testid="mobile-bots-install"
        >
          <PlusIcon className="size-4" />
        </Button>
      </header>

      {/* Whether anything will actually run these Bots matters MORE here than
          on the desktop shell — a phone almost never is the runner. */}
      <div className="shrink-0">
        <BotRuntimeNotice hasBots={rows.length > 0} />
        {failed ? (
          // Same persistent-state alert as the desktop console — a toast would
          // vanish while the rows below stay stale.
          <Alert
            variant="destructive"
            className="mx-3 mt-2 w-auto py-2"
            data-testid="bots-sync-failed"
          >
            <TriangleAlertIcon className="size-4" />
            <AlertDescription className="text-xs">{t("syncFailed")}</AlertDescription>
          </Alert>
        ) : null}
      </div>

      <div className="min-h-0 flex-1">
        <BotListPane
          rows={rows}
          selectedId={selected?.id ?? null}
          search={search}
          statusFilter={statusFilter}
          loading={loading || failed}
          onSearchChange={setSearch}
          onStatusFilterChange={setStatusFilter}
          onSelect={onSelect}
          onInstall={() => setInstallOpen(true)}
        />
      </div>

      <ResponsiveDetailSheet
        open={Boolean(selected)}
        onOpenChange={(next) => {
          if (!next) onDeselect()
        }}
        title={selected?.name ?? t("title")}
      >
        {/*
          The drawer caps itself at 85vh, and `BotDetail` is `h-full` with its
          own scroller. A bounded box between the two gives the scroller
          something definite to resolve against.
        */}
        <div className="h-[68vh] min-h-0">
          <BotDetail row={selected} onUninstalled={onDeselect} />
        </div>
      </ResponsiveDetailSheet>

      <InstallBotSheet open={installOpen} onOpenChange={setInstallOpen} onInstalled={onSelect} />
    </div>
  )
}
