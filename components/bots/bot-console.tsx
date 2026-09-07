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

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { BotMessageSquareIcon, PlusIcon } from "lucide-react"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
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
  const { rows, summary, loading } = useBotInstallations()
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
   * A deep link naming an installation this device does not have resolves to
   * nothing rather than quietly landing on the first row. Selecting something
   * else would make a broken link look like it worked.
   */
  const selected = useMemo(
    () => rows.find((row) => row.id === selectedId) ?? null,
    [rows, selectedId]
  )

  return (
    <FeaturePageShell
      storageId="bots"
      header={
        <FeaturePageHeader
          variant="management"
          icon={<BotMessageSquareIcon className="size-5" />}
          title={t("title")}
          description={t("description")}
          summary={t("summary", { armed: summary.armed, total: summary.total })}
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
            loading={loading}
            onSearchChange={setSearch}
            onStatusFilterChange={setStatusFilter}
            onSelect={onSelect}
          />
        ),
        label: t("listPane.label"),
        defaultSize: 26,
        minSize: 18,
        maxSize: 40,
      }}
      centerClassName="min-h-0"
    >
      <div className="flex h-full min-h-0 flex-col">
        <BotRuntimeNotice />
        <div className="min-h-0 flex-1">
          <BotDetail row={selected} {...(onDeselect ? { onUninstalled: onDeselect } : {})} />
        </div>
      </div>
      <InstallBotSheet open={installOpen} onOpenChange={setInstallOpen} onInstalled={onSelect} />
    </FeaturePageShell>
  )
}
