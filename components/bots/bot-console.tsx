"use client"

/**
 * `/bots`, the console for every Bot installed on this account.
 *
 * A Bot is a binding, not an engine: it names an event source, a policy, an
 * executor and a set of credentials, and everything it actually does at
 * runtime belongs to something else. That is why this is a management surface
 * and not a monitor. A Bot's runs are `ExecutionRun` rows, so they already
 * appear on `/agent-runs` beside every other kind of run, and duplicating that
 * list here would be a second answer to the same question.
 *
 * Selection is a query parameter rather than a store, unlike `/devices`. A
 * dynamic `[id]` segment breaks the Tauri static export, and `?bot=` is the
 * link a plugin page, a notification or the palette can hand over.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { BotMessageSquareIcon, PlusIcon, TriangleAlertIcon } from "lucide-react"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useBotInstallations } from "@/hooks/bots/use-bot-installations"
import type { BotStatusFilter } from "@/lib/bot/console/bot-rows"

import { BotDetail } from "./bot-detail"
import { BotListPane } from "./bot-list-pane"
import { BotRuntimeNotice } from "./bot-runtime-notice"
import { InstallBotSheet } from "./install-bot-sheet"

export interface BotConsoleProps {
  /** The `?bot=` deep link. Undefined means nothing was asked for. */
  selectedId?: string
  onSelect: (installationId: string) => void
  /**
   * `?install=1`, the deep link the palette and a plugin page hand over.
   *
   * Latched into state during render rather than read straight from the param,
   * so closing the sheet does not fight a URL that still says "open". An effect
   * would open it a paint late and `react-hooks/set-state-in-effect` refuses
   * one anyway. Same shape as `DeviceConsole`'s `?addHost=1`.
   */
  installParam?: string | null
  /** Clears the selection after the selected installation is uninstalled. */
  onDeselect?: () => void
}

export function BotConsole({
  selectedId,
  onSelect,
  installParam = null,
  onDeselect,
}: BotConsoleProps) {
  const t = useTranslations("bots")
  const { rows, summary, loading, failed } = useBotInstallations()
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<BotStatusFilter>("all")
  const [installOpen, setInstallOpen] = useState(() => Boolean(installParam))
  const [seenInstallParam, setSeenInstallParam] = useState(installParam)
  if (installParam !== seenInstallParam) {
    setSeenInstallParam(installParam)
    // Only a NEW param opens the sheet. Clearing it must not slam a sheet the
    // user opened from the header shut.
    if (installParam) setInstallOpen(true)
  }

  /**
   * The overlay tier keeps the list in a Sheet. A row tap there selects the
   * CENTER pane's content, so the sheet must close on selection or the tap
   * updates a pane the reader cannot see — the dead end the shell's own
   * contract warns about. Controlled here; the desktop branch ignores both
   * props.
   */
  const [listOpen, setListOpen] = useState(false)
  const selectRow = useCallback(
    (installationId: string) => {
      setListOpen(false)
      onSelect(installationId)
    },
    [onSelect]
  )

  /**
   * A deep link naming an installation this device does not have resolves to
   * nothing rather than quietly landing on the first row. Selecting something
   * else would make a broken link look like it worked.
   */
  const selected = useMemo(
    () => rows.find((row) => row.id === selectedId) ?? null,
    [rows, selectedId]
  )

  /**
   * First visit selects the most recently touched Bot, the same way
   * `/devices` reopens on the local device: a console that opens blank makes
   * the reader ask for the thing the page could have answered itself. Rows
   * are already `updatedAt`-descending, so `rows[0]` is that Bot.
   *
   * One-shot. Once it fires it never re-arms, so `onDeselect` (which clears
   * `?bot=`) is not immediately overwritten, and a deep link that names a row
   * we do not have keeps the documented "resolve to nothing" behaviour —
   * `selectedId` being set at all is enough to stay out of the link's way.
   */
  const didAutoSelect = useRef(false)
  useEffect(() => {
    if (didAutoSelect.current || loading || selectedId !== undefined || rows.length === 0) {
      return
    }
    didAutoSelect.current = true
    onSelect(rows[0].id)
  }, [loading, onSelect, rows, selectedId])

  return (
    <FeaturePageShell
      storageId="bots"
      header={
        <FeaturePageHeader
          variant="management"
          icon={<BotMessageSquareIcon className="size-5" />}
          title={t("title")}
          description={t("description")}
          summary={
            // "0 of 0 armed" is a stat about nothing; the empty rail already
            // says the page has no Bots.
            summary.total > 0
              ? t("summary", { armed: summary.armed, total: summary.total })
              : undefined
          }
          actions={
            <Button size="sm" onClick={() => setInstallOpen(true)} data-testid="bots-install-open">
              <PlusIcon className="size-3.5" aria-hidden />
              {t("install.action")}
            </Button>
          }
          status={
            /**
             * The one number this page is actually scanned for. An unbound
             * credential and a dead-lettered delivery are the two states that
             * need a person, and both are invisible from the rail alone.
             */
            summary.needsAttention > 0 ? (
              <Badge
                variant="outline"
                className="gap-1.5 font-normal text-amber-600 dark:text-amber-400"
                data-testid="bots-attention-count"
              >
                <span
                  aria-hidden="true"
                  className="inline-block size-1.5 rounded-full bg-current"
                />
                {t("attentionCount", { count: summary.needsAttention })}
              </Badge>
            ) : null
          }
          testId="bots-header"
        />
      }
      leftPane={{
        content: (
          <BotListPane
            rows={rows}
            selectedId={selected?.id ?? null}
            search={search}
            statusFilter={statusFilter}
            loading={loading || failed}
            onSearchChange={setSearch}
            onStatusFilterChange={setStatusFilter}
            onSelect={selectRow}
          />
        ),
        label: t("listPane.label"),
        // A fixed rail, not a percentage: a two-line row does not get more
        // readable as the window widens, and a percentage cap let the rail
        // eat enough of the center pane to collapse the detail grid at
        // ordinary window widths. `centerPaneSize` hands back `undefined`
        // for a CSS-length sibling and the center takes the remainder.
        defaultSize: "19rem",
        minSize: "15rem",
        maxSize: "22rem",
        open: listOpen,
        onOpenChange: setListOpen,
      }}
      centerClassName="min-h-0"
    >
      <div className="flex h-full min-h-0 flex-col">
        <BotRuntimeNotice />
        {failed ? (
          // A persistent read failure, not an event — a toast would fire once
          // and leave the stale rows unmarked. Kept inline but compact, in
          // the same surface as the runtime notice above it.
          <Alert
            variant="destructive"
            className="mx-3 mt-2 w-auto py-2"
            data-testid="bots-sync-failed"
          >
            <TriangleAlertIcon className="size-4" />
            <AlertDescription className="text-xs">{t("syncFailed")}</AlertDescription>
          </Alert>
        ) : null}
        <div className="min-h-0 flex-1">
          <BotDetail
            row={selected}
            loading={loading}
            missing={Boolean(selectedId) && !loading && !failed && !selected}
            {...(onDeselect ? { onUninstalled: onDeselect } : {})}
          />
        </div>
      </div>
      <InstallBotSheet open={installOpen} onOpenChange={setInstallOpen} onInstalled={onSelect} />
    </FeaturePageShell>
  )
}
