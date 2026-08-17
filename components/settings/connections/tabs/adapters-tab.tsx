"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { BotIcon, MenuIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { SettingsEmptyState } from "@/components/settings/common/settings-section"
import { getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow, OutboundJobRow } from "@/lib/db/connector-types"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { TelegramConfigDialog } from "../forms/telegram-config"
import { LarkConfigDialog } from "../forms/lark-config"
import { DiscordConfigDialog } from "../forms/discord-config"
import { SlackConfigDialog } from "../forms/slack-config"
import { OneBotConfigDialog } from "../forms/onebot-config"
import { WeComConfigDialog } from "../forms/wecom-config"
import { WeChatPersonalConfigDialog } from "../forms/wechat-personal-config"
import { MatrixConfigDialog } from "../forms/matrix-config"
import { QQOfficialConfigDialog } from "../forms/qq-official-config"
import { WechatOaConfigDialog } from "../forms/wechat-oa-config"
import { DingTalkConfigDialog } from "../forms/dingtalk-config"
import { AdapterDetailPanel } from "../adapters/adapter-detail-panel"
import { AdapterSidebar, type AdapterStatusFilter } from "../adapters/adapter-sidebar"
import { getPlatformMeta } from "../adapters/platform-meta"
import { AddConnectorGrid } from "../adapters/add-connector-grid"
import { useSelectedAdapter } from "../adapters/use-selected-adapter"
import { listConnectorMetadata } from "@/lib/connectors/adapter-metadata"

// Platform kinds whose configuration dialog is wired into this tab. Each ships
// with a dialog under `../forms/`; the dispatcher below picks the right one by
// `row.type`. This list also drives the AddConnectorGrid picker.
type ConfigurableKind =
  | "telegram"
  | "lark"
  | "discord"
  | "slack"
  | "onebot"
  | "wecom"
  | "wechat-personal"
  | "matrix"
  | "qq-official"
  | "wechat-oa"
  | "dingtalk"

const CONFIGURABLE_KINDS: ConfigurableKind[] = [
  "telegram",
  "lark",
  "discord",
  "slack",
  "onebot",
  "wecom",
  "wechat-personal",
  "matrix",
  "qq-official",
  "wechat-oa",
  "dingtalk",
]

// Platforms the union reserves but that have no factory / dialog yet
// (`ConnectorMeta.status === "planned"`). Shown in the picker as disabled
// "Planned" cards so the roadmap is visible without a dead click target.
const PLANNED_KINDS: readonly PlatformKind[] = listConnectorMetadata()
  .filter((meta) => meta.status === "planned")
  .map((meta) => meta.type)

function isConfigurableKind(kind: PlatformKind): kind is ConfigurableKind {
  return (CONFIGURABLE_KINDS as PlatformKind[]).includes(kind)
}

type EditingDialog = {
  /** Which config dialog is currently visible; null = none. */
  kind: ConfigurableKind
  /** Pre-fill row for edit; null = adding a new instance. */
  row: AdapterInstanceRow | null
}

