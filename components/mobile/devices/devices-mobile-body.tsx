"use client"

/**
 * `/devices` on a phone.
 *
 * `FeaturePageShell` does have a mobile branch, but it collapses the left pane
 * into a Sheet trigger. For a fleet console that is backwards: the list is not
 * a sidebar here, it is the page, and the detail is what should arrive on
 * demand. So this inverts the two and reuses both halves verbatim.
 *
 * Nothing about a device is re-modelled. `DeviceListPane` is the same
 * component the desktop rail renders, `DeviceDetail` is the same dashboard,
 * `useDeviceSelection` is the same selection, and both read the same
 * `useDeviceRows` projection, so a row can never say one thing here and
 * another on the desktop.
 *
 * Gaps this used to have against the desktop, each now closed by sharing the
 * desktop's piece rather than writing a second one:
 *
 *  * `?device=` was never read, so a ⌘K hit or a Settings link opened a list.
 *    A link now selects the device and opens its drawer.
 *  * The standalone explanation, the "local record" notice and the attention
 *    count were desktop-only. They are rail content now, so they are here.
 *  * "Pair a device" disappeared once there was a second device. Growing the
 *    fleet is one menu now, always in the header, and it carries every way
 *    the desktop offers: pairing, a host, and an SSH host.
 *  * The sync-approval notice (ADR-0215) was desktop-only. It is a fleet
 *    notice like the others, so it is in the rail here too.
 *
 * The detail is a full-screen page pushed over the list, not a drawer. A
 * device record runs to a masthead, a jump strip and up to eleven sections;
 * a bottom drawer capped at 72vh showed a third of that through a letterbox,
 * with the drag handle competing with the record's own scroll. As a pushed
 * page it gets the whole screen and its own scroller, the list stays mounted
 * underneath (so its scroll position, search and filters survive the round
 * trip), and the system back gesture closes it: `useBackDismiss` gives the
 * page a history entry of its own, so Android's back button and the browser's
 * both return to the list instead of leaving `/devices`.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  ArrowLeftIcon,
  PlusIcon,
  QrCodeIcon,
  RefreshCwIcon,
  ServerIcon,
  WaypointsIcon,
} from "lucide-react"

import { AddHostSheet } from "@/components/devices/add-host-sheet"
import { DeviceDetail } from "@/components/devices/device-detail"
import { DeviceListPane } from "@/components/devices/device-list-pane"
import { ExecutionHostChip } from "@/components/devices/execution-host-switcher"
import {
  HostUnreachableNotice,
  MissingDeviceLinkNotice,
  StandaloneFleetCard,
} from "@/components/devices/fleet-notices"
import { SyncApprovalFleetNotice } from "@/components/account/sync/sync-approval-fleet-notice"
import { PullToRefresh } from "@/components/interactions/pull-to-refresh"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MobileBackButton } from "@/components/mobile/shell/mobile-back-button"
import { useDeviceGrantActions } from "@/hooks/devices/use-device-grant-actions"
import { useDeviceRows } from "@/hooks/devices/use-device-rows"
import { useAddHostSheetState } from "@/hooks/devices/use-add-host-sheet-state"
import { useDeviceSelection } from "@/hooks/devices/use-device-selection"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"
import { useRefreshing } from "@/hooks/ui/use-refreshing"
import { accountSyncEnabled } from "@/lib/account-sync/feature-flag"
import { remoteHostRef } from "@/lib/devices/build-device-rows"
import { devicePairHref } from "@/lib/devices/pair-entry"
import { hasHostRuntime } from "@/lib/platform/capabilities"
import { newSshHostSettingsHref } from "@/lib/terminal/terminal-settings-link"
import { cn } from "@/lib/utils"
import { useAccountSyncStore } from "@/stores/account-sync/account-sync-store"
import { useDeviceConsoleStore } from "@/stores/devices/device-console-store"
import type { RemoteHost } from "@/stores/remote-host/remote-host-store"

export function DevicesMobileBody() {
  const t = useTranslations("devices")
  const router = useRouter()
  const { rows, summary, loading, hostUnreachable, refresh } = useDeviceRows()
  const actions = useDeviceGrantActions(refresh)
  const { refreshing, run: runRefresh } = useRefreshing(refresh)

  /**
   * The detail page is opened by a tap or a deep link, not by the store's
   * selection. Selection survives navigation (it is what the console reopens
   * on), so deriving "open" from it would push the page every time the user
   * came back to this screen.
   */
  const [detailOpen, setDetailOpen] = useState(false)
  const openDrawer = useCallback(() => setDetailOpen(true), [])
  const { selectedRef, selected, select, missingDeepLink, dismissMissingDeepLink } =
    useDeviceSelection({ rows, loading, onDeepLink: openDrawer })

  const search = useDeviceConsoleStore((state) => state.search)
  const kindFilter = useDeviceConsoleStore((state) => state.kindFilter)
  const attentionOnly = useDeviceConsoleStore((state) => state.attentionOnly)
  const setSearch = useDeviceConsoleStore((state) => state.setSearch)
  const setKindFilter = useDeviceConsoleStore((state) => state.setKindFilter)
  const setAttentionOnly = useDeviceConsoleStore((state) => state.setAttentionOnly)
  const clearFilters = useDeviceConsoleStore((state) => state.clearFilters)

  const addHost = useAddHostSheetState()
  const pairHref = devicePairHref()
  const standalone = !hasHostRuntime()

  const showingDetail = detailOpen && Boolean(selected)
  const closeDetail = useCallback(() => setDetailOpen(false), [])
  // The pushed page owns a history entry, so the hardware back button and the
  // browser's pop it rather than leaving the console.
  useBackDismiss(showingDetail, closeDetail)

  // ADR-0215 phase 2: a new device waits for a sync approval (only in builds with account sync).
  const syncApprovalWaiting =
    useAccountSyncStore((state) => state.incoming.length > 0) && accountSyncEnabled()

  const onSelect = useCallback(
    (ref: string) => {
      select(ref)
      setDetailOpen(true)
    },
    [select]
  )

  const onPaired = useCallback(
    (host: RemoteHost) => {
      select(remoteHostRef(host))
      setDetailOpen(true)
    },
    [select]
  )

  return (
    <div className="relative flex h-full min-h-0 flex-col" data-testid="devices-mobile-body">
      {/*
        The list stays mounted under the pushed page rather than unmounting:
        returning to it keeps its scroll position, search and filters, the way
        a native navigation stack does. `inert` while covered, so a screen
        reader and the keyboard cannot reach rows that are not on screen.
      */}
      <div
        className={cn("flex min-h-0 flex-1 flex-col", showingDetail && "invisible")}
        inert={showingDetail}
        data-testid="mobile-devices-list-screen"
      >
        <header className="safe-area-pt flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <MobileBackButton />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{t("title")}</h1>
            <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span className="truncate">
                {t("summary", { online: summary.online, total: summary.total })}
              </span>
              {summary.needsAttention > 0 ? (
                // The count is a way to the rows it counted, as on the desktop.
                <button
                  type="button"
                  className={cn(
                    "shrink-0 rounded-sm text-amber-600 underline-offset-2 hover:underline dark:text-amber-400",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  )}
                  aria-pressed={attentionOnly}
                  onClick={() => {
                    setKindFilter("all")
                    setAttentionOnly(true)
                  }}
                  data-testid="mobile-devices-attention-count"
                >
                  {t("attentionCount", { count: summary.needsAttention })}
                </button>
              ) : null}
            </p>
          </div>
          {/* Which machine this phone's calls land on, stated on the one screen
              that is about machines. */}
          <ExecutionHostChip />
          <Button
            size="icon"
            variant="ghost"
            className="size-9"
            aria-label={refreshing ? t("actions.refreshing") : t("actions.refresh")}
            disabled={refreshing}
            onClick={() =>
              void runRefresh().catch((error: unknown) =>
                toast.error(t("actions.refreshFailed"), {
                  description: error instanceof Error ? error.message : String(error),
                })
              )
            }
            data-testid="mobile-devices-refresh"
          >
            <RefreshCwIcon className={cn("size-4", refreshing && "motion-safe:animate-spin")} />
          </Button>
          {/*
            Every way to grow the fleet behind one control, the same three the
            desktop header offers. Pairing is a route (`/pair` owns the camera
            and the one-shot invitation), adding a host is the sheet below, and
            an SSH host is the SSH editor with a new host already started.
          */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="outline"
                className="size-9"
                aria-label={t("actions.grow")}
                data-testid="mobile-devices-add"
              >
                <PlusIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => router.push(pairHref)}
                data-testid="mobile-devices-pair"
              >
                <QrCodeIcon className="size-4" />
                {t("actions.pair")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => addHost.setOpen(true)}
                data-testid="mobile-devices-add-host"
              >
                <ServerIcon className="size-4" />
                {t("actions.addHost")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => router.push(newSshHostSettingsHref())}
                data-testid="mobile-devices-add-ssh-host"
              >
                <WaypointsIcon className="size-4" />
                {t("actions.addSshHost")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <PullToRefresh onRefresh={refresh} className="min-h-0 flex-1">
          <DeviceListPane
            rows={rows}
            loading={loading}
            selectedRef={selectedRef}
            search={search}
            kindFilter={kindFilter}
            attentionOnly={attentionOnly}
            onSearchChange={setSearch}
            onKindFilterChange={setKindFilter}
            onAttentionOnlyChange={setAttentionOnly}
            onClearFilters={clearFilters}
            onSelect={onSelect}
            notices={
              hostUnreachable || missingDeepLink || syncApprovalWaiting ? (
                <>
                  {missingDeepLink ? (
                    <MissingDeviceLinkNotice
                      deviceRef={missingDeepLink}
                      onDismiss={dismissMissingDeepLink}
                    />
                  ) : null}
                  {hostUnreachable ? <HostUnreachableNotice /> : null}
                  {syncApprovalWaiting ? <SyncApprovalFleetNotice /> : null}
                </>
              ) : null
            }
            footer={
              standalone ? (
                <StandaloneFleetCard onAddHost={() => addHost.setOpen(true)} pairHref={pairHref} />
              ) : null
            }
          />
        </PullToRefresh>
      </div>

      {showingDetail ? (
        <section
          // Over the list, not instead of it: see the list's comment.
          className="absolute inset-0 z-10 flex min-h-0 flex-col bg-background motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-8 motion-safe:duration-200"
          aria-label={t("detail.drawerTitle")}
          data-testid="mobile-device-detail-page"
        >
          <header className="safe-area-pt flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
            <Button
              size="icon"
              variant="ghost"
              className="size-9"
              aria-label={t("detail.backToList")}
              onClick={closeDetail}
              data-testid="mobile-device-detail-back"
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
            {/* Not the device's name: the masthead directly under it already
                says that, and the same label twice was the first thing the
                page read. The title says where back goes. */}
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">
              {t("title")}
            </h1>
          </header>
          {/* `DeviceDetail` is `h-full` with its own scroller, so this box is
              the definite height it resolves against. The bottom inset keeps
              the last section clear of the home indicator. */}
          <div className="safe-area-pb min-h-0 flex-1">
            <DeviceDetail
              row={selected}
              actions={actions}
              onRepairHost={() => {
                setDetailOpen(false)
                addHost.setOpen(true)
              }}
            />
          </div>
        </section>
      ) : null}

      <AddHostSheet
        open={addHost.open}
        onOpenChange={addHost.setOpen}
        initialBaseUrl={addHost.seededBaseUrl}
        onPaired={onPaired}
      />
    </div>
  )
}
