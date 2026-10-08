"use client"

/**
 * `/devices` — one console for every machine this account can reach.
 *
 * It replaces the reading half of two surfaces that could not see each other:
 * the paired-devices table in Settings → Companion and the host list in
 * Settings → Remote hosts. Pairing a phone and adding a host stay reachable
 * from here (pairing as a route, adding a host in place), because a fleet view
 * with no way to grow the fleet is a dead end.
 *
 * Which device is open is `useDeviceSelection`: a `?device=` link first, then
 * the user's choice (mirrored back into the URL), then this machine, which is
 * the one row that is always present and always safe to show.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { RefreshCwIcon, ServerIcon, SmartphoneIcon, WaypointsIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { Button } from "@/components/ui/button"
import { SyncApprovalFleetNotice } from "@/components/account/sync/sync-approval-fleet-notice"
import { accountSyncEnabled } from "@/lib/account-sync/feature-flag"
import { useAccountSyncStore } from "@/stores/account-sync/account-sync-store"
import { useDeviceConsoleStore } from "@/stores/devices/device-console-store"
import { useDeviceGrantActions } from "@/hooks/devices/use-device-grant-actions"
import { useDeviceRows } from "@/hooks/devices/use-device-rows"
import { useAddHostSheetState } from "@/hooks/devices/use-add-host-sheet-state"
import { useDeviceSectionLink } from "@/hooks/devices/use-device-section-link"
import { useDeviceSelection } from "@/hooks/devices/use-device-selection"
import { useRefreshing } from "@/hooks/ui/use-refreshing"
import { hasHostRuntime } from "@/lib/platform/capabilities"
import { remoteHostRef } from "@/lib/devices/build-device-rows"
import { devicePairHref } from "@/lib/devices/pair-entry"
import { newSshHostSettingsHref } from "@/lib/terminal/terminal-settings-link"
import type { RemoteHost } from "@/stores/remote-host/remote-host-store"

import { AddHostSheet } from "./add-host-sheet"
import { DeviceDetail } from "./device-detail"
import { ExecutionHostChip } from "./execution-host-switcher"
import { DeviceListPane } from "./device-list-pane"
import {
  HostUnreachableNotice,
  MissingDeviceLinkNotice,
  StandaloneFleetCard,
} from "./fleet-notices"

export function DeviceConsole() {
  const t = useTranslations("devices")
  const router = useRouter()
  const { rows, summary, loading, hostUnreachable, refresh } = useDeviceRows()
  const actions = useDeviceGrantActions(refresh)
  const { selectedRef, selected, select, missingDeepLink, dismissMissingDeepLink } =
    useDeviceSelection({ rows, loading })
  const sectionLink = useDeviceSectionLink()
  const { refreshing, run: runRefresh } = useRefreshing(refresh)

  const search = useDeviceConsoleStore((state) => state.search)
  const kindFilter = useDeviceConsoleStore((state) => state.kindFilter)
  const attentionOnly = useDeviceConsoleStore((state) => state.attentionOnly)
  const setSearch = useDeviceConsoleStore((state) => state.setSearch)
  const setKindFilter = useDeviceConsoleStore((state) => state.setKindFilter)
  const setAttentionOnly = useDeviceConsoleStore((state) => state.setAttentionOnly)
  const clearFilters = useDeviceConsoleStore((state) => state.clearFilters)

  const companionHost = rows.find(
    (row) => row.ref.startsWith("companion:") && row.runtime.isRoutingTarget
  )

  /**
   * Standalone: no host of our own and none paired. The same trichotomy
   * `useFleetSnapshot` picks its source by, asked through `hasHostRuntime`.
   */
  const standalone = !hasHostRuntime()
  const pairHref = devicePairHref()
  const addHost = useAddHostSheetState()

  const onPaired = useCallback(
    (host: RemoteHost) => {
      // `remoteHostRef` is the same identity `buildDeviceRows` assigns, so
      // this selects the row that was just created rather than a ref that
      // merely looks like one.
      select(remoteHostRef(host))
    },
    [select]
  )

  /** The badge is a way in, not just a count: it filters the rail to what it counted. */
  const showAttention = useCallback(() => {
    setKindFilter("all")
    setAttentionOnly(true)
  }, [setAttentionOnly, setKindFilter])

  // ADR-0215 phase 2: a new device waits for a sync approval (only in builds with account sync).
  const syncApprovalWaiting =
    useAccountSyncStore((state) => state.incoming.length > 0) && accountSyncEnabled()
  const notices =
    hostUnreachable || missingDeepLink || syncApprovalWaiting ? (
      <>
        {missingDeepLink ? (
          <MissingDeviceLinkNotice deviceRef={missingDeepLink} onDismiss={dismissMissingDeepLink} />
        ) : null}
        {hostUnreachable ? <HostUnreachableNotice /> : null}
        {syncApprovalWaiting ? <SyncApprovalFleetNotice /> : null}
      </>
    ) : null

  return (
    <FeaturePageShell
      storageId="devices"
      collapsibleLeftPane
      headerPlacement="center"
      header={
        <FeaturePageHeader
          variant="management"
          icon={<ServerIcon className="size-5" />}
          title={t("title")}
          description={t("description")}
          summary={t("summary", { online: summary.online, total: summary.total })}
          /* Where this window's calls land, on the page that is about
             machines. The desktop status bar carries the same control; this is
             the copy a browser or a phone can see. */
          context={
            companionHost ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2.5 text-xs font-normal"
                aria-label={t("executionHost.aria", { label: companionHost.label })}
                onClick={() => select(companionHost.ref)}
              >
                <ServerIcon className="size-3.5" />
                <span className="max-w-40 truncate">{companionHost.label}</span>
              </Button>
            ) : (
              <ExecutionHostChip onAddHost={() => addHost.setOpen(true)} />
            )
          }
          status={
            /**
             * The one number a fleet is actually scanned for, and now the way
             * to the rows behind it. A revoked phone or a host stuck in
             * `versionMismatch` used to be findable only by opening every row.
             */
            summary.needsAttention > 0 ? (
              <Button
                variant="outline"
                size="sm"
                className="h-6 gap-1.5 px-2 text-xs font-normal text-amber-600 dark:text-amber-400"
                onClick={showAttention}
                aria-pressed={attentionOnly}
                data-testid="devices-attention-count"
              >
                <span
                  aria-hidden="true"
                  className="inline-block size-1.5 rounded-full bg-current"
                />
                {t("attentionCount", { count: summary.needsAttention })}
              </Button>
            ) : null
          }
          primaryAction={{
            id: "pair",
            label: t("actions.pair"),
            icon: SmartphoneIcon,
            onSelect: () => router.push(pairHref),
          }}
          secondaryActions={[
            {
              id: "add-host",
              label: t("actions.addHost"),
              icon: ServerIcon,
              onSelect: () => addHost.setOpen(true),
            },
            /**
             * SSH targets are rows here like every other machine, but the only
             * way to add one was a Settings page nothing on this screen named.
             * It opens the SSH editor with a new host already started.
             */
            {
              id: "add-ssh-host",
              label: t("actions.addSshHost"),
              icon: WaypointsIcon,
              onSelect: () => router.push(newSshHostSettingsHref()),
              testId: "devices-add-ssh-host",
            },
            {
              id: "refresh",
              label: refreshing ? t("actions.refreshing") : t("actions.refresh"),
              icon: RefreshCwIcon,
              disabled: refreshing,
              onSelect: () =>
                void runRefresh().catch((error: unknown) =>
                  toast.error(t("actions.refreshFailed"), {
                    description: error instanceof Error ? error.message : String(error),
                  })
                ),
              testId: "devices-refresh",
            },
          ]}
          testId="devices-header"
        />
      }
      leftPane={{
        content: (
          <DeviceListPane
            rows={rows}
            selectedRef={selectedRef}
            search={search}
            kindFilter={kindFilter}
            attentionOnly={attentionOnly}
            onSearchChange={setSearch}
            onKindFilterChange={setKindFilter}
            onAttentionOnlyChange={setAttentionOnly}
            onClearFilters={clearFilters}
            onSelect={select}
            notices={notices}
            footer={
              standalone ? (
                <StandaloneFleetCard onAddHost={() => addHost.setOpen(true)} pairHref={pairHref} />
              ) : null
            }
          />
        ),
        label: t("listPane.label"),
        defaultSize: "15rem",
        minSize: "15rem",
        maxSize: 40,
      }}
      centerClassName="min-h-0"
    >
      <div className="h-full min-h-0">
        <DeviceDetail
          row={selected}
          actions={actions}
          onRepairHost={() => addHost.setOpen(true)}
          initialSection={
            selected && selected.ref === sectionLink.deviceRef ? sectionLink.section : null
          }
          onInitialSectionApplied={sectionLink.consume}
        />
      </div>

      <AddHostSheet
        open={addHost.open}
        onOpenChange={addHost.setOpen}
        initialBaseUrl={addHost.seededBaseUrl}
        onPaired={onPaired}
      />
    </FeaturePageShell>
  )
}
