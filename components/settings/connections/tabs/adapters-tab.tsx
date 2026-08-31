"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { BotIcon, MenuIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { SettingsEmptyState } from "@/components/settings/common/settings-section"
import { getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow, OutboundJobRow } from "@/lib/db/connector-types"
import { isPlatformKind, type PlatformKind } from "@/types/connectors/platform-kind"
import { listPluginConnectors } from "@/lib/connectors/plugin-connector-registry"
import { PluginConnectorConfigDialog } from "../forms/plugin-connector-config"
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
import { usePendingPlatform, useSelectedAdapter } from "../adapters/use-selected-adapter"
import { listConnectorMetadata } from "@/lib/connectors/adapter-metadata"
import { SettingsListDetail } from "@/components/settings/common/settings-master-detail"

// Built-in platform kinds with a bespoke configuration dialog under
// `../forms/`; the dispatcher below picks one by `row.type`. Plugin-contributed
// kinds are NOT listed here — they are resolved at render time from the
// registry and configured by the schema-driven `PluginConnectorConfigDialog`,
// because their set changes whenever a plugin is enabled or disabled.
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
  /**
   * Which config dialog is currently visible; null = none. A kind outside
   * `ConfigurableKind` is a plugin contribution and opens the schema-driven
   * dialog instead.
   */
  kind: PlatformKind
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
  const { pendingPlatform, clearPendingPlatform } = usePendingPlatform()

  const adapters = useLiveQuery<AdapterInstanceRow[]>(
    () =>
      typeof window === "undefined" ? Promise.resolve([]) : getDb().adapterInstances.toArray(),
    []
  )

  // Contributions are registered when a plugin is enabled and dropped when it
  // is disabled, so the picker's kind list cannot be a module constant — and it
  // cannot be captured once at mount either. Keyed on the adapter list, which
  // is what re-renders this tab; a plugin toggled while the tab is open lands
  // on the next configuration change rather than never.
  // `adapters` is a re-read trigger, not an input — the registry is module
  // state the linter cannot see, so an "unnecessary" dependency is the only way
  // to express "recompute when this tab next hears about a change".
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pluginConnectors = useMemo(() => listPluginConnectors(), [adapters])
  const pluginKinds = useMemo(
    () => pluginConnectors.map((registration) => registration.type),
    [pluginConnectors]
  )
  const pickerKinds = useMemo<PlatformKind[]>(
    () => [...CONFIGURABLE_KINDS, ...pluginKinds],
    [pluginKinds]
  )
  const pluginLabels = useMemo(
    () =>
      new Map(
        pluginConnectors.map((registration) => [
          registration.type,
          {
            label: registration.def.displayName ?? registration.type,
            description: registration.pluginId,
          },
        ])
      ),
    [pluginConnectors]
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

  // A row whose plugin has since been disabled still opens: the schema-driven
  // dialog says the implementation is gone rather than the button doing
  // nothing, which is what a kind outside the hardcoded list used to do.
  const onConfigure = (row: AdapterInstanceRow) => {
    if (isConfigurableKind(row.type) || !isPlatformKind(row.type)) {
      setEditing({ kind: row.type, row })
    }
  }

  const onPickPlatform = (kind: PlatformKind) => {
    if (isConfigurableKind(kind) || pluginKinds.includes(kind)) {
      setAddOpen(false)
      setEditing({ kind, row: null })
    }
  }

  // `?platform=<kind>` arrives from surfaces that browse the platform CATALOG
  // rather than this list: the Discover connector inspector, the Inbox health
  // popover, the Feishu docs row. The user picked a platform, so land them on
  // their first instance of it, or straight in the "add" dialog when they have
  // none. Consumed on arrival so a re-render cannot reopen the dialog behind
  // them.
  //
  // This one cannot be derived into initial state the way the MCP preset deep
  // link is: the decision needs `adapters`, which arrives from an async Dexie
  // read, so on first render there is nothing yet to decide against. Reacting
  // to that arrival is exactly what an effect is for.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!pendingPlatform || !adapters) return
    clearPendingPlatform()
    if (!isPlatformKind(pendingPlatform)) return
    const existing = adapters.find((row) => row.type === pendingPlatform)
    if (existing) {
      setSelectedAdapterId(existing.id)
      return
    }
    // No instance yet. A configurable kind opens its own dialog. A planned or
    // plugin-less kind has no dialog to open, so fall back to the picker,
    // where it renders as a disabled "Planned" card that explains itself.
    if (isConfigurableKind(pendingPlatform) || pluginKinds.includes(pendingPlatform)) {
      setEditing({ kind: pendingPlatform, row: null })
    } else {
      setAddOpen(true)
    }
  }, [pendingPlatform, adapters, pluginKinds, clearPendingPlatform, setSelectedAdapterId])
  /* eslint-enable react-hooks/set-state-in-effect */

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
        // stats) once the pane is wide enough, collapsing to a Sheet drawer
        // below that. The threshold is the pane's own width, not the
        // viewport — this pane is the window minus the app rail minus the
        // settings sidebar, so `md:` used to fire ~330px early. The
        // detail panel reads the `?adapter=<id>` URL param set by row clicks.
        // Both panes own their internal scroll so the frame stays fixed
        // (mirrors the AI Provider page).
        <SettingsListDetail listWidth={300} data-testid="adapters-shell">
          {/* Sidebar, once the pane is wide enough to hold one */}
          <div
            className="hidden min-h-0 overflow-hidden rounded-lg border @[560px]/settings-pane:flex @[560px]/settings-pane:flex-col"
            data-testid="adapters-sidebar"
          >
            {sidebar}
          </div>

          {/* Narrow-pane top bar + drawer */}
          <div className="flex items-center gap-2 @[560px]/settings-pane:hidden">
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
        </SettingsListDetail>
      )}

      {/* Platform picker — brand-card grid → opens the matching dialog. */}
      <AddConnectorGrid
        open={addOpen}
        onOpenChange={setAddOpen}
        kinds={pickerKinds}
        labelsByKind={pluginLabels}
        plannedKinds={PLANNED_KINDS}
        configuredCounts={configuredCounts}
        onPick={onPickPlatform}
      />

      {/* Per-platform configuration dialogs. Only the dialog matching the
       * active `editing.kind` is open at any time so cross-platform state
       * cannot leak between forms. Mounting them all lets the dispatcher
       * stay a pure switch on `editing.kind`. */}
      {/* Schema-driven fallback for every contributed kind. Mounted once and
       * keyed by kind so switching between two contributions cannot carry
       * state, the same rule the bespoke dialogs follow by being separate
       * components. */}
      {editing && !isConfigurableKind(editing.kind) && (
        <PluginConnectorConfigDialog
          key={editing.kind}
          open
          kind={editing.kind}
          onOpenChange={closeDialog}
          onCreated={setSelectedAdapterId}
          row={editing.row}
        />
      )}
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