export function AdaptersTab() {
  const t = useTranslations("settings.connections.adapters")
  const [editing, setEditing] = useState<EditingDialog | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<AdapterStatusFilter>("all")
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false)
  const { selectedAdapterId, setSelectedAdapterId } = useSelectedAdapter()

  const adapters = useLiveQuery<AdapterInstanceRow[]>(
    () =>
      typeof window === "undefined" ? Promise.resolve([]) : getDb().adapterInstances.toArray(),
    []
  )

  // Per-adapter pending+sending count for the row badge. Reads the
  // outboundQueue directly so the count is always live (vs. waiting up to
  // 30 s for the next heartbeat to refresh `pendingOutboundCount`).
  const outboundJobs = useLiveQuery<OutboundJobRow[]>(
    () => (typeof window === "undefined" ? Promise.resolve([]) : getDb().outboundQueue.toArray()),
    []
  )
  const pendingByAdapter = useMemo(() => {
    const counts = new Map<string, number>()
    for (const job of outboundJobs ?? []) {
      if (job.status === "pending" || job.status === "sending") {
        counts.set(job.adapterId, (counts.get(job.adapterId) ?? 0) + 1)
      }
    }
    return counts
  }, [outboundJobs])

  // Configured-instance count per platform kind, for the picker badges.
  const configuredCounts = useMemo(() => {
    const counts = new Map<PlatformKind, number>()
    for (const row of adapters ?? []) {
      counts.set(row.type, (counts.get(row.type) ?? 0) + 1)
    }
    return counts
  }, [adapters])

  // Sidebar list filtered by the status tab + search box. Search matches the
  // display name or the platform kind (case-insensitive).
  const visibleAdapters = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (adapters ?? []).filter((row) => {
      if (statusFilter === "enabled" && !row.enabled) return false
      if (statusFilter === "disabled" && row.enabled) return false
      if (!q) return true
      return row.displayName.toLowerCase().includes(q) || row.type.toLowerCase().includes(q)
    })
  }, [adapters, statusFilter, search])

  const selectedRow = useMemo(
    () => (adapters ?? []).find((row) => row.id === selectedAdapterId),
    [adapters, selectedAdapterId]
  )

  const onConfigure = (row: AdapterInstanceRow) => {
    if (isConfigurableKind(row.type)) {
      setEditing({ kind: row.type, row })
    }
  }

  const onPickPlatform = (kind: PlatformKind) => {
    if (isConfigurableKind(kind)) {
      setAddOpen(false)
      setEditing({ kind, row: null })
    }
  }

  const closeDialog = (open: boolean) => {
    if (!open) setEditing(null)
  }

  const addButton = (
    <Button
      size="sm"
      variant="outline"
      onClick={() => setAddOpen(true)}
      data-testid="add-adapter-button"
    >
      <PlusIcon className="mr-2 h-3.5 w-3.5" />
      {t("addAdapter")}
    </Button>
  )

  const isEmpty = !adapters || adapters.length === 0

  // Shared sidebar — rendered in the desktop column and the mobile drawer.
  const sidebar = (
    <AdapterSidebar
      adapters={visibleAdapters}
      pendingByAdapter={pendingByAdapter}
      onConfigure={onConfigure}
      searchQuery={search}
      onSearchChange={setSearch}
      statusFilter={statusFilter}
      onStatusFilterChange={setStatusFilter}
      addButton={addButton}
      onAfterSelect={() => setMobileSheetOpen(false)}
    />
  )

  const SelectedIcon = selectedRow ? getPlatformMeta(selectedRow.type).Icon : null

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {isEmpty ? (
        <Card>
          <CardContent className="py-2">
            <SettingsEmptyState
              icon={<BotIcon className="size-6" />}
              title={t("noAdaptersTitle")}
              description={t("noAdaptersHint")}
              action={addButton}
            />
          </CardContent>
        </Card>
      ) : (
        // Master-detail: a bordered sidebar (search + status filter + list +
        // stats) on md+ screens, collapsing to a Sheet drawer on mobile. The
        // detail panel reads the `?adapter=<id>` URL param set by row clicks.
        // Both panes own their internal scroll so the frame stays fixed
        // (mirrors the AI Provider page).
        <div
          className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[300px_1fr]"
          data-testid="adapters-shell"
        >
          {/* Desktop sidebar */}
          <div
            className="hidden min-h-0 overflow-hidden rounded-lg border md:flex md:flex-col"
            data-testid="adapters-sidebar"
          >
            {sidebar}
          </div>

          {/* Mobile top bar + drawer */}
          <div className="flex items-center gap-2 md:hidden">
            <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className="shrink-0 gap-1.5">
                  <MenuIcon className="size-4" />
                  {t("mobile.openConnectors")}
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-[320px] p-0">
                <SheetHeader className="px-3 pt-3">
                  <SheetTitle className="text-sm">{t("mobile.title")}</SheetTitle>
                </SheetHeader>
                {sidebar}
              </SheetContent>
            </Sheet>
            {selectedRow && (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {SelectedIcon && <SelectedIcon className="size-4 shrink-0 text-muted-foreground" />}
                <p className="truncate text-sm font-medium">{selectedRow.displayName}</p>
              </div>
            )}
            {/* Direct add — always visible on the mobile top bar so the
             * operator doesn't have to open the drawer to add an adapter. */}
            <Button
              variant="outline"
              size="icon"
              className="ml-auto size-8 shrink-0"
              onClick={() => setAddOpen(true)}
              aria-label={t("addAdapter")}
              data-testid="mobile-add-adapter-button"
            >
              <PlusIcon className="size-4" />
            </Button>
          </div>

          {/* Detail */}
          <div
            className="flex min-h-0 flex-col overflow-hidden rounded-lg border"
            data-testid="adapters-detail"
          >
            {selectedAdapterId ? (
              <AdapterDetailPanel adapterId={selectedAdapterId} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-4 py-16 text-center">
                <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                  <BotIcon className="size-6" />
                </span>
                <p className="max-w-sm text-sm text-muted-foreground">{t("detail.noSelection")}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Platform picker — brand-card grid → opens the matching dialog. */}
      <AddConnectorGrid
        open={addOpen}
        onOpenChange={setAddOpen}
        kinds={CONFIGURABLE_KINDS}
        plannedKinds={PLANNED_KINDS}
        configuredCounts={configuredCounts}
        onPick={onPickPlatform}
      />

      {/* Per-platform configuration dialogs. Only the dialog matching the
       * active `editing.kind` is open at any time so cross-platform state
       * cannot leak between forms. Mounting them all lets the dispatcher
       * stay a pure switch on `editing.kind`. */}
      <TelegramConfigDialog
        open={editing?.kind === "telegram"}
        onOpenChange={closeDialog}
        onCreated={setSelectedAdapterId}
        row={editing?.kind === "telegram" ? editing.row : null}
      />
      <LarkConfigDialog
        open={editing?.kind === "lark"}
        onOpenChange={closeDialog}
        onCreated={setSelectedAdapterId}
        row={editing?.kind === "lark" ? editing.row : null}
      />
      <DiscordConfigDialog
        open={editing?.kind === "discord"}
        onOpenChange={closeDialog}
        onCreated={setSelectedAdapterId}
        row={editing?.kind === "discord" ? editing.row : null}
      />
      <SlackConfigDialog
        open={editing?.kind === "slack"}
        onOpenChange={closeDialog}
        onCreated={setSelectedAdapterId}
        row={editing?.kind === "slack" ? editing.row : null}
      />
      <OneBotConfigDialog
        open={editing?.kind === "onebot"}
        onOpenChange={closeDialog}
        onCreated={setSelectedAdapterId}
        row={editing?.kind === "onebot" ? editing.row : null}
      />
      <WeComConfigDialog
        open={editing?.kind === "wecom"}
        onOpenChange={closeDialog}
        onCreated={setSelectedAdapterId}
        row={editing?.kind === "wecom" ? editing.row : null}
      />
      <WeChatPersonalConfigDialog
        open={editing?.kind === "wechat-personal"}
        onOpenChange={closeDialog}
        onCreated={setSelectedAdapterId}
        row={editing?.kind === "wechat-personal" ? editing.row : null}
      />
      <MatrixConfigDialog
        open={editing?.kind === "matrix"}
        onOpenChange={closeDialog}
        onCreated={setSelectedAdapterId}
        row={editing?.kind === "matrix" ? editing.row : null}
      />
      <QQOfficialConfigDialog
        open={editing?.kind === "qq-official"}
        onOpenChange={closeDialog}
        onCreated={setSelectedAdapterId}
        row={editing?.kind === "qq-official" ? editing.row : null}
      />
      <WechatOaConfigDialog
        open={editing?.kind === "wechat-oa"}
        onOpenChange={closeDialog}
        onCreated={setSelectedAdapterId}
        row={editing?.kind === "wechat-oa" ? editing.row : null}
      />
      <DingTalkConfigDialog
        open={editing?.kind === "dingtalk"}
        onOpenChange={closeDialog}
        onCreated={setSelectedAdapterId}
        row={editing?.kind === "dingtalk" ? editing.row : null}
      />
    </div>
  )
}
